import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SMTPServer } from "smtp-server";
import { describe, expect, it, vi } from "vitest";
import { buildIcs, parseIcs, updateIcs, type DavLike, type DavObject, type ImapFactory, type ImapLike } from "@assistant/connectors";
import { createApp } from "../src";

const DAY = 86_400_000;
const GCID = "123-abc.apps.googleusercontent.com";
const MSID = "0b3f1c2e-1111-4222-8333-444455556666";
const b64u = (b: string | Buffer) => Buffer.from(b).toString("base64url");
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

// ======================= faux Google + Microsoft =======================

function cloud() {
  const st = {
    gScope: "", msScope: "",
    gMails: new Map<string, any>(), gSent: [] as any[], gEvents: [] as any[], gCreated: [] as any[], gPatched: [] as any[], gDeleted: [] as string[], gFailWrite: false,
    msMessages: [] as any[], msRemoved: [] as string[], msDeltaCalls: 0, msSent: [] as { url: string; body: any }[],
    msEvents: [] as any[], msWrites: [] as { method: string; url: string; body: any }[],
    atts: new Map<string, Buffer>(),
  };
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    // --- IA (brouillons)
    if (url.startsWith("https://api.openai.com/v1/chat/completions"))
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "Corps du brouillon" } }] })}\n\ndata: [DONE]\n\n`);
    // --- OAuth
    if (url.startsWith("https://oauth2.googleapis.com/token"))
      return json({ access_token: "GAT", refresh_token: "GRT", expires_in: 3600, scope: st.gScope });
    if (url.includes("login.microsoftonline.com") && url.endsWith("/token"))
      return json({ access_token: "MAT", refresh_token: "MRT", expires_in: 3600, scope: st.msScope });
    // --- Google
    if (u.host === "gmail.googleapis.com") {
      if (u.pathname.endsWith("/profile")) return json({ emailAddress: "moi@gmail.com", historyId: 1 });
      if (u.pathname.endsWith("/messages/send")) { st.gSent.push(body); return json({ id: "sent1" }); }
      if (u.pathname.endsWith("/messages") && method === "GET") return json({ messages: [...st.gMails.keys()].map((id) => ({ id })) });
      const att = u.pathname.match(/\/messages\/([^/]+)\/attachments\/([^/]+)$/);
      if (att) return json({ data: b64u(st.atts.get(`${att[1]}/${att[2]}`) ?? Buffer.alloc(0)) });
      const m = u.pathname.match(/\/messages\/([^/]+)$/);
      if (m) return json(st.gMails.get(m[1]!));
      if (u.pathname.endsWith("/history")) return json({ historyId: 2, history: [] });
    }
    if (u.host === "www.googleapis.com" && u.pathname.includes("/calendars/primary/events")) {
      if (method === "POST") { if (st.gFailWrite) return json({ error: "boom" }, 403); st.gCreated.push(body); return json({ id: `g-ev-${st.gCreated.length}` }); }
      if (method === "PATCH") { st.gPatched.push({ url, body }); return json({}); }
      if (method === "DELETE") { st.gDeleted.push(decodeURIComponent(u.pathname.split("/").pop()!)); return new Response(null, { status: 204 }); }
      return json({ items: st.gEvents, nextSyncToken: "GT1" });
    }
    if (u.host === "www.googleapis.com" && u.pathname.endsWith("/calendars/primary")) return json({ id: "moi@gmail.com" });
    // --- Microsoft Graph
    if (u.host === "graph.microsoft.com") {
      if (u.pathname === "/v1.0/me") return json({ mail: "moi@outlook.com" });
      if (u.pathname.includes("/mailFolders/inbox/messages/delta") || u.pathname.includes("/mailFolders/sentitems/messages/delta")) {
        const sent = u.pathname.includes("sentitems");
        st.msDeltaCalls++;
        return json({ value: sent ? [] : [...st.msMessages, ...st.msRemoved.map((id) => ({ id, "@removed": { reason: "deleted" } }))], "@odata.deltaLink": `https://graph.microsoft.com/v1.0${u.pathname}?$deltatoken=${st.msDeltaCalls}` });
      }
      if (u.pathname.endsWith("/$value")) return new Response(new Uint8Array(st.atts.get(`ms/${u.pathname.split("/").at(-2)}`) ?? Buffer.alloc(0)));
      if (u.pathname.includes("/attachments")) return json({ value: [{ "@odata.type": "#microsoft.graph.fileAttachment", id: "att1", name: "contrat.txt", contentType: "text/plain", size: 200 }] });
      if (u.pathname.endsWith("/sendMail") || u.pathname.endsWith("/reply")) { st.msSent.push({ url, body }); return new Response(null, { status: 202 }); }
      if (u.pathname.includes("/calendarView/delta")) return json({ value: st.msEvents, "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=C1" });
      if (u.pathname === "/v1.0/me/events" && method === "POST") { st.msWrites.push({ method, url, body }); return json({ id: "ms-ev-1" }); }
      if (u.pathname.startsWith("/v1.0/me/events/")) { st.msWrites.push({ method, url, body }); return new Response(null, { status: 204 }); }
    }
    return json({}, 404);
  }) as never;
  return { st, fetch };
}

async function setup(extra: Record<string, any> = {}) {
  const { st, fetch: f } = cloud();
  const events: any[] = [];
  const rpc = createApp({
    fetch: f, sleep: async () => {}, notify: (m, p) => events.push({ m, ...(p as object) }),
    openUrl: async (url) => {
      const u = new URL(url);
      const cb = new URL(u.searchParams.get("redirect_uri")!);
      cb.searchParams.set("code", "C");
      cb.searchParams.set("state", u.searchParams.get("state")!);
      await fetch(cb);
    },
    ...extra,
  });
  const call = async (method: string, params?: unknown) => JSON.parse((await rpc.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })))!);
  await call("init", { dataDir: mkdtempSync(join(tmpdir(), "acc-")), key: "k" });
  await call("google.config.set", { clientId: GCID });
  await call("microsoft.config.set", { clientId: MSID });
  const s0 = (await call("settings.get")).result;
  s0.ai.providers = { oa: { kind: "openai" } };
  s0.ai.routes = { draft: { primary: { provider: "oa", model: "m" } } };
  await call("settings.set", { settings: s0 });
  await call("ai.setKeys", { keys: { oa: "k" } });
  const idle = async (id: string, kind: "mail" | "calendar" = "mail") => {
    for (let i = 0; i < 500; i++) {
      const a = (await call("accounts.list")).result.find((x: any) => x.id === id);
      if ((kind === "mail" ? a.syncStatus : a.calendarStatus ?? "idle") !== "syncing") return a;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timeout");
  };
  const setSettings = async (patch: (s: any) => void) => { const s = (await call("settings.get")).result; patch(s); await call("settings.set", { settings: s }); };
  return { st, call, events, idle, setSettings };
}

const gmsg = (id: string, subject: string, body: string, attach?: { name: string; attId: string; size: number; mime: string }) => ({
  id, threadId: `t${id}`, snippet: body.slice(0, 20), internalDate: String(Date.now()), labelIds: ["INBOX"],
  payload: { mimeType: "multipart/mixed", headers: [{ name: "From", value: "Ann <ann@x.com>" }, { name: "Subject", value: subject }, { name: "Message-ID", value: `<${id}@x.com>` }],
    parts: [{ mimeType: "text/plain", body: { data: b64u(body) } }, ...(attach ? [{ mimeType: attach.mime, filename: attach.name, body: { attachmentId: attach.attId, size: attach.size } }] : [])] },
});

// ======================= Microsoft 365 / Outlook =======================

describe("Microsoft 365 / Outlook", () => {
  it("connecte (OAuth localhost), synchronise mails (delta) et agenda, puis incrémentalement", async () => {
    const t = await setup();
    t.st.msScope = "Mail.Read Calendars.Read User.Read";
    t.st.msMessages = [
      { id: "m1", subject: "Devis", from: { emailAddress: { name: "Ann", address: "ann@x.com" } }, toRecipients: [], receivedDateTime: new Date().toISOString(), bodyPreview: "p", body: { contentType: "text", content: "Voici le devis" }, hasAttachments: true, conversationId: "c1", internetMessageId: "<m1@x>" },
    ];
    t.st.msEvents = [{ id: "e1", subject: "Revue", start: { dateTime: "2026-03-16T09:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-03-16T10:00:00.0000000", timeZone: "UTC" }, isAllDay: false }];
    const acc = (await t.call("accounts.connectMicrosoft", { mail: true, calendar: true })).result;
    expect(acc).toMatchObject({ email: "moi@outlook.com", features: { mail: true, calendar: true, send: false, calendarWrite: false } });
    const a = await t.idle(acc.id);
    await vi.waitFor(async () => expect((await t.call("accounts.list")).result[0]).toMatchObject({ mailCount: 1, eventCount: 1, provider: "microsoft" }), { timeout: 5000 });
    expect(a.syncError ?? null).toBeNull();
    const mails = (await t.call("mail.list", {})).result;
    expect(mails[0]).toMatchObject({ subject: "Devis", attachmentCount: 1 });
    expect(JSON.stringify(await t.call("accounts.list"))).not.toMatch(/MAT|MRT/);

    // incrémental : nouveau + supprimé
    t.st.msMessages = [{ id: "m2", subject: "Nouveau", from: { emailAddress: { address: "b@x.com" } }, toRecipients: [], receivedDateTime: new Date().toISOString(), body: { contentType: "text", content: "salut" } }];
    t.st.msRemoved = ["m1"];
    await t.call("mail.sync", { accountId: acc.id });
    await vi.waitFor(async () => expect((await t.call("mail.list", {})).result.map((m: any) => m.subject)).toEqual(["Nouveau"]), { timeout: 5000 });
  });

  it("refuse la config invalide ; l'écriture agenda et l'envoi exigent les droits correspondants", async () => {
    const t = await setup();
    expect((await t.call("microsoft.config.set", { clientId: "pas-un-guid" })).error.message).toContain("GUID");
    expect((await t.call("microsoft.config.set", { clientId: MSID, tenant: "../evil" })).error).toBeDefined();
    t.st.msScope = "Mail.Read Calendars.Read";
    t.st.msMessages = [{ id: "m1", subject: "Devis", from: { emailAddress: { address: "ann@x.com" } }, toRecipients: [], receivedDateTime: new Date().toISOString(), body: { contentType: "text", content: "x" } }];
    const acc = (await t.call("accounts.connectMicrosoft", { mail: true, calendar: true })).result;
    await t.idle(acc.id);
    await vi.waitFor(async () => expect((await t.call("mail.list", {})).result).toHaveLength(1), { timeout: 5000 });
    await t.setSettings((s) => (s.mail.allowSend = true));
    const d = await draftFor(t, acc.id);
    expect((await t.call("drafts.send", { draftId: d, confirm: true })).error.message).toContain("pas autorisé à envoyer");
  });

  it("envoie une réponse (via /reply) et écrit les événements dans Outlook quand c'est configuré", async () => {
    const t = await setup();
    t.st.msScope = "Mail.Read Mail.Send Calendars.ReadWrite";
    t.st.msMessages = [{ id: "m1", subject: "Devis", from: { emailAddress: { address: "ann@x.com" } }, toRecipients: [], receivedDateTime: new Date().toISOString(), body: { contentType: "text", content: "Peux-tu confirmer ?" } }];
    const acc = (await t.call("accounts.connectMicrosoft", { mail: true, send: true, calendarWrite: true })).result;
    expect(acc.features).toEqual({ mail: true, send: true, calendar: true, calendarWrite: true });
    await t.idle(acc.id);
    await t.setSettings((s) => { s.mail.allowSend = true; s.calendar.writeTo = acc.id; });
    await vi.waitFor(async () => expect((await t.call("mail.list", {})).result).toHaveLength(1), { timeout: 5000 });
    const d = await draftFor(t, acc.id);
    await t.call("drafts.send", { draftId: d, confirm: true });
    expect(t.st.msSent.at(-1)).toMatchObject({ url: expect.stringContaining("/me/messages/m1/reply"), body: { comment: expect.any(String) } });

    const start = Date.now() + 2 * DAY;
    const ev = (await t.call("calendar.create", { title: "Dîner", start, end: start + 3600_000 })).result;
    await vi.waitFor(() => expect(t.st.msWrites.some((w) => w.method === "POST")).toBe(true), { timeout: 5000 });
    await vi.waitFor(async () => expect((await t.call("calendar.get", { id: ev.id })).result).toMatchObject({ remoteId: "ms-ev-1", accountId: acc.id }), { timeout: 5000 });
    await t.call("calendar.update", { id: ev.id, title: "Dîner (reporté)", start, end: start + 7200_000 });
    await vi.waitFor(() => expect(t.st.msWrites.some((w) => w.method === "PATCH" && w.body.subject === "Dîner (reporté)")).toBe(true), { timeout: 5000 });
    await t.call("calendar.delete", { id: ev.id });
    await vi.waitFor(() => expect(t.st.msWrites.some((w) => w.method === "DELETE")).toBe(true), { timeout: 5000 });
  });
});

/** Brouillon de réponse (rédigé par le faux modèle) sur le premier mail du compte. */
async function draftFor(t: Awaited<ReturnType<typeof setup>>, accountId: string) {
  const mail = (await t.call("mail.list", { accountId })).result[0];
  return (await t.call("drafts.reply", { mailId: mail.id })).result.id as string;
}

// ======================= IMAP / SMTP =======================

const rfc = (o: { subject: string; body: string; msgId: string; attach?: { name: string; text: string } }) =>
  Buffer.from([
    "From: Ann <ann@x.com>", "To: moi@x.com", `Subject: ${o.subject}`, `Message-ID: <${o.msgId}>`, `Date: ${new Date().toUTCString()}`, "MIME-Version: 1.0",
    ...(o.attach
      ? ['Content-Type: multipart/mixed; boundary="B"', "", "--B", "Content-Type: text/plain; charset=utf-8", "", o.body, "--B", `Content-Type: text/plain; name="${o.attach.name}"`, `Content-Disposition: attachment; filename="${o.attach.name}"`, "Content-Transfer-Encoding: base64", "", Buffer.from(o.attach.text).toString("base64"), "--B--"]
      : ["Content-Type: text/plain; charset=utf-8", "", o.body]),
  ].join("\r\n"));

function fakeImap(msgs: Map<number, Buffer>, opts: { failLogin?: boolean } = {}) {
  const factory: ImapFactory = () => {
    const api: ImapLike = {
      connect: async () => { if (opts.failLogin) throw new Error("Invalid credentials"); },
      list: async () => [{ path: "INBOX" }],
      getMailboxLock: async () => ({ release() {} }),
      get mailbox() { return { uidValidity: 1, uidNext: Math.max(0, ...msgs.keys()) + 1 }; },
      search: async (q: any) => { const u = [...msgs.keys()]; if (q.uid) { const lo = Number(String(q.uid).split(":")[0]); const r = u.filter((x) => x >= lo); return r.length ? r : u.slice(-1); } return u; },
      async *fetch(range: string) { for (const u of range.split(",").map(Number)) if (msgs.has(u)) yield { uid: u, source: msgs.get(u) }; },
      fetchOne: async (r: string) => (msgs.has(Number(r)) ? { source: msgs.get(Number(r)) } : false),
      logout: async () => {},
    };
    return api;
  };
  return factory;
}

describe("IMAP / SMTP", () => {
  it("ajoute un compte (identifiants testés), synchronise, et refuse un mot de passe invalide sans rien enregistrer", async () => {
    const msgs = new Map([[1, rfc({ subject: "Bonjour", body: "Texte", msgId: "a@x" })]]);
    const bad = await setup({ imapFactory: fakeImap(msgs, { failLogin: true }) });
    const r = await bad.call("accounts.addImap", { email: "moi@x.com", imapHost: "imap.x.com", password: "mauvais" });
    expect(r.error.message).toContain("Connexion IMAP impossible");
    expect((await bad.call("accounts.list")).result).toEqual([]);

    const t = await setup({ imapFactory: fakeImap(msgs) });
    expect((await t.call("accounts.addImap", { email: "pas-un-mail", imapHost: "imap.x.com", password: "p" })).error.message).toContain("invalide");
    expect((await t.call("accounts.addImap", { email: "moi@x.com", imapHost: "imap x.com;rm", password: "p" })).error.message).toContain("serveur invalide");
    const acc = (await t.call("accounts.addImap", { email: "moi@x.com", imapHost: "imap.x.com", password: "secret" })).result;
    expect(acc.features).toEqual({ mail: true, send: false, calendar: false, calendarWrite: false });
    await vi.waitFor(async () => expect((await t.call("mail.list", {})).result.map((m: any) => m.subject)).toEqual(["Bonjour"]), { timeout: 5000 });
    expect(JSON.stringify(await t.call("accounts.list"))).not.toContain("secret"); // le mot de passe ne quitte jamais le moteur
    msgs.set(2, rfc({ subject: "Deuxième", body: "x", msgId: "b@x" })); msgs.delete(1);
    await t.call("mail.sync", { accountId: acc.id });
    await vi.waitFor(async () => expect((await t.call("mail.list", {})).result.map((m: any) => m.subject)).toEqual(["Deuxième"]), { timeout: 5000 });
  });

  it("envoi réel vers un serveur SMTP local : dans le fil, vers le bon destinataire ; sans SMTP, envoi refusé", async () => {
    const got: string[] = [];
    const smtp = new SMTPServer({
      authOptional: false, allowInsecureAuth: true, disabledCommands: ["STARTTLS"],
      onAuth: (a, _s, cb) => (a.username === "moi@x.com" && a.password === "bon" ? cb(null, { user: 1 }) : cb(new Error("no"))),
      onData(stream, _s, cb) { const c: Buffer[] = []; stream.on("data", (d) => c.push(d)); stream.on("end", () => { got.push(Buffer.concat(c).toString()); cb(); }); },
    });
    smtp.listen(0, "127.0.0.1");
    await once(smtp.server, "listening");
    const port = (smtp.server.address() as AddressInfo).port;
    try {
      const msgs = new Map([[1, rfc({ subject: "Devis", body: "Peux-tu confirmer ?", msgId: "orig@x.com" })]]);
      const t = await setup({ imapFactory: fakeImap(msgs) });
      // sans SMTP : lecture seule
      const ro = (await t.call("accounts.addImap", { email: "lecture@x.com", imapHost: "imap.x.com", password: "p" })).result;
      await vi.waitFor(async () => expect((await t.call("mail.list", { accountId: ro.id })).result).toHaveLength(1), { timeout: 5000 });
      await t.setSettings((s) => (s.mail.allowSend = true));
      expect((await t.call("drafts.send", { draftId: await draftFor(t, ro.id), confirm: true })).error.message).toContain("pas autorisé à envoyer");
      // SMTP distant non chiffré refusé ; mauvais mot de passe refusé
      expect((await t.call("accounts.addImap", { email: "moi@x.com", imapHost: "imap.x.com", password: "bon", smtpHost: "smtp.exemple.com", smtpPort: 25, insecure: true })).error.message).toContain("Connexion SMTP impossible");
      expect((await t.call("accounts.addImap", { email: "moi@x.com", imapHost: "imap.x.com", password: "mauvais", smtpHost: "127.0.0.1", smtpPort: port, smtpSecure: false, insecure: true })).error.message).toContain("Connexion SMTP impossible");
      const acc = (await t.call("accounts.addImap", { email: "moi@x.com", imapHost: "imap.x.com", password: "bon", smtpHost: "127.0.0.1", smtpPort: port, smtpSecure: false, insecure: true })).result;
      expect(acc.features.send).toBe(true);
      await vi.waitFor(async () => expect((await t.call("mail.list", { accountId: acc.id })).result).toHaveLength(1), { timeout: 5000 });
      const d = await draftFor(t, acc.id);
      expect((await t.call("drafts.send", { draftId: d })).error.message).toContain("Confirmation");
      const r = (await t.call("drafts.send", { draftId: d, confirm: true })).result;
      expect(r.to).toEqual(["ann@x.com"]);
      expect(got).toHaveLength(1);
      expect(got[0]).toContain("In-Reply-To: <orig@x.com>");
      expect(got[0]).toContain("Subject: Re: Devis");
      expect(got[0]).toContain("Corps du brouillon");
    } finally {
      smtp.close();
    }
  });

  it("pièce jointe IMAP importée via le serveur", async () => {
    const msgs = new Map([[1, rfc({ subject: "Facture", body: "voir pièce jointe", msgId: "f@x", attach: { name: "facture.txt", text: "Facture Orange 39 euros imapattmarqueur" } })]]);
    const t = await setup({ imapFactory: fakeImap(msgs) });
    const acc = (await t.call("accounts.addImap", { email: "moi@x.com", imapHost: "imap.x.com", password: "p" })).result;
    await vi.waitFor(async () => expect((await t.call("mail.list", { accountId: acc.id })).result).toHaveLength(1), { timeout: 5000 });
    const mail = (await t.call("mail.list", {})).result[0];
    expect((await t.call("mail.importAttachments", { id: mail.id })).result.imported).toBe(1);
    await vi.waitFor(async () => expect((await t.call("search.query", { q: "imapattmarqueur" })).result.length).toBe(1), { timeout: 8000 });
  });
});

// ======================= CalDAV =======================

function fakeDav() {
  const objs = new Map<string, DavObject>();
  let ctag = "1";
  const log: string[] = [];
  const dav: DavLike = {
    ctag: async () => ctag,
    fetchObjects: async (r) => { log.push(`fetch ${r.start.slice(0, 4)}`); return [...objs.values()]; },
    get: async (url) => objs.get(url) ?? null,
    create: async (filename, ics) => { const url = `https://dav.example.com/cal/${filename}`; objs.set(url, { url, etag: "e1", data: ics }); ctag = String(Number(ctag) + 1); log.push(`create ${filename}`); return url; },
    update: async (o) => { objs.set(o.url, { ...o, etag: "e2" }); ctag = String(Number(ctag) + 1); log.push(`update ${o.url.split("/").pop()}`); },
    remove: async (o) => { objs.delete(o.url); ctag = String(Number(ctag) + 1); log.push(`remove ${o.url.split("/").pop()}`); },
  };
  return { dav, objs, log, bump: () => (ctag = String(Number(ctag) + 1)) };
}

describe("CalDAV", () => {
  it("connecte, synchronise (récurrences développées), ne relit rien si le ctag n'a pas changé, écrit et modifie", async () => {
    const f = fakeDav();
    const start = new Date(); start.setDate(start.getDate() + 3); start.setHours(9, 0, 0, 0);
    const day = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
    f.objs.set("https://dav.example.com/cal/serie.ics", { url: "https://dav.example.com/cal/serie.ics", etag: "x", data: `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:serie\r\nSUMMARY:Point hebdo\r\nDTSTART:${day(start)}\r\nDTEND:${day(new Date(start.getTime() + 1800_000))}\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n` });
    const t = await setup({ dav: async () => f.dav });
    expect((await t.call("accounts.addCalDav", { url: "http://pas-https.example.com/dav", user: "u", password: "p" })).result).toBeDefined(); // injecté : l'exigence https est testée côté connecteur
    await t.call("accounts.remove", { id: (await t.call("accounts.list")).result[0].id });
    const acc = (await t.call("accounts.addCalDav", { url: "https://dav.example.com/cal/", user: "moi@exemple.fr", password: "pw" })).result;
    expect(acc.features).toEqual({ mail: false, send: false, calendar: true, calendarWrite: true });
    await vi.waitFor(async () => expect((await t.call("accounts.list")).result[0].eventCount).toBe(3), { timeout: 5000 });
    expect(JSON.stringify(await t.call("accounts.list"))).not.toContain("pw");

    const fetches = f.log.filter((l) => l.startsWith("fetch")).length;
    await t.call("calendar.sync", { accountId: acc.id });
    await t.idle(acc.id, "calendar");
    expect(f.log.filter((l) => l.startsWith("fetch")).length).toBe(fetches); // ctag identique : rien relu

    // écriture : création locale → écrite sur le serveur, puis modification, puis occurrence récurrente refusée
    await t.setSettings((s) => (s.calendar.writeTo = acc.id));
    const s2 = Math.floor(Date.now() / 60_000) * 60_000 + 5 * DAY; // l'ICS n'a pas de millisecondes
    const ev = (await t.call("calendar.create", { title: "Dentiste", start: s2, end: s2 + 3600_000, location: "Paris" })).result;
    await vi.waitFor(() => expect(f.log.some((l) => l.startsWith("create"))).toBe(true), { timeout: 5000 });
    const created = [...f.objs.values()].find((o) => o.data.includes("Dentiste"))!;
    expect(parseIcs(created.data, created.url, s2 - DAY, s2 + DAY)[0]).toMatchObject({ title: "Dentiste", location: "Paris" });
    await vi.waitFor(async () => expect((await t.call("calendar.get", { id: ev.id })).result.remoteId).toBe(created.url), { timeout: 5000 });
    await t.call("calendar.update", { id: ev.id, title: "Dentiste (reporté)", start: s2 + DAY, end: s2 + DAY + 3600_000 });
    await vi.waitFor(() => expect(f.log.some((l) => l.startsWith("update"))).toBe(true), { timeout: 5000 });
    expect(parseIcs(f.objs.get(created.url)!.data, created.url, s2, s2 + 3 * DAY)[0]).toMatchObject({ title: "Dentiste (reporté)", start: s2 + DAY });

    // une occurrence de série récurrente n'est pas modifiable depuis l'application
    const occ = (await t.call("calendar.list", { from: start.getTime() - DAY, to: start.getTime() + 30 * DAY })).result.find((e: any) => e.title === "Point hebdo");
    expect(occ.writable).toBe(true); // CalDAV autorise l'écriture…
    await t.call("calendar.update", { id: occ.id, title: "Renommé", start: occ.start, end: occ.end });
    await vi.waitFor(async () => expect((await t.call("calendar.get", { id: occ.id })).result.pushError).toContain("récurrente"), { timeout: 5000 });

    await t.call("calendar.delete", { id: ev.id });
    await vi.waitFor(() => expect(f.log.some((l) => l.startsWith("remove"))).toBe(true), { timeout: 5000 });
    void buildIcs; void updateIcs; void readFileSync; void writeFileSync;
  });

  it("connexion refusée : rien n'est enregistré", async () => {
    const t = await setup({ dav: async () => { throw new Error("401 Unauthorized"); } });
    expect((await t.call("accounts.addCalDav", { url: "https://dav.example.com/", user: "u", password: "mauvais" })).error.message).toContain("Connexion CalDAV impossible");
    expect((await t.call("accounts.list")).result).toEqual([]);
    expect((await t.call("accounts.addCalDav", { url: "https://x", user: "", password: "" })).error.message).toContain("requis");
  });
});

// ======================= Google : écriture agenda, envoi, pièces jointes =======================

describe("Google : écriture de l'agenda, envoi, pièces jointes", () => {
  it("écrit les événements créés (et ceux de l'IA) quand le réglage est activé ; échec visible ; pas de doublon à la synchro ; annulation supprime la copie distante", async () => {
    const t = await setup();
    t.st.gScope = "https://www.googleapis.com/auth/calendar.events";
    const acc = (await t.call("accounts.connectGoogle", { mail: false, calendarWrite: true })).result;
    expect(acc.features).toMatchObject({ calendar: true, calendarWrite: true });
    await t.idle(acc.id, "calendar");

    // réglage absent : événement local seulement
    const s0 = Date.now() + 2 * DAY;
    await t.call("calendar.create", { title: "Local seulement", start: s0, end: s0 + 3600_000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(t.st.gCreated).toHaveLength(0);

    await t.setSettings((s) => (s.calendar.writeTo = acc.id));
    const ev = (await t.call("calendar.create", { title: "Réunion client", start: s0, end: s0 + 3600_000, location: "Lyon" })).result;
    await vi.waitFor(() => expect(t.st.gCreated).toHaveLength(1), { timeout: 5000 });
    expect(t.st.gCreated[0]).toMatchObject({ summary: "Réunion client", location: "Lyon", start: { dateTime: new Date(s0).toISOString() } });
    await vi.waitFor(async () => expect((await t.call("calendar.get", { id: ev.id })).result).toMatchObject({ remoteId: "g-ev-1", accountId: acc.id, source: "local" }), { timeout: 5000 });

    // la synchro ramène l'événement : pas de doublon, et il reste « local » (modifiable)
    t.st.gEvents = [{ id: "g-ev-1", summary: "Réunion client", start: { dateTime: new Date(s0).toISOString() }, end: { dateTime: new Date(s0 + 3600_000).toISOString() } }];
    await t.call("calendar.sync", { accountId: acc.id });
    await t.idle(acc.id, "calendar");
    const titles = (await t.call("calendar.list", { from: s0 - DAY, to: s0 + DAY })).result.map((e: any) => e.title);
    expect(titles.filter((x: string) => x === "Réunion client")).toHaveLength(1);

    // modification et suppression répercutées
    await t.call("calendar.update", { id: ev.id, title: "Réunion client v2", start: s0, end: s0 + 7200_000 });
    await vi.waitFor(() => expect(t.st.gPatched.at(-1)?.body.summary).toBe("Réunion client v2"), { timeout: 5000 });
    await t.call("calendar.delete", { id: ev.id });
    await vi.waitFor(() => expect(t.st.gDeleted).toContain("g-ev-1"), { timeout: 5000 });

    // échec d'écriture : l'événement reste local, l'erreur est conservée et visible
    t.st.gFailWrite = true;
    const bad = (await t.call("calendar.create", { title: "Écriture refusée", start: s0, end: s0 + 3600_000 })).result;
    await vi.waitFor(async () => expect((await t.call("calendar.get", { id: bad.id })).result.pushError).toContain("403"), { timeout: 5000 });
    expect((await t.call("calendar.get", { id: bad.id })).result.remoteId).toBeNull();
    expect(t.events.some((e) => e.m === "calendar.event" && e.status === "push-error")).toBe(true);
  });

  it("un agenda en lecture seule reste non modifiable ; avec l'écriture, un événement Google devient modifiable", async () => {
    const t = await setup();
    t.st.gScope = "https://www.googleapis.com/auth/calendar.events.readonly";
    const s0 = Date.now() + 3 * DAY;
    t.st.gEvents = [{ id: "g1", summary: "Invitation", start: { dateTime: new Date(s0).toISOString() }, end: { dateTime: new Date(s0 + 3600_000).toISOString() } }];
    const acc = (await t.call("accounts.connectGoogle", { mail: false, calendar: true })).result;
    await t.idle(acc.id, "calendar");
    const [e] = (await t.call("calendar.list", { from: s0 - DAY, to: s0 + DAY })).result;
    expect(e).toMatchObject({ source: "google", writable: false });
    expect((await t.call("calendar.update", { id: e.id, title: "x", start: s0, end: s0 + 1 })).error.message).toContain("lecture seule");

    t.st.gScope = "https://www.googleapis.com/auth/calendar.events";
    await t.call("accounts.connectGoogle", { mail: false, calendarWrite: true }); // reconsentement
    await t.idle(acc.id, "calendar");
    const [e2] = (await t.call("calendar.list", { from: s0 - DAY, to: s0 + DAY })).result;
    expect(e2.writable).toBe(true);
    await t.call("calendar.update", { id: e2.id, title: "Invitation (déplacée)", start: s0, end: s0 + 3600_000 });
    await vi.waitFor(() => expect(t.st.gPatched.at(-1)?.url).toContain("/events/g1"), { timeout: 5000 });
  });

  it("pièces jointes : importées comme documents reliés au mail, filtres respectés, doublons ignorés", async () => {
    const t = await setup();
    t.st.gScope = "https://www.googleapis.com/auth/gmail.readonly";
    t.st.gMails.set("m1", gmsg("m1", "Contrat", "Voir pièces jointes", { name: "contrat.txt", attId: "a1", size: 300, mime: "text/plain" }));
    t.st.atts.set("m1/a1", Buffer.from("Contrat de prestation. Clause de préavis attmarqueur."));
    const m2 = gmsg("m2", "Divers", "x");
    (m2.payload.parts as any[]).push({ mimeType: "application/x-msdownload", filename: "setup.exe", body: { attachmentId: "a2", size: 100 } }, { mimeType: "image/png", filename: "logo.png", body: { attachmentId: "a3", size: 800 } }, { mimeType: "application/pdf", filename: "gros.pdf", body: { attachmentId: "a4", size: 40 * 1024 * 1024 } });
    t.st.gMails.set("m2", m2);
    const acc = (await t.call("accounts.connectGoogle", { mail: true })).result;
    await t.idle(acc.id);
    await vi.waitFor(async () => expect((await t.call("mail.list", {})).result).toHaveLength(2), { timeout: 5000 });

    const mails = (await t.call("mail.list", {})).result;
    const m1 = mails.find((m: any) => m.subject === "Contrat");
    const r1 = (await t.call("mail.importAttachments", { id: m1.id })).result;
    expect(r1).toMatchObject({ imported: 1, skipped: [] });
    await vi.waitFor(async () => expect((await t.call("documents.list")).result[0]?.status).toBe("ready"), { timeout: 8000 });
    expect((await t.call("search.query", { q: "attmarqueur" })).result[0]).toMatchObject({ type: "document", title: expect.stringContaining("contrat.txt") });
    expect((await t.call("mail.get", { id: m1.id })).result.attachments[0].documentId).toBeTruthy();
    const g = (await t.call("memory.graph", {})).result;
    expect(g.edges.some((e: any) => e.rel === "attachment" && e.src === `mail:${m1.id}`)).toBe(true);
    // deuxième import : rien de plus
    expect((await t.call("mail.importAttachments", { id: m1.id })).result.imported).toBe(0);
    expect((await t.call("documents.list")).result).toHaveLength(1);

    const m2r = (await t.call("mail.importAttachments", { id: mails.find((m: any) => m.subject === "Divers").id })).result;
    expect(m2r.imported).toBe(0);
    expect(m2r.skipped.map((s: any) => s.reason)).toEqual(["format non pris en charge", "image trop petite (logo ?)", "trop volumineuse (15 Mo max)"]);
  });

  it("envoi Gmail : fil conservé (In-Reply-To, threadId), refus sans confirmation / sans réglage / sans droit d'envoi, une seule fois", async () => {
    const t = await setup();
    t.st.gScope = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";
    t.st.gMails.set("m1", gmsg("m1", "Devis", "Peux-tu confirmer ?"));
    const acc = (await t.call("accounts.connectGoogle", { mail: true, send: true })).result;
    expect(acc.features).toMatchObject({ mail: true, send: true });
    await t.idle(acc.id);
    await vi.waitFor(async () => expect((await t.call("mail.list", {})).result).toHaveLength(1), { timeout: 5000 });
    const d = await draftFor(t, acc.id);

    expect((await t.call("drafts.send", { draftId: d })).error.message).toContain("Confirmation explicite");
    expect((await t.call("drafts.send", { draftId: d, confirm: "oui" })).error.message).toContain("Confirmation explicite");
    expect((await t.call("drafts.send", { draftId: d, confirm: true })).error.message).toContain("désactivé"); // réglage par défaut
    expect(t.st.gSent).toHaveLength(0);

    await t.setSettings((s) => (s.mail.allowSend = true));
    expect((await t.call("drafts.send", { draftId: "inconnu", confirm: true })).error.message).toContain("introuvable");
    expect((await t.call("drafts.send", { draftId: d, confirm: true, to: ["pas-un-mail"] })).error.message).toContain("invalide");
    const r = (await t.call("drafts.send", { draftId: d, confirm: true, subject: "Re: Devis\r\nBcc: pirate@evil.com" })).result;
    expect(r).toEqual({ sent: true, to: ["ann@x.com"] });
    expect(t.st.gSent[0]).toMatchObject({ threadId: "tm1" });
    const raw = Buffer.from(t.st.gSent[0].raw, "base64url").toString();
    expect(raw).toContain("In-Reply-To: <m1@x.com>");
    expect(raw).toContain("Corps du brouillon");
    expect(raw).not.toMatch(/^Bcc:/im);
    expect((await t.call("drafts.send", { draftId: d, confirm: true })).error.message).toContain("déjà été envoyé");
    const log = (await t.call("audit.list", { action: "mail.send" })).result;
    expect(log).toHaveLength(1);
    expect(JSON.stringify(log)).not.toContain("Corps du brouillon"); // le corps n'est jamais journalisé
  });
});
