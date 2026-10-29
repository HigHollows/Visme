import { randomUUID } from "node:crypto";
import ICAL from "ical.js";
import { createDAVClient } from "tsdav";
import type { CalEvent, EventWrite } from "./gcal";

export interface CalDavConfig {
  /** URL du serveur CalDAV (https obligatoire hors machine locale). */
  url: string;
  user: string;
  pass: string;
  /** Nom ou URL du calendrier à utiliser ; par défaut le premier calendrier d'événements. */
  calendar?: string;
}

export interface DavObject {
  url: string;
  etag?: string;
  data: string;
}

/** Surface minimale d'un client CalDAV (permet de simuler un serveur dans les tests). */
export interface DavLike {
  ctag(): Promise<string | null>;
  fetchObjects(range: { start: string; end: string }): Promise<DavObject[]>;
  get(url: string): Promise<DavObject | null>;
  create(filename: string, ics: string): Promise<string>;
  update(obj: DavObject): Promise<void>;
  remove(obj: { url: string; etag?: string }): Promise<void>;
}

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/;

export async function createRealDav(cfg: CalDavConfig): Promise<DavLike> {
  const u = new URL(cfg.url);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOCAL.test(u.hostname))) throw new Error("L'URL CalDAV doit être en HTTPS");
  const client = await createDAVClient({
    serverUrl: cfg.url, credentials: { username: cfg.user, password: cfg.pass }, authMethod: "Basic", defaultAccountType: "caldav",
  });
  const pick = async () => {
    const cals = await client.fetchCalendars();
    const events = cals.filter((c) => !c.components || c.components.includes("VEVENT"));
    const cal = (cfg.calendar && events.find((c) => c.url === cfg.calendar || String(c.displayName) === cfg.calendar)) || events[0];
    if (!cal) throw new Error("Aucun calendrier d'événements trouvé sur ce serveur");
    return cal;
  };
  const cal = await pick();
  return {
    async ctag() {
      const fresh = (await client.fetchCalendars()).find((c) => c.url === cal.url);
      return fresh?.ctag ? String(fresh.ctag) : null;
    },
    async fetchObjects(range) {
      const objs = await client.fetchCalendarObjects({ calendar: cal, timeRange: range, expand: false });
      return objs.filter((o) => typeof o.data === "string").map((o) => ({ url: o.url, etag: o.etag, data: String(o.data) }));
    },
    async get(url) {
      const o = (await client.fetchCalendarObjects({ calendar: cal, objectUrls: [url] }))[0];
      return o && typeof o.data === "string" ? { url: o.url, etag: o.etag, data: String(o.data) } : null;
    },
    async create(filename, ics) {
      const r = await client.createCalendarObject({ calendar: cal, filename, iCalString: ics });
      if (!r.ok) throw new Error(`CalDAV ${r.status} à la création`);
      return new URL(filename, cal.url.endsWith("/") ? cal.url : cal.url + "/").toString();
    },
    async update(o) {
      const r = await client.updateCalendarObject({ calendarObject: { url: o.url, etag: o.etag, data: o.data } });
      if (!r.ok) throw new Error(`CalDAV ${r.status} à la mise à jour`);
    },
    async remove(o) {
      const r = await client.deleteCalendarObject({ calendarObject: { url: o.url, etag: o.etag, data: "" } });
      if (!r.ok && r.status !== 404) throw new Error(`CalDAV ${r.status} à la suppression`);
    },
  };
}

const MAX_OCCURRENCES = 400;

function registerTimezones(root: any) {
  for (const tz of root.getAllSubcomponents("vtimezone")) {
    const id = tz.getFirstPropertyValue("tzid");
    if (id && !ICAL.TimezoneService.has(id)) ICAL.TimezoneService.register(tz);
  }
}

/** Événements d'un fichier ICS qui chevauchent [from, to), récurrences développées. */
export function parseIcs(data: string, objectUrl: string, from: number, to: number): CalEvent[] {
  let root: any;
  try { root = new ICAL.Component(ICAL.parse(data)); } catch { return []; }
  registerTimezones(root);

  const byUid = new Map<string, { master?: any; exceptions: any[] }>();
  for (const v of root.getAllSubcomponents("vevent")) {
    const uid = String(v.getFirstPropertyValue("uid") ?? objectUrl);
    const g = byUid.get(uid) ?? { exceptions: [] };
    if (v.hasProperty("recurrence-id")) g.exceptions.push(v); else g.master = v;
    byUid.set(uid, g);
  }

  const out: CalEvent[] = [];
  const push = (ev: any, start: any, end: any, key: string) => {
    if (String(ev.component.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED") return;
    const allDay = !!start.isDate;
    const s = allDay ? new Date(start.year, start.month - 1, start.day).getTime() : start.toJSDate().getTime();
    let e = allDay ? new Date(end.year, end.month - 1, end.day).getTime() : end.toJSDate().getTime();
    if (e <= s) e = allDay ? s + 86_400_000 : s;
    if (s >= to || (e <= from && !(e === s && s >= from))) return;
    out.push({
      remoteId: key, title: String(ev.summary || "(sans titre)").slice(0, 500), description: String(ev.description ?? "").slice(0, 5000),
      location: String(ev.location ?? "").slice(0, 500), start: s, end: e, allDay, cancelled: false, link: "",
    });
  };

  for (const { master, exceptions } of byUid.values()) {
    const base = master ?? exceptions[0];
    if (!base) continue;
    const ev = new ICAL.Event(base);
    if (!master || !ev.isRecurring()) {
      // Événement simple (ou exception orpheline) : un seul passage.
      if (ev.startDate) push(ev, ev.startDate, ev.endDate ?? ev.startDate, objectUrl);
      for (const x of master ? exceptions : []) { const xe = new ICAL.Event(x); if (xe.startDate) push(xe, xe.startDate, xe.endDate ?? xe.startDate, `${objectUrl}#${xe.recurrenceId?.toString()}`); }
      continue;
    }
    for (const x of exceptions) ev.relateException(new ICAL.Event(x));
    const it = ev.iterator();
    let next: any;
    let n = 0;
    while ((next = it.next()) && n++ < MAX_OCCURRENCES) {
      if (next.toJSDate().getTime() >= to) break;
      const d = ev.getOccurrenceDetails(next);
      push(d.item, d.startDate, d.endDate, `${objectUrl}#${d.recurrenceId.toString()}`);
    }
  }
  return out;
}

/** Un fichier ICS à une seule occurrence modifiable ? (les séries récurrentes se modifient dans l'application d'agenda) */
export function isRecurringIcs(data: string): boolean {
  try { return new ICAL.Component(ICAL.parse(data)).getAllSubcomponents("vevent").some((v: any) => v.hasProperty("rrule") || v.hasProperty("recurrence-id")); } catch { return false; }
}

function setTimes(vevent: any, e: EventWrite) {
  const pad = (n: number) => String(n).padStart(2, "0");
  if (e.allDay) {
    const d = (t: number) => { const x = new Date(t); return ICAL.Time.fromData({ year: x.getFullYear(), month: x.getMonth() + 1, day: x.getDate(), isDate: true }); };
    vevent.updatePropertyWithValue("dtstart", d(e.start));
    vevent.updatePropertyWithValue("dtend", d(Math.max(e.end, e.start + 86_400_000)));
  } else {
    const t = (ms: number) => { const x = new Date(ms); return ICAL.Time.fromData({ year: x.getUTCFullYear(), month: x.getUTCMonth() + 1, day: x.getUTCDate(), hour: x.getUTCHours(), minute: x.getUTCMinutes(), second: x.getUTCSeconds() }, ICAL.Timezone.utcTimezone); };
    vevent.updatePropertyWithValue("dtstart", t(e.start));
    vevent.updatePropertyWithValue("dtend", t(Math.max(e.end, e.start)));
  }
  void pad;
}

function setText(vevent: any, name: string, value: string | undefined) {
  if (value) vevent.updatePropertyWithValue(name, value); else vevent.removeProperty(name);
}

export function buildIcs(e: EventWrite, uid = randomUUID()): { ics: string; uid: string } {
  const cal = new ICAL.Component(["vcalendar", [], []]);
  cal.updatePropertyWithValue("prodid", "-//ASSISTANT//FR");
  cal.updatePropertyWithValue("version", "2.0");
  const v = new ICAL.Component("vevent");
  v.updatePropertyWithValue("uid", uid);
  v.updatePropertyWithValue("dtstamp", ICAL.Time.now());
  v.updatePropertyWithValue("summary", e.title);
  setText(v, "location", e.location);
  setText(v, "description", e.description);
  setTimes(v, e);
  cal.addSubcomponent(v);
  return { ics: cal.toString(), uid };
}

/** Met à jour la première VEVENT d'un ICS existant (événement non récurrent). */
export function updateIcs(data: string, e: EventWrite): string {
  if (isRecurringIcs(data)) throw new Error("Événement récurrent : modifiez-le dans votre application d'agenda.");
  const root = new ICAL.Component(ICAL.parse(data));
  const v = root.getFirstSubcomponent("vevent");
  if (!v) throw new Error("Événement CalDAV illisible");
  v.updatePropertyWithValue("summary", e.title);
  setText(v, "location", e.location);
  setText(v, "description", e.description);
  v.removeProperty("duration");
  setTimes(v, e);
  v.updatePropertyWithValue("last-modified", ICAL.Time.now());
  return root.toString();
}
