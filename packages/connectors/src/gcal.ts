import type { FetchFn } from "./oauth";

const API = "https://www.googleapis.com/calendar/v3/calendars";

export interface CalEvent {
  remoteId: string;
  title: string;
  description: string;
  location: string;
  /** Epoch ms ; pour un événement "toute la journée", minuit local du jour de début. */
  start: number;
  /** Epoch ms, fin exclusive. */
  end: number;
  allDay: boolean;
  cancelled: boolean;
  link: string;
}

export interface EventWrite {
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  location?: string;
  description?: string;
}

export class SyncTokenExpiredError extends Error {
  constructor() {
    super("Jeton de synchronisation du calendrier expiré");
  }
}

export class CalendarApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** "2026-03-15" → minuit local */
function localMidnight(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y!, m! - 1, d!).getTime();
}

export function parseEvent(e: any): CalEvent | null {
  if (!e?.id) return null;
  const cancelled = e.status === "cancelled";
  const allDay = !!e.start?.date;
  let start = 0;
  let end = 0;
  if (!cancelled) {
    start = allDay ? localMidnight(e.start.date) : Date.parse(e.start?.dateTime);
    end = allDay ? localMidnight(e.end?.date ?? e.start.date) : Date.parse(e.end?.dateTime ?? e.start?.dateTime);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (end <= start) end = allDay ? start + 86_400_000 : start;
  }
  return {
    remoteId: e.id,
    title: String(e.summary ?? "(sans titre)").slice(0, 500),
    description: String(e.description ?? "").slice(0, 5000),
    location: String(e.location ?? "").slice(0, 500),
    start,
    end,
    allDay,
    cancelled,
    link: String(e.htmlLink ?? ""),
  };
}

export interface CalendarOptions {
  getAccessToken: () => Promise<string>;
  refreshAccessToken?: () => Promise<string>;
  fetch?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
}

export class CalendarClient {
  private f: FetchFn;
  private sleep: (ms: number) => Promise<void>;

  constructor(private o: CalendarOptions) {
    this.f = o.fetch ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async get(url: string, init?: { method?: string; body?: unknown }): Promise<any> {
    let token = await this.o.getAccessToken();
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const res = await this.f(url, {
        method: init?.method ?? "GET",
        headers: { authorization: `Bearer ${token}`, ...(init?.body !== undefined && { "content-type": "application/json" }) },
        ...(init?.body !== undefined && { body: JSON.stringify(init.body) }),
      });
      if (res.ok) return res.status === 204 ? null : res.json();
      if (res.status === 401 && !refreshed && this.o.refreshAccessToken) {
        token = await this.o.refreshAccessToken();
        refreshed = true;
        continue;
      }
      if (res.status === 410) throw new SyncTokenExpiredError();
      if ((res.status === 429 || res.status === 403 || res.status >= 500) && attempt < 3) {
        // 403 rateLimitExceeded/userRateLimitExceeded : Google demande un nouvel essai avec délai.
        const body = res.status === 403 ? await res.clone().text() : "";
        if (res.status !== 403 || /rateLimitExceeded/i.test(body)) {
          const ra = Number(res.headers.get("retry-after"));
          await this.sleep(Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** attempt, 30_000));
          continue;
        }
      }
      throw new CalendarApiError(`Calendar ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status);
    }
  }

  // --- écriture (permission calendar.events) ---

  /** Corps d'événement Google : « toute la journée » en dates locales (fin exclusive), sinon date-heure ISO. */
  private body(e: EventWrite) {
    const day = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
    return {
      summary: e.title, description: e.description ?? "", location: e.location ?? "",
      start: e.allDay ? { date: day(e.start) } : { dateTime: new Date(e.start).toISOString() },
      end: e.allDay ? { date: day(Math.max(e.end, e.start + 86_400_000)) } : { dateTime: new Date(Math.max(e.end, e.start)).toISOString() },
    };
  }

  async createEvent(calendarId: string, e: EventWrite): Promise<string> {
    const r = await this.get(`${API}/${encodeURIComponent(calendarId)}/events`, { method: "POST", body: this.body(e) });
    return String(r.id);
  }

  async updateEvent(calendarId: string, remoteId: string, e: EventWrite): Promise<void> {
    await this.get(`${API}/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(remoteId)}`, { method: "PATCH", body: this.body(e) });
  }

  async deleteEvent(calendarId: string, remoteId: string): Promise<void> {
    try {
      await this.get(`${API}/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(remoteId)}`, { method: "DELETE" });
    } catch (err) {
      if (!(err instanceof CalendarApiError && (err.status === 404 || err.status === 410))) throw err; // déjà supprimé
    }
  }

  /**
   * Synchro des événements (occurrences de récurrences développées).
   * Sans `syncToken` : fenêtre [timeMin, timeMax]. Avec : uniquement les changements (la fenêtre d'origine est conservée côté Google).
   */
  async sync(
    calendarId: string,
    q: { timeMin?: string; timeMax?: string; syncToken?: string },
  ): Promise<{ events: CalEvent[]; syncToken: string }> {
    const events: CalEvent[] = [];
    let pageToken = "";
    for (;;) {
      const qs = new URLSearchParams({ singleEvents: "true", showDeleted: "true", maxResults: "250" });
      if (q.syncToken) qs.set("syncToken", q.syncToken);
      else {
        if (q.timeMin) qs.set("timeMin", q.timeMin);
        if (q.timeMax) qs.set("timeMax", q.timeMax);
      }
      if (pageToken) qs.set("pageToken", pageToken);
      const r = await this.get(`${API}/${encodeURIComponent(calendarId)}/events?${qs}`);
      for (const raw of r.items ?? []) {
        const ev = parseEvent(raw);
        if (ev) events.push(ev);
      }
      if (r.nextPageToken) pageToken = r.nextPageToken;
      else return { events, syncToken: String(r.nextSyncToken ?? "") };
    }
  }
}
