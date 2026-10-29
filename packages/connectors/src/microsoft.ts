import { htmlToText } from "./html";
import type { MailAttachment, MailMessage } from "./gmail";
import type { OAuthEndpoints, FetchFn } from "./oauth";
import type { CalEvent, EventWrite } from "./gcal";

const GRAPH = "https://graph.microsoft.com/v1.0";

export const MS_SCOPES = {
  base: ["offline_access", "User.Read"],
  mail: ["Mail.Read"],
  send: ["Mail.Send"],
  calendar: ["Calendars.Read"],
  calendarWrite: ["Calendars.ReadWrite"],
} as const;

export function microsoftEndpoints(tenant = "common"): OAuthEndpoints {
  const t = /^[\w.-]+$/.test(tenant) ? tenant : "common";
  return {
    authUrl: `https://login.microsoftonline.com/${t}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${t}/oauth2/v2.0/token`,
  };
}

export class GraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Une page de résultats « delta » : éléments, et soit la page suivante, soit le jeton delta final. */
export interface DeltaResult<T> {
  items: T[];
  deltaLink: string;
}

export interface GraphOptions {
  getAccessToken: () => Promise<string>;
  refreshAccessToken?: () => Promise<string>;
  fetch?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
}

const addr = (a: any) => String(a?.emailAddress?.address ?? "").toLowerCase();

export function parseGraphMessage(m: any, folder: "inbox" | "sentitems", attachments: MailAttachment[] = []): MailMessage {
  const body = m.body?.contentType === "html" ? htmlToText(String(m.body?.content ?? "")) : String(m.body?.content ?? "");
  const from = m.from?.emailAddress ?? {};
  return {
    id: String(m.id),
    threadId: String(m.conversationId ?? m.id),
    subject: String(m.subject || "(sans objet)"),
    fromName: String(from.name && from.name !== from.address ? from.name : ""),
    fromAddr: String(from.address ?? "").toLowerCase(),
    to: (m.toRecipients ?? []).map(addr).filter(Boolean).join(", "),
    date: Date.parse(m.receivedDateTime ?? m.sentDateTime ?? "") || 0,
    snippet: String(m.bodyPreview ?? "").slice(0, 200),
    bodyText: body.slice(0, 200_000),
    labels: [folder === "sentitems" ? "SENT" : "INBOX"],
    attachments,
    messageId: m.internetMessageId ? String(m.internetMessageId) : undefined,
  };
}

/** « 2026-03-17T00:00:00.0000000 » (UTC) → minuit local du même jour (événement « toute la journée »). */
function localMidnightOf(dt: string): number {
  const [y, mo, d] = dt.slice(0, 10).split("-").map(Number);
  return new Date(y!, mo! - 1, d!).getTime();
}

export function parseGraphEvent(e: any): CalEvent | null {
  if (!e?.id) return null;
  if (e["@removed"] || e.isCancelled) return { remoteId: String(e.id), title: "", description: "", location: "", start: 0, end: 0, allDay: false, cancelled: true, link: "" };
  const allDay = !!e.isAllDay;
  const utc = (s: any) => Date.parse(`${String(s?.dateTime ?? "").replace(/(\.\d+)?$/, "")}Z`);
  const start = allDay ? localMidnightOf(String(e.start?.dateTime ?? "")) : utc(e.start);
  let end = allDay ? localMidnightOf(String(e.end?.dateTime ?? e.start?.dateTime ?? "")) : utc(e.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (end <= start) end = allDay ? start + 86_400_000 : start;
  return {
    remoteId: String(e.id), title: String(e.subject || "(sans titre)").slice(0, 500),
    description: String(e.bodyPreview ?? "").slice(0, 5000), location: String(e.location?.displayName ?? "").slice(0, 500),
    start, end, allDay, cancelled: false, link: String(e.webLink ?? ""),
  };
}

export class GraphClient {
  private f: FetchFn;
  private sleep: (ms: number) => Promise<void>;

  constructor(private o: GraphOptions) {
    this.f = o.fetch ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Requête avec renouvellement du jeton sur 401 et reprises sur 429/5xx (Retry-After respecté). */
  private async req(url: string, init: { method?: string; body?: unknown; prefer?: string; raw?: boolean } = {}): Promise<any> {
    const full = url.startsWith("http") ? url : `${GRAPH}${url}`;
    if (!full.startsWith(`${GRAPH}/`)) throw new GraphError("URL Graph inattendue", 400); // les liens delta ne doivent mener qu'à Graph
    let token = await this.o.getAccessToken();
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const res = await this.f(full, {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body !== undefined && { "content-type": "application/json" }),
          ...(init.prefer && { prefer: init.prefer }),
        },
        ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
      });
      if (res.ok) return init.raw ? Buffer.from(await res.arrayBuffer()) : res.status === 204 || res.status === 202 ? null : res.json();
      if (res.status === 401 && !refreshed && this.o.refreshAccessToken) {
        token = await this.o.refreshAccessToken();
        refreshed = true;
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        const ra = Number(res.headers.get("retry-after"));
        await this.sleep(Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** attempt, 30_000));
        continue;
      }
      throw new GraphError(`Graph ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status);
    }
  }

  async me(): Promise<{ email: string }> {
    const r = await this.req("/me?$select=mail,userPrincipalName");
    const email = String(r.mail ?? r.userPrincipalName ?? "").toLowerCase();
    if (!email.includes("@")) throw new GraphError("Adresse du compte introuvable", 400);
    return { email };
  }

  /** Parcourt un flux delta jusqu'au jeton final. Un jeton expiré (410) lève GraphError(410). */
  private async delta(start: string, prefer?: string): Promise<DeltaResult<any>> {
    const items: any[] = [];
    let url: string | null = start;
    while (url) {
      const r: any = await this.req(url, { prefer });
      items.push(...(r.value ?? []));
      if (r["@odata.deltaLink"]) return { items, deltaLink: String(r["@odata.deltaLink"]) };
      url = r["@odata.nextLink"] ? String(r["@odata.nextLink"]) : null;
    }
    throw new GraphError("Flux delta sans jeton final", 500);
  }

  /** Mails d'un dossier (texte brut demandé) : état initial depuis `sinceIso`, puis uniquement les changements. */
  async mailDelta(folder: "inbox" | "sentitems", deltaLink: string | null, sinceIso: string): Promise<DeltaResult<any>> {
    const select = "id,subject,from,toRecipients,receivedDateTime,sentDateTime,bodyPreview,body,hasAttachments,conversationId,internetMessageId";
    const start = deltaLink ?? `/me/mailFolders/${folder}/messages/delta?$select=${select}&$filter=${encodeURIComponent(`receivedDateTime ge ${sinceIso}`)}`;
    return this.delta(start, 'odata.maxpagesize=50, outlook.body-content-type="text"');
  }

  async listAttachments(messageId: string): Promise<MailAttachment[]> {
    const r = await this.req(`/me/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,size,isInline`);
    return (r.value ?? [])
      .filter((a: any) => a["@odata.type"] === "#microsoft.graph.fileAttachment" || a["@odata.type"] === undefined)
      .map((a: any) => ({ name: String(a.name ?? "pièce jointe"), mime: String(a.contentType ?? "application/octet-stream"), size: Number(a.size) || 0, attachmentId: String(a.id) }));
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
    return this.req(`/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/$value`, { raw: true });
  }

  /** Envoi (permission Mail.Send) ; une réponse passe par /reply pour conserver le fil de discussion. */
  async sendMail(p: { to: string[]; cc?: string[]; subject: string; text: string; replyToRemoteId?: string }): Promise<void> {
    if (p.replyToRemoteId) {
      await this.req(`/me/messages/${encodeURIComponent(p.replyToRemoteId)}/reply`, { method: "POST", body: { comment: p.text } });
      return;
    }
    const rec = (l: string[] = []) => l.map((a) => ({ emailAddress: { address: a } }));
    await this.req("/me/sendMail", { method: "POST", body: { message: { subject: p.subject, body: { contentType: "Text", content: p.text }, toRecipients: rec(p.to), ccRecipients: rec(p.cc) }, saveToSentItems: true } });
  }

  // --- calendrier ---

  /** Occurrences développées dans la fenêtre ; heures demandées en UTC. */
  async calendarDelta(deltaLink: string | null, from: string, to: string): Promise<DeltaResult<any>> {
    const select = "id,subject,start,end,isAllDay,location,bodyPreview,webLink,isCancelled";
    const start = deltaLink ?? `/me/calendarView/delta?startDateTime=${encodeURIComponent(from)}&endDateTime=${encodeURIComponent(to)}&$select=${select}`;
    return this.delta(start, 'odata.maxpagesize=100, outlook.timezone="UTC"');
  }

  private eventBody(e: EventWrite) {
    const day = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T00:00:00`; };
    const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, "");
    return {
      subject: e.title, isAllDay: e.allDay, location: { displayName: e.location ?? "" },
      body: { contentType: "text", content: e.description ?? "" },
      start: { dateTime: e.allDay ? day(e.start) : iso(e.start), timeZone: "UTC" },
      end: { dateTime: e.allDay ? day(Math.max(e.end, e.start + 86_400_000)) : iso(Math.max(e.end, e.start)), timeZone: "UTC" },
    };
  }

  async createEvent(e: EventWrite): Promise<string> {
    return String((await this.req("/me/events", { method: "POST", body: this.eventBody(e) })).id);
  }

  async updateEvent(id: string, e: EventWrite): Promise<void> {
    await this.req(`/me/events/${encodeURIComponent(id)}`, { method: "PATCH", body: this.eventBody(e) });
  }

  async deleteEvent(id: string): Promise<void> {
    try { await this.req(`/me/events/${encodeURIComponent(id)}`, { method: "DELETE" }); }
    catch (e) { if (!(e instanceof GraphError && e.status === 404)) throw e; }
  }
}
