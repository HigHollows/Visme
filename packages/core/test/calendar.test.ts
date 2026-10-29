import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseEvent } from "@assistant/connectors";
import { createApp } from "../src";

const CID = "123-abc.apps.googleusercontent.com";
const H = 3600_000;
const day = (y: number, m: number, d: number, h = 0) => new Date(y, m - 1, d, h).getTime();

describe("parseEvent", () => {
  it("événement horodaté, journée entière (fin exclusive) et annulé", () => {
    expect(parseEvent({ id: "a", summary: "RDV", start: { dateTime: "2026-03-15T10:00:00+01:00" }, end: { dateTime: "2026-03-15T11:00:00+01:00" } })).toMatchObject({
      title: "RDV", start: Date.parse("2026-03-15T10:00:00+01:00"), end: Date.parse("2026-03-15T11:00:00+01:00"), allDay: false,
    });
    const allDay = parseEvent({ id: "b", start: { date: "2026-03-15" }, end: { date: "2026-03-16" } })!;
    expect(allDay).toMatchObject({ allDay: true, title: "(sans titre)", start: day(2026, 3, 15), end: day(2026, 3, 16) });
    expect(parseEvent({ id: "c", status: "cancelled" })).toMatchObject({ cancelled: true });
    expect(parseEvent({ id: "d", start: { dateTime: "pas une date" } })).toBeNull();
  });
});

function fakeGoogle() {
  const st = {
    scope: "" as string,
    events: [] as any[],
    pending: [] as any[], // changements renvoyés par la prochaine synchro incrémentale
    expiredToken: false,
    calls: [] as string[],
  };
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
  const fetch = (async (url: string, init: RequestInit = {}) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      const body = Object.fromEntries(new URLSearchParams(init.body as URLSearchParams));
      return json({ access_token: "AT", ...(body.grant_type === "authorization_code" && { refresh_token: "RT", scope: st.scope }), expires_in: 3600 });
    }
    st.calls.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith("/calendars/primary")) return json({ id: "moi@gmail.com" });
    if (u.pathname.endsWith("/gmail/v1/users/me/profile")) return json({ emailAddress: "moi@gmail.com", historyId: 1 });
    if (u.pathname.endsWith("/gmail/v1/users/me/messages")) return json({});
    if (u.pathname.includes("/calendars/primary/events")) {
      if (u.searchParams.get("syncToken")) {
        if (st.expiredToken) return json({}, 410);
        const items = st.pending; st.pending = [];
        return json({ items, nextSyncToken: "T2" });
      }
      return json({ items: st.events, nextSyncToken: "T1" });
    }
    return json({}, 404);
  }) as never;
  return { st, fetch };
}

async function setup(scope: string) {
  const g = fakeGoogle();
  g.st.scope = scope;
  const rpc = createApp({
    fetch: g.fetch, sleep: async () => {},
    openUrl: async (url) => {
      const u = new URL(url);
      const cb = new URL(u.searchParams.get("redirect_uri")!);
      cb.searchParams.set("code", "C");
      cb.searchParams.set("state", u.searchParams.get("state")!);
      await fetch(cb);
    },
  });
  const call = async (method: string, params?: unknown) =>
    JSON.parse((await rpc.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })))!);
  await call("init", { dataDir: mkdtempSync(join(tmpdir(), "cal-")), key: "k" });
  await call("google.config.set", { clientId: CID });
  const idle = async (id: string) => {
    for (let i = 0; i < 400; i++) {
      const a = (await call("accounts.list")).result.find((x: any) => x.id === id);
      if (a.calendarStatus !== "syncing") return a;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timeout");
  };
  return { g, call, idle };
}

const CAL = "https://www.googleapis.com/auth/calendar.events.readonly";
const MAIL = "https://www.googleapis.com/auth/gmail.readonly";
const gev = (id: string, title: string, start: string, end: string) => ({ id, summary: title, start: { dateTime: start }, end: { dateTime: end }, htmlLink: `https://calendar.google.com/${id}` });

describe("calendrier Google", () => {
  it("connecte un compte calendrier seul, synchronise, expose les fonctionnalités", async () => {
    const { g, call, idle } = await setup(CAL);
    g.st.events = [gev("e1", "Réunion équipe", "2026-03-16T09:00:00+01:00", "2026-03-16T10:00:00+01:00"), { id: "e2", summary: "Férié", start: { date: "2026-03-17" }, end: { date: "2026-03-18" } }];
    const acc = (await call("accounts.connectGoogle", { mail: false, calendar: true })).result;
    expect(acc).toMatchObject({ email: "moi@gmail.com", features: { mail: false, calendar: true } });
    const a = await idle(acc.id);
    expect(a).toMatchObject({ calendarStatus: "idle", eventCount: 2, mailCount: 0 });
    expect(JSON.stringify(a)).not.toMatch(/AT|RT/);
    // pas de synchro mail pour un compte sans portée mail
    expect((await call("mail.sync", { accountId: acc.id })).result.started).toBe(0);
    expect(g.st.calls.some((c) => c.includes("gmail.googleapis.com/gmail/v1/users/me/messages"))).toBe(false);
    // l'URL de synchro limite bien la fenêtre
    expect(g.st.calls.find((c) => c.includes("/events?"))).toMatch(/singleEvents=true.*timeMin=.*timeMax=|timeMin=.*singleEvents=true/);
  });

  it("liste par intervalle (chevauchement, journée entière)", async () => {
    const { g, call, idle } = await setup(CAL);
    g.st.events = [
      gev("e1", "Nuit", "2026-03-15T22:00:00+01:00", "2026-03-16T02:00:00+01:00"), // chevauche minuit
      { id: "e2", summary: "Férié", start: { date: "2026-03-17" }, end: { date: "2026-03-18" } },
      gev("e3", "Plus tard", "2026-04-01T10:00:00+02:00", "2026-04-01T11:00:00+02:00"),
    ];
    const acc = (await call("accounts.connectGoogle", { mail: false, calendar: true })).result;
    await idle(acc.id);
    const titles = async (from: number, to: number) => (await call("calendar.list", { from, to })).result.map((e: any) => e.title);
    expect(await titles(day(2026, 3, 16), day(2026, 3, 17))).toEqual(["Nuit"]);
    expect(await titles(day(2026, 3, 17), day(2026, 3, 18))).toEqual(["Férié"]);
    expect(await titles(day(2026, 3, 1), day(2026, 5, 1))).toEqual(["Nuit", "Férié", "Plus tard"]);
    expect((await call("calendar.list", { from: 5, to: 1 })).error).toBeDefined();
    expect((await call("calendar.list", { from: 0, to: 1e15 })).error).toBeDefined();
  });

  it("synchro incrémentale : modification, ajout et annulation", async () => {
    const { g, call, idle } = await setup(CAL);
    g.st.events = [gev("e1", "Ancien titre", "2026-03-16T09:00:00Z", "2026-03-16T10:00:00Z"), gev("e2", "À annuler", "2026-03-16T11:00:00Z", "2026-03-16T12:00:00Z")];
    const acc = (await call("accounts.connectGoogle", { mail: false, calendar: true })).result;
    await idle(acc.id);
    g.st.pending = [gev("e1", "Nouveau titre", "2026-03-16T09:30:00Z", "2026-03-16T10:30:00Z"), { id: "e2", status: "cancelled" }, gev("e3", "Ajouté", "2026-03-18T09:00:00Z", "2026-03-18T10:00:00Z")];
    await call("calendar.sync", { accountId: acc.id });
    await idle(acc.id);
    const all = (await call("calendar.list", { from: day(2026, 3, 1), to: day(2026, 4, 1) })).result.map((e: any) => e.title);
    expect(all).toEqual(["Nouveau titre", "Ajouté"]);
    expect(g.st.calls.at(-1)).toContain("syncToken=T1");
  });

  it("jeton de synchro expiré (410) → resynchronisation complète sans doublons", async () => {
    const { g, call, idle } = await setup(CAL);
    g.st.events = [gev("e1", "Un", "2026-03-16T09:00:00Z", "2026-03-16T10:00:00Z"), gev("e2", "Deux", "2026-03-16T11:00:00Z", "2026-03-16T12:00:00Z")];
    const acc = (await call("accounts.connectGoogle", { mail: false, calendar: true })).result;
    await idle(acc.id);
    g.st.expiredToken = true;
    g.st.events = [gev("e1", "Un", "2026-03-16T09:00:00Z", "2026-03-16T10:00:00Z")]; // e2 supprimé pendant ce temps
    await call("calendar.sync", { accountId: acc.id });
    const a = await idle(acc.id);
    expect(a).toMatchObject({ calendarStatus: "idle", eventCount: 1 });
  });

  it("compte mail seul : le calendrier est refusé", async () => {
    const { call } = await setup(MAIL);
    const acc = (await call("accounts.connectGoogle", { mail: true, calendar: false })).result;
    expect(acc.features).toEqual({ mail: true, calendar: false });
    expect((await call("calendar.sync", { accountId: acc.id })).result.started).toBe(0);
  });

  it("refuse de connecter sans choisir de fonctionnalité", async () => {
    const { call } = await setup(CAL);
    expect((await call("accounts.connectGoogle", { mail: false, calendar: false })).error.message).toContain("au moins");
  });
});

describe("événements locaux", () => {
  async function local() {
    const s = await setup(CAL);
    return s.call;
  }

  it("crée, modifie, supprime, valide les entrées et journalise", async () => {
    const call = await local();
    const ev = (await call("calendar.create", { title: "  Dentiste ", start: day(2026, 5, 4, 14), end: day(2026, 5, 4, 15), location: "Paris" })).result;
    expect(ev).toMatchObject({ title: "Dentiste", source: "local", aiAdded: false, allDay: false });
    expect((await call("calendar.create", { title: "", start: 1, end: 2 })).error.message).toBe("Titre requis");
    expect((await call("calendar.create", { title: "x", start: 5, end: 1 })).error.message).toContain("fin");
    expect((await call("calendar.create", { title: "x", start: NaN, end: 1 })).error).toBeDefined();

    const up = (await call("calendar.update", { id: ev.id, title: "Dentiste (reporté)", start: day(2026, 5, 5, 14), end: day(2026, 5, 5, 15) })).result;
    expect(up.title).toBe("Dentiste (reporté)");
    await call("calendar.delete", { id: ev.id });
    expect((await call("calendar.get", { id: ev.id })).error).toBeDefined();
    const log = (await call("audit.list", {})).result.map((l: any) => l.action);
    expect(log).toEqual(expect.arrayContaining(["event.create", "event.update", "event.delete"]));
  });

  it("les événements Google sont en lecture seule", async () => {
    const { g, call, idle } = await setup(CAL);
    g.st.events = [gev("e1", "Google", "2026-03-16T09:00:00Z", "2026-03-16T10:00:00Z")];
    const acc = (await call("accounts.connectGoogle", { mail: false, calendar: true })).result;
    await idle(acc.id);
    const [e] = (await call("calendar.list", { from: day(2026, 3, 1), to: day(2026, 4, 1) })).result;
    expect((await call("calendar.update", { id: e.id, title: "x", start: 1, end: 2 })).error.message).toContain("lecture seule");
    expect((await call("calendar.delete", { id: e.id })).error.message).toContain("lecture seule");
  });

  it("retirer le compte supprime ses événements ; les événements locaux restent ; recherche globale", async () => {
    const { g, call, idle } = await setup(CAL);
    g.st.events = [gev("e1", "Réunion budget", "2026-03-16T09:00:00Z", "2026-03-16T10:00:00Z")];
    const acc = (await call("accounts.connectGoogle", { mail: false, calendar: true })).result;
    await idle(acc.id);
    await call("calendar.create", { title: "Anniversaire Paul", start: day(2026, 6, 1), end: day(2026, 6, 2), allDay: true });
    expect((await call("search.query", { q: "budget" })).result[0]).toMatchObject({ type: "event" });
    expect((await call("search.query", { q: "100%" })).result).toEqual([]); // les jokers LIKE sont échappés
    await call("accounts.remove", { id: acc.id });
    const left = (await call("calendar.list", { from: day(2026, 1, 1), to: day(2026, 12, 31) })).result.map((e: any) => e.title);
    expect(left).toEqual(["Anniversaire Paul"]);
    void H;
  });
});
