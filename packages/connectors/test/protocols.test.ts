import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";
import { describe, expect, it } from "vitest";
import {
  GraphClient, buildIcs, buildRfc822, fetchImapAttachment, isRecurringIcs, microsoftEndpoints, parseGraphEvent, parseGraphMessage,
  parseIcs, parseRemoteId, remoteId, sanitizeOutgoing, sendSmtp, syncImap, testSmtp, updateIcs, type ImapFactory, type ImapLike,
} from "../src";

const DAY = 86_400_000;
const NOW = new Date(2026, 2, 10, 9).getTime();

// ---------- IMAP (serveur simulé en mémoire, vrai analyseur MIME) ----------

const rfc = (o: { subject: string; from?: string; to?: string; body: string; msgId: string; date?: string; attach?: boolean }) =>
  Buffer.from([
    `From: ${o.from ?? "Ann <ann@x.com>"}`, `To: ${o.to ?? "moi@x.com"}`, `Subject: ${o.subject}`, `Message-ID: <${o.msgId}>`,
    `Date: ${o.date ?? "Tue, 10 Mar 2026 08:00:00 +0000"}`, "MIME-Version: 1.0",
    ...(o.attach
      ? ['Content-Type: multipart/mixed; boundary="B"', "", "--B", "Content-Type: text/plain; charset=utf-8", "", o.body, "--B",
         'Content-Type: application/pdf; name="facture.pdf"', 'Content-Disposition: attachment; filename="facture.pdf"', "Content-Transfer-Encoding: base64", "", Buffer.from("%PDF-fake").toString("base64"), "--B--"]
      : ["Content-Type: text/plain; charset=utf-8", "", o.body]),
  ].join("\r\n"));

interface Box { path: string; specialUse?: string; validity: number; msgs: Map<number, Buffer>; uidNext: number }
function fakeServer(boxes: Box[]) {
  const log: string[] = [];
  const factory: ImapFactory = () => {
    let cur: Box | null = null;
    const api: ImapLike = {
      connect: async () => { log.push("connect"); },
      list: async () => boxes.map((b) => ({ path: b.path, specialUse: b.specialUse })),
      getMailboxLock: async (p) => { cur = boxes.find((b) => b.path === p)!; return { release() {} }; },
      get mailbox() { return cur ? { uidValidity: cur.validity, uidNext: cur.uidNext } : false; },
      search: async (q: any) => {
        const uids = [...cur!.msgs.keys()];
        if (q.all) return uids;
        if (q.uid) { const lo = Number(String(q.uid).split(":")[0]); return uids.filter((u) => u >= lo).length ? uids.filter((u) => u >= lo) : [Math.max(...uids)]; }
        return uids; // since : tout (la fenêtre est testée côté appelant)
      },
      async *fetch(range: string) { for (const u of range.split(",").map(Number)) if (cur!.msgs.has(u)) yield { uid: u, source: cur!.msgs.get(u) }; },
      fetchOne: async (r: string) => (cur!.msgs.has(Number(r)) ? { source: cur!.msgs.get(Number(r)) } : false),
      logout: async () => { log.push("logout"); },
    };
    return api;
  };
  return { factory, log };
}
const CFG = { host: "imap.x.com", port: 993, secure: true, user: "moi@x.com", pass: "secret" };

describe("IMAP", () => {
  it("synchro initiale (INBOX + Envoyés détecté), puis incrémentale, suppressions et UIDVALIDITY", async () => {
    const inbox: Box = { path: "INBOX", validity: 7, uidNext: 3, msgs: new Map([[1, rfc({ subject: "Devis", body: "Voici le devis", msgId: "a@x" })], [2, rfc({ subject: "Facture", body: "pièce jointe", msgId: "b@x", attach: true })]]) };
    const sent: Box = { path: "Éléments envoyés", specialUse: "\\Sent", validity: 1, uidNext: 2, msgs: new Map([[1, rfc({ subject: "Re: Devis", from: "moi@x.com", to: "ann@x.com", body: "OK", msgId: "c@x" })]]) };
    const { factory, log } = fakeServer([inbox, sent]);

    const r1 = await syncImap(CFG, null, [], { sinceMs: NOW - 30 * DAY, max: 500, factory });
    expect(r1.upserts.map((m) => [m.id, m.subject, m.labels[0]])).toEqual([["INBOX:1", "Devis", "INBOX"], ["INBOX:2", "Facture", "INBOX"], ["Éléments envoyés:1", "Re: Devis", "SENT"]]);
    expect(r1.upserts[1]!.attachments).toEqual([{ name: "facture.pdf", mime: "application/pdf", size: expect.any(Number), attachmentId: "0" }]);
    expect(r1.upserts[0]).toMatchObject({ fromAddr: "ann@x.com", fromName: "Ann", messageId: "<a@x>", bodyText: expect.stringContaining("devis") });
    expect(r1.cursor.folders["INBOX"]).toEqual({ validity: "7", lastUid: 2 });
    expect(log.at(-1)).toBe("logout"); // la connexion est toujours refermée

    // nouveau mail + suppression de l'UID 1
    inbox.msgs.set(3, rfc({ subject: "Nouveau", body: "salut", msgId: "d@x" })); inbox.uidNext = 4; inbox.msgs.delete(1);
    const known = r1.upserts.map((m) => m.id);
    const r2 = await syncImap(CFG, r1.cursor, known, { sinceMs: 0, max: 500, factory });
    expect(r2.upserts.map((m) => m.id)).toEqual(["INBOX:3"]);
    expect(r2.deletes).toEqual(["INBOX:1"]);

    // rien de nouveau : l'astuce « N:* » d'IMAP ne ramène pas le dernier mail une 2e fois
    const r3 = await syncImap(CFG, r2.cursor, [...known, "INBOX:3"].filter((x) => x !== "INBOX:1"), { sinceMs: 0, max: 500, factory });
    expect(r3.upserts).toEqual([]);

    // UIDVALIDITY changée : le dossier est relu, les anciens identifiants sont retirés
    inbox.validity = 99; inbox.msgs = new Map([[1, rfc({ subject: "Après migration", body: "x", msgId: "e@x" })]]); inbox.uidNext = 2;
    const r4 = await syncImap(CFG, r3.cursor, ["INBOX:2", "INBOX:3"], { sinceMs: 0, max: 500, factory });
    expect(r4.deletes.sort()).toEqual(["INBOX:2", "INBOX:3"]);
    expect(r4.upserts.map((m) => m.subject)).toEqual(["Après migration"]);
  });

  it("limite le nombre de mails de la première synchro ; télécharge une pièce jointe", async () => {
    const msgs = new Map<number, Buffer>();
    for (let i = 1; i <= 30; i++) msgs.set(i, rfc({ subject: `M${i}`, body: "x", msgId: `${i}@x`, attach: i === 30 }));
    const { factory } = fakeServer([{ path: "INBOX", validity: 1, uidNext: 31, msgs }]);
    const r = await syncImap(CFG, null, [], { sinceMs: 0, max: 10, factory });
    expect(r.upserts).toHaveLength(10);
    expect(r.upserts.at(-1)!.subject).toBe("M30");
    const buf = await fetchImapAttachment(CFG, "INBOX:30", r.upserts.at(-1)!.attachments[0]!, factory);
    expect(buf.toString()).toBe("%PDF-fake");
    await expect(fetchImapAttachment(CFG, "INBOX:1", { name: "x", mime: "x", size: 1, attachmentId: "0" }, factory)).rejects.toThrow(/introuvable/);
    expect(parseRemoteId(remoteId("Dossier:Sous", 12))).toEqual({ folder: "Dossier:Sous", uid: 12 });
  });
});

// ---------- SMTP (vrai serveur local) ----------

async function smtpServer(received: string[]) {
  const s = new SMTPServer({
    authOptional: false, allowInsecureAuth: true, disabledCommands: ["STARTTLS"],
    onAuth: (a, _s, cb) => (a.username === "moi@x.com" && a.password === "bon" ? cb(null, { user: 1 }) : cb(new Error("Identifiants invalides"))),
    onData(stream, _s, cb) { const c: Buffer[] = []; stream.on("data", (d) => c.push(d)); stream.on("end", () => { received.push(Buffer.concat(c).toString()); cb(); }); },
  });
  s.listen(0, "127.0.0.1");
  await once(s.server, "listening");
  return { s, port: (s.server.address() as AddressInfo).port };
}

describe("SMTP", () => {
  it("envoie une réponse dans le même fil, sans injection d'en-têtes", async () => {
    const got: string[] = [];
    const { s, port } = await smtpServer(got);
    try {
      const cfg = { host: "127.0.0.1", port, secure: false, user: "moi@x.com", pass: "bon", insecure: true };
      await testSmtp(cfg);
      await sendSmtp(cfg, { from: "moi@x.com", to: ["ann@x.com"], subject: "Re: Devis\r\nBcc: pirate@evil.com", text: "Merci, c'est valide.", inReplyTo: "<a@x>", references: ["<a@x>"] });
      expect(got).toHaveLength(1);
      expect(got[0]).toContain("In-Reply-To: <a@x>");
      expect(got[0]).toContain("Merci, c'est valide.");
      expect(got[0]).not.toMatch(/^Bcc:/im);
      expect(got[0]).toMatch(/Subject: Re: Devis Bcc: pirate@evil.com/);
      await expect(sendSmtp({ ...cfg, pass: "mauvais" }, { from: "moi@x.com", to: ["a@x.com"], subject: "s", text: "t" })).rejects.toThrow();
      expect(got).toHaveLength(1);
    } finally { s.close(); }
  });

  it("valide les messages et refuse une connexion non chiffrée vers un hôte distant", async () => {
    expect(() => sanitizeOutgoing({ from: "moi@x.com", to: [], subject: "s", text: "t" })).toThrow(/Destinataire/);
    expect(() => sanitizeOutgoing({ from: "moi@x.com", to: ["pas-un-mail"], subject: "s", text: "t" })).toThrow(/invalide/);
    expect(() => sanitizeOutgoing({ from: "moi@x.com", to: ["a@x.com"], subject: " ", text: "t" })).toThrow(/Objet/);
    expect(() => sanitizeOutgoing({ from: "moi@x.com", to: ["a@x.com"], subject: "s", text: " " })).toThrow(/vide/);
    await expect(testSmtp({ host: "smtp.exemple.com", port: 25, secure: false, user: "u", pass: "p", insecure: true })).rejects.toThrow(/refusée/);
    const raw = (await buildRfc822({ from: "moi@x.com", to: ["a@x.com"], subject: "é accentué", text: "corps" })).toString();
    expect(raw).toContain("MIME-Version: 1.0");
  });
});

// ---------- Microsoft Graph ----------

describe("Microsoft Graph", () => {
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

  it("parse les mails (texte, expéditeur, dossier) et les événements (UTC, journée entière, supprimés)", () => {
    const m = parseGraphMessage({ id: "m1", subject: "Devis", from: { emailAddress: { name: "Ann", address: "Ann@X.com" } }, toRecipients: [{ emailAddress: { address: "Moi@x.com" } }],
      receivedDateTime: "2026-03-10T08:00:00Z", bodyPreview: "aperçu", body: { contentType: "html", content: "<p>Bonjour&nbsp;<b>Paul</b></p>" }, conversationId: "c1", internetMessageId: "<id@x>" }, "inbox");
    expect(m).toMatchObject({ id: "m1", fromAddr: "ann@x.com", fromName: "Ann", to: "moi@x.com", bodyText: "Bonjour Paul", labels: ["INBOX"], messageId: "<id@x>", date: Date.parse("2026-03-10T08:00:00Z") });
    expect(parseGraphMessage({ id: "m2" }, "sentitems").labels).toEqual(["SENT"]);

    const e = parseGraphEvent({ id: "e1", subject: "Réunion", start: { dateTime: "2026-03-16T09:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-03-16T10:00:00.0000000", timeZone: "UTC" }, isAllDay: false, location: { displayName: "Salle B" }, webLink: "https://outlook.office.com/x" })!;
    expect(e).toMatchObject({ title: "Réunion", start: Date.parse("2026-03-16T09:00:00Z"), end: Date.parse("2026-03-16T10:00:00Z"), location: "Salle B", allDay: false });
    const ad = parseGraphEvent({ id: "e2", subject: "Férié", isAllDay: true, start: { dateTime: "2026-03-17T00:00:00.0000000" }, end: { dateTime: "2026-03-18T00:00:00.0000000" } })!;
    expect(ad).toMatchObject({ allDay: true, start: new Date(2026, 2, 17).getTime(), end: new Date(2026, 2, 18).getTime() });
    expect(parseGraphEvent({ id: "e3", "@removed": { reason: "deleted" } })).toMatchObject({ cancelled: true });
    expect(parseGraphEvent({ id: "e4", isCancelled: true })).toMatchObject({ cancelled: true });
    expect(parseGraphEvent({})).toBeNull();
  });

  it("flux delta paginé jusqu'au jeton final ; texte brut demandé ; jetons rafraîchis sur 401", async () => {
    const calls: { url: string; prefer: string | null; auth: string }[] = [];
    const g = new GraphClient({
      getAccessToken: async () => "vieux", refreshAccessToken: async () => "neuf", sleep: async () => {},
      fetch: (async (url: string, init: RequestInit) => {
        const h = init.headers as Record<string, string>;
        calls.push({ url, prefer: h.prefer ?? null, auth: h.authorization! });
        if (h.authorization === "Bearer vieux") return json({}, 401);
        if (!url.includes("page2")) return json({ value: [{ id: "a" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/page2" });
        return json({ value: [{ id: "b" }, { id: "c", "@removed": {} }], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta?token=T2" });
      }) as never,
    });
    const r = await g.mailDelta("inbox", null, "2026-02-01T00:00:00Z");
    expect(r.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(r.deltaLink).toContain("token=T2");
    expect(calls[0]!.url).toContain("/me/mailFolders/inbox/messages/delta");
    expect(calls[0]!.url).toContain("receivedDateTime%20ge%202026-02-01T00%3A00%3A00Z");
    expect(calls.at(-1)!.auth).toBe("Bearer neuf");
    expect(calls.at(-1)!.prefer).toContain('outlook.body-content-type="text"');
    // un lien delta ne doit jamais mener hors de Graph (exfiltration du jeton)
    await expect(g.mailDelta("inbox", "https://evil.example.com/steal", "x")).rejects.toThrow(/inattendue/);
  });

  it("pièces jointes, envoi (réponse via /reply) et écriture d'événements", async () => {
    const seen: { url: string; method: string; body: any }[] = [];
    const g = new GraphClient({
      getAccessToken: async () => "t",
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body as string) : null });
        if (url.endsWith("/$value")) return new Response(Buffer.from("PDFDATA"));
        if (url.includes("/attachments?")) return json({ value: [{ "@odata.type": "#microsoft.graph.fileAttachment", id: "att1", name: "devis.pdf", contentType: "application/pdf", size: 1234 }, { "@odata.type": "#microsoft.graph.itemAttachment", id: "x", name: "mail.eml" }] });
        if (url.endsWith("/me/events") ) return json({ id: "ev-new" });
        return new Response(null, { status: 202 });
      }) as never,
    });
    expect(await g.listAttachments("m1")).toEqual([{ name: "devis.pdf", mime: "application/pdf", size: 1234, attachmentId: "att1" }]);
    expect((await g.getAttachment("m1", "att1")).toString()).toBe("PDFDATA");
    await g.sendMail({ to: ["a@x.com"], subject: "Re", text: "Merci", replyToRemoteId: "m1" });
    expect(seen.at(-1)).toMatchObject({ url: expect.stringContaining("/me/messages/m1/reply"), method: "POST", body: { comment: "Merci" } });
    await g.sendMail({ to: ["a@x.com"], subject: "Salut", text: "Hello" });
    expect(seen.at(-1)!.body.message).toMatchObject({ subject: "Salut", toRecipients: [{ emailAddress: { address: "a@x.com" } }] });
    expect(await g.createEvent({ title: "Dîner", start: Date.parse("2026-05-04T18:00:00Z"), end: Date.parse("2026-05-04T20:00:00Z"), allDay: false, location: "Chez Paul" })).toBe("ev-new");
    expect(seen.at(-1)!.body).toMatchObject({ subject: "Dîner", start: { dateTime: "2026-05-04T18:00:00", timeZone: "UTC" }, location: { displayName: "Chez Paul" } });
    expect(microsoftEndpoints("contoso.onmicrosoft.com").tokenUrl).toContain("contoso.onmicrosoft.com");
    expect(microsoftEndpoints("../evil").authUrl).toContain("/common/"); // locataire invalide → « common »
  });
});

// ---------- CalDAV / ICS ----------

const ICS = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\n${body}\r\nEND:VCALENDAR\r\n`;
describe("ICS / CalDAV", () => {
  const W0 = Date.UTC(2026, 2, 1), W1 = Date.UTC(2026, 3, 30);

  it("événement simple, journée entière, fuseau horaire déclaré", () => {
    const ics = ICS(`BEGIN:VTIMEZONE\r\nTZID:Europe/Paris\r\nBEGIN:STANDARD\r\nDTSTART:19701025T030000\r\nRRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nEND:STANDARD\r\nBEGIN:DAYLIGHT\r\nDTSTART:19700329T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU\r\nTZOFFSETFROM:+0100\r\nTZOFFSETTO:+0200\r\nEND:DAYLIGHT\r\nEND:VTIMEZONE\r\n` +
      `BEGIN:VEVENT\r\nUID:u1\r\nSUMMARY:Réunion Paris\r\nDTSTART;TZID=Europe/Paris:20260316T100000\r\nDTEND;TZID=Europe/Paris:20260316T110000\r\nLOCATION:Salle B\r\nEND:VEVENT\r\n` +
      `BEGIN:VEVENT\r\nUID:u2\r\nSUMMARY:Férié\r\nDTSTART;VALUE=DATE:20260317\r\nDTEND;VALUE=DATE:20260318\r\nEND:VEVENT\r\n` +
      `BEGIN:VEVENT\r\nUID:u3\r\nSUMMARY:Annulé\r\nSTATUS:CANCELLED\r\nDTSTART:20260318T100000Z\r\nDTEND:20260318T110000Z\r\nEND:VEVENT`);
    const evs = parseIcs(ics, "https://dav/x.ics", W0, W1);
    expect(evs.map((e) => e.title)).toEqual(["Réunion Paris", "Férié"]);
    expect(evs[0]).toMatchObject({ start: Date.parse("2026-03-16T09:00:00Z"), end: Date.parse("2026-03-16T10:00:00Z"), location: "Salle B", allDay: false, remoteId: "https://dav/x.ics" });
    expect(evs[1]).toMatchObject({ allDay: true, start: new Date(2026, 2, 17).getTime(), end: new Date(2026, 2, 18).getTime() });
  });

  it("récurrences développées dans la fenêtre, exceptions et dates exclues respectées", () => {
    const ics = ICS(`BEGIN:VEVENT\r\nUID:r1\r\nSUMMARY:Point hebdo\r\nDTSTART:20260302T080000Z\r\nDTEND:20260302T083000Z\r\nRRULE:FREQ=WEEKLY;COUNT=6\r\nEXDATE:20260316T080000Z\r\nEND:VEVENT\r\n` +
      `BEGIN:VEVENT\r\nUID:r1\r\nRECURRENCE-ID:20260323T080000Z\r\nSUMMARY:Point hebdo (déplacé)\r\nDTSTART:20260323T140000Z\r\nDTEND:20260323T143000Z\r\nEND:VEVENT`);
    const evs = parseIcs(ics, "https://dav/r.ics", W0, W1).sort((a, b) => a.start - b.start);
    expect(evs.map((e) => new Date(e.start).toISOString().slice(0, 13))).toEqual(["2026-03-02T08", "2026-03-09T08", "2026-03-23T14", "2026-03-30T08", "2026-04-06T08"]); // COUNT=6 dont le 16 mars (exclu) ; le 23 mars est déplacé
    expect(evs[2]!.title).toBe("Point hebdo (déplacé)");
    expect(new Set(evs.map((e) => e.remoteId)).size).toBe(evs.length); // identifiants distincts par occurrence
    expect(parseIcs(ics, "u", Date.UTC(2026, 3, 7), Date.UTC(2026, 3, 8))).toEqual([]);
    expect(isRecurringIcs(ics)).toBe(true);
    expect(parseIcs("n'importe quoi", "u", W0, W1)).toEqual([]);
  });

  it("construit un ICS valide, relu à l'identique ; mise à jour d'un événement existant ; refus des séries", () => {
    const start = Date.parse("2026-05-04T18:00:00Z");
    const { ics, uid } = buildIcs({ title: "Dîner, avec; Paul", start, end: start + 2 * 3600_000, allDay: false, location: "Chez Paul", description: "Ligne 1\nLigne 2" });
    expect(ics).toContain(`UID:${uid}`);
    const [back] = parseIcs(ics, "u", start - DAY, start + DAY);
    expect(back).toMatchObject({ title: "Dîner, avec; Paul", start, end: start + 2 * 3600_000, location: "Chez Paul", description: "Ligne 1\nLigne 2" });

    const upd = updateIcs(ics, { title: "Dîner (reporté)", start: start + DAY, end: start + DAY + 3600_000, allDay: false });
    const [moved] = parseIcs(upd, "u", start, start + 3 * DAY);
    expect(moved).toMatchObject({ title: "Dîner (reporté)", start: start + DAY, location: "" });
    expect(upd).toContain(`UID:${uid}`); // même événement

    const day = new Date(2026, 5, 1).getTime();
    const [allDay] = parseIcs(buildIcs({ title: "Anniv", start: day, end: day + DAY, allDay: true }).ics, "u", day - DAY, day + 2 * DAY);
    expect(allDay).toMatchObject({ allDay: true, start: day, end: day + DAY });

    expect(() => updateIcs(ICS("BEGIN:VEVENT\r\nUID:z\r\nSUMMARY:S\r\nDTSTART:20260302T080000Z\r\nRRULE:FREQ=DAILY\r\nEND:VEVENT"), { title: "x", start, end: start, allDay: false })).toThrow(/récurrent/);
  });
});
