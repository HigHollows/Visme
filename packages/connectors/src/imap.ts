import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import type { MailAttachment, MailMessage } from "./gmail";
import { htmlToText } from "./html";

export interface ImapConfig {
  host: string;
  port: number;
  /** TLS implicite (993). Sinon STARTTLS est exigé : jamais d'authentification en clair. */
  secure: boolean;
  user: string;
  pass: string;
  /** Réservé aux tests sur la machine locale. */
  insecure?: boolean;
}

/** Surface minimale d'ImapFlow utilisée ici (permet de simuler un serveur dans les tests). */
export interface ImapLike {
  connect(): Promise<void>;
  list(): Promise<{ path: string; specialUse?: string }[]>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  readonly mailbox: { uidValidity: bigint | number; uidNext: number } | false;
  search(query: object, opts: { uid: true }): Promise<number[] | false>;
  fetch(range: string, query: object, opts: { uid: true }): AsyncIterable<{ uid: number; source?: Buffer }>;
  fetchOne(range: string, query: object, opts: { uid: true }): Promise<{ source?: Buffer } | false>;
  logout(): Promise<void>;
}
export type ImapFactory = (c: ImapConfig) => ImapLike;

const LOCAL = /^(localhost|127\.0\.0\.1|::1)$/;

export const realImapFactory: ImapFactory = (c) => {
  if (c.insecure && !LOCAL.test(c.host)) throw new Error("Connexion non chiffrée refusée (hôte distant)");
  return new ImapFlow({
    host: c.host, port: c.port, secure: c.secure, auth: { user: c.user, pass: c.pass }, logger: false,
    doSTARTTLS: c.secure ? undefined : c.insecure ? false : true, // STARTTLS obligatoire hors TLS implicite
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
  }) as unknown as ImapLike;
};

export interface ImapCursor {
  folders: Record<string, { validity: string; lastUid: number }>;
}

export interface ImapSyncResult {
  upserts: MailMessage[];
  /** Identifiants distants (« dossier:uid ») qui n'existent plus sur le serveur. */
  deletes: string[];
  cursor: ImapCursor;
}

const SENT_NAME = /^(sent|sent items|sent mail|envoy|éléments envoyés|gesendet|enviados)/i;
const MAX_SOURCE = 25 * 1024 * 1024;

export const remoteId = (folder: string, uid: number) => `${folder}:${uid}`;
export const parseRemoteId = (id: string) => {
  const i = id.lastIndexOf(":");
  return { folder: id.slice(0, i), uid: Number(id.slice(i + 1)) };
};

function toMessage(parsed: ParsedMail, folder: string, uid: number, sent: boolean): MailMessage {
  const from = parsed.from?.value?.[0];
  const to = (Array.isArray(parsed.to) ? parsed.to : parsed.to ? [parsed.to] : []).flatMap((t) => t.value.map((v) => v.address ?? "")).filter(Boolean);
  const text = (parsed.text?.trim() ? parsed.text : parsed.html ? htmlToText(String(parsed.html)) : "").slice(0, 200_000);
  const attachments: MailAttachment[] = (parsed.attachments ?? [])
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => a.contentDisposition !== "inline" || a.filename)
    .map(({ a, i }) => ({ name: a.filename ?? `pièce-jointe-${i + 1}`, mime: a.contentType ?? "application/octet-stream", size: a.size ?? 0, attachmentId: String(i) }));
  return {
    id: remoteId(folder, uid),
    threadId: String(parsed.inReplyTo ?? parsed.messageId ?? remoteId(folder, uid)),
    subject: parsed.subject || "(sans objet)",
    fromName: from?.name ?? "",
    fromAddr: (from?.address ?? "").toLowerCase(),
    to: to.join(", "),
    date: parsed.date?.getTime() ?? 0,
    snippet: text.replace(/\s+/g, " ").slice(0, 200),
    bodyText: text,
    labels: [sent ? "SENT" : "INBOX"],
    attachments,
    messageId: parsed.messageId,
  };
}

export async function withImap<T>(cfg: ImapConfig, factory: ImapFactory, fn: (c: ImapLike) => Promise<T>): Promise<T> {
  const c = factory(cfg);
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.logout().catch(() => {});
  }
}

/** Teste la connexion (identifiants et dossiers) sans rien lire. */
export async function testImap(cfg: ImapConfig, factory: ImapFactory = realImapFactory) {
  return withImap(cfg, factory, async (c) => ({ folders: (await c.list()).length }));
}

/**
 * Synchronise INBOX et le dossier « Envoyés » : état initial (mails récents), puis uniquement les nouveaux UID.
 * Si l'UIDVALIDITY change, le dossier est relu. `known` = identifiants déjà stockés, pour détecter les suppressions.
 */
export async function syncImap(
  cfg: ImapConfig,
  cursor: ImapCursor | null,
  known: string[],
  opts: { sinceMs: number; max: number; factory?: ImapFactory },
): Promise<ImapSyncResult> {
  return withImap(cfg, opts.factory ?? realImapFactory, async (c) => {
    const boxes = await c.list();
    const sentPath = boxes.find((b) => b.specialUse === "\\Sent")?.path ?? boxes.find((b) => SENT_NAME.test(b.path))?.path;
    const folders = [{ path: "INBOX", sent: false }, ...(sentPath ? [{ path: sentPath, sent: true }] : [])];
    const next: ImapCursor = { folders: {} };
    const upserts: MailMessage[] = [];
    const deletes: string[] = [];

    for (const f of folders) {
      const lock = await c.getMailboxLock(f.path);
      try {
        const box = c.mailbox;
        if (!box) continue;
        const validity = String(box.uidValidity);
        const prev = cursor?.folders[f.path];
        const reset = !prev || prev.validity !== validity;

        let uids: number[];
        if (reset) {
          // Nouveau dossier ou UIDVALIDITY modifiée : les anciens UID ne signifient plus rien.
          if (prev) deletes.push(...known.filter((id) => parseRemoteId(id).folder === f.path));
          const found = (await c.search({ since: new Date(opts.sinceMs) }, { uid: true })) || [];
          uids = found.sort((a, b) => a - b).slice(-opts.max);
        } else {
          const found = (await c.search({ uid: `${prev.lastUid + 1}:*` }, { uid: true })) || [];
          uids = found.filter((u) => u > prev.lastUid).sort((a, b) => a - b);
        }

        let lastUid = reset ? 0 : prev!.lastUid;
        for (let i = 0; i < uids.length; i += 50) {
          const batch = uids.slice(i, i + 50);
          for await (const m of c.fetch(batch.join(","), { uid: true, source: true }, { uid: true })) {
            lastUid = Math.max(lastUid, m.uid);
            if (!m.source || m.source.length > MAX_SOURCE) continue;
            upserts.push(toMessage(await simpleParser(m.source), f.path, m.uid, f.sent));
          }
        }
        if (!uids.length && reset) lastUid = Math.max(0, Number(box.uidNext) - 1);
        next.folders[f.path] = { validity, lastUid };

        // Suppressions : ce qui était stocké mais n'existe plus côté serveur.
        if (!reset) {
          const all = new Set(((await c.search({ all: true }, { uid: true })) || []).map(Number));
          deletes.push(...known.filter((id) => { const p = parseRemoteId(id); return p.folder === f.path && !all.has(p.uid); }));
        }
      } finally {
        lock.release();
      }
    }
    return { upserts, deletes: [...new Set(deletes)], cursor: next };
  });
}

/** Télécharge une pièce jointe d'un mail (relit le message : IMAP n'indexe pas les pièces jointes). */
export async function fetchImapAttachment(cfg: ImapConfig, id: string, att: MailAttachment, factory: ImapFactory = realImapFactory): Promise<Buffer> {
  const { folder, uid } = parseRemoteId(id);
  return withImap(cfg, factory, async (c) => {
    const lock = await c.getMailboxLock(folder);
    try {
      const m = await c.fetchOne(String(uid), { source: true }, { uid: true });
      if (!m || !m.source) throw new Error("Message introuvable sur le serveur");
      const parsed = await simpleParser(m.source);
      const a = (parsed.attachments ?? [])[Number(att.attachmentId)];
      if (!a?.content) throw new Error("Pièce jointe introuvable");
      return Buffer.from(a.content);
    } finally {
      lock.release();
    }
  });
}
