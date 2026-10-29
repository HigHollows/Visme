import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { type FetchFn, type MailAttachment, type MailMessage } from "@assistant/connectors";
import { audit, type Db } from "@assistant/db";
import type { Settings } from "@assistant/schemas";
import { featuresOf, type AccountService } from "./accounts";
import { isSupported } from "./documents/extract";

const ATTACH_MAX_BYTES = 15 * 1024 * 1024;
const ATTACH_MAX_PER_MAIL = 5;
const IMAGE_MIN_BYTES = 20 * 1024; // en dessous : logos et pixels de signature
const SEND_LIMIT_PER_HOUR = 20;

export interface MailDeps {
  db: Db;
  accounts: AccountService;
  dataDir: () => string;
  settings: () => Settings;
  notify: (method: string, params: unknown) => void;
  /** Indexe un fichier (pièce jointe) comme document, avec le lien vers son mail. */
  documents: { add(path: string, opts?: { sourceRef?: { type: string; id: string } }): Promise<{ id: string; duplicate: boolean }> };
  fetch?: FetchFn;
  now?: () => number;
}

interface StoredAttachment extends MailAttachment {
  documentId?: string;
}

const safeName = (n: string) =>
  basename(n.replace(/[\\/\0-\x1f<>:"|?*]/g, "_")).replace(/^\.+/, "").slice(0, 120) || "piece-jointe";

export class MailService {
  private syncing = new Set<string>();

  constructor(private d: MailDeps) {}

  private now() {
    return (this.d.now ?? Date.now)();
  }

  // --- synchronisation ---

  /** Lance la synchro en arrière-plan ; l'avancement est notifié via `mail.event`. */
  startSync(accountId: string): boolean {
    const row = this.d.db.prepare("SELECT provider, tokens FROM accounts WHERE id=?").get(accountId) as { provider: string; tokens: string } | undefined;
    if (!row || !featuresOf(row).mail) return false; // compte sans accès au mail (calendrier seul)
    if (this.syncing.has(accountId)) return false;
    this.syncing.add(accountId);
    // L'erreur est déjà enregistrée sur le compte et notifiée à l'UI : on ne la laisse pas remonter en « unhandled rejection ».
    void this.sync(accountId)
      .catch(() => {})
      .finally(() => this.syncing.delete(accountId));
    return true;
  }

  /** Synchronise et attend la fin ; renvoie null si une synchro de ce compte est déjà en cours. */
  async syncNow(accountId: string) {
    if (this.syncing.has(accountId)) return null;
    this.syncing.add(accountId);
    try {
      return await this.sync(accountId);
    } finally {
      this.syncing.delete(accountId);
    }
  }

  private upsert(accountId: string, m: MailMessage) {
    this.d.db
      .prepare(
        `INSERT INTO mails(id, account_id, remote_id, thread_id, subject, from_name, from_addr, to_addrs, date, snippet, body, labels, attachments, rfc_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET subject=excluded.subject, from_name=excluded.from_name, from_addr=excluded.from_addr,
           to_addrs=excluded.to_addrs, date=excluded.date, snippet=excluded.snippet, body=excluded.body,
           labels=excluded.labels, rfc_id=excluded.rfc_id,
           attachments=CASE WHEN excluded.attachments = '[]' THEN mails.attachments ELSE excluded.attachments END`,
      )
      .run(
        `${accountId}:${m.id}`, accountId, m.id, m.threadId, m.subject, m.fromName, m.fromAddr, m.to, m.date,
        m.snippet, m.bodyText, JSON.stringify(m.labels), JSON.stringify(m.attachments), m.messageId ?? null, this.now(),
      );
  }

  async sync(accountId: string): Promise<{ added: number; deleted: number }> {
    const db = this.d.db;
    const acc = db.prepare("SELECT id, history_id FROM accounts WHERE id=?").get(accountId) as { id: string; history_id: string | null } | undefined;
    if (!acc) throw new Error("Compte introuvable");
    db.prepare("UPDATE accounts SET sync_status='syncing', sync_error=NULL WHERE id=?").run(accountId);
    this.d.notify("mail.event", { accountId, status: "syncing" });
    try {
      const provider = this.d.accounts.mailProvider(accountId);
      if (!provider) throw new Error("Ce compte n'a pas accès au mail");
      const known = (db.prepare("SELECT remote_id AS r FROM mails WHERE account_id=?").all(accountId) as { r: string }[]).map((x) => x.r);
      const out = await provider.sync(acc.history_id, known);
      let deleted = 0;
      db.transaction(() => {
        for (const m of out.upserts) this.upsert(accountId, m);
        for (const id of out.deleteIds) deleted += Number(db.prepare("DELETE FROM mails WHERE id=?").run(`${accountId}:${id}`).changes);
        db.prepare("UPDATE accounts SET history_id=?, sync_status='idle', last_sync_at=? WHERE id=?").run(out.cursor, this.now(), accountId);
      })();
      const added = out.upserts.length;
      if (added || deleted) audit(db, "ai", "mail.sync", { accountId, added, deleted });
      this.d.notify("mail.event", { accountId, status: "done", added, deleted });
      return { added, deleted };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      db.prepare("UPDATE accounts SET sync_status='error', sync_error=? WHERE id=?").run(message, accountId);
      this.d.notify("mail.event", { accountId, status: "error", error: message });
      throw e;
    }
  }

  // --- lecture ---

  list(p: { accountId?: string; q?: string; limit?: number; offset?: number }) {
    const limit = Math.min(p.limit ?? 50, 200);
    const where: string[] = [];
    const args: unknown[] = [];
    let from = "mails m";
    if (p.q?.trim()) {
      const fts = ftsExpr(p.q);
      if (!fts) return [];
      from = "mails m JOIN mails_fts ON mails_fts.rowid = m.rowid";
      where.push("mails_fts MATCH ?");
      args.push(fts);
    }
    if (p.accountId) (where.push("m.account_id = ?"), args.push(p.accountId));
    return this.d.db
      .prepare(
        `SELECT m.id, m.account_id AS accountId, m.subject, m.from_name AS fromName, m.from_addr AS fromAddr, m.date,
                m.snippet, m.category, json_array_length(m.attachments) AS attachmentCount
         FROM ${from} ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY m.date DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, p.offset ?? 0);
  }

  get(id: string) {
    const r = this.d.db
      .prepare(
        `SELECT id, account_id AS accountId, subject, from_name AS fromName, from_addr AS fromAddr, to_addrs AS toAddrs,
                date, body, attachments, category, summary, labels FROM mails WHERE id=?`,
      )
      .get(id) as any;
    if (!r) throw new Error("Mail introuvable");
    return { ...r, attachments: JSON.parse(r.attachments) as StoredAttachment[], labels: JSON.parse(r.labels) as string[] };
  }

  // --- pièces jointes ---

  /**
   * Télécharge les pièces jointes exploitables d'un mail (formats pris en charge, ≤ 15 Mo) et les indexe comme documents,
   * reliés au mail. Les petites images (logos) et les formats inconnus sont ignorés ; les doublons sont écartés par empreinte.
   */
  async importAttachments(mailId: string): Promise<{ imported: number; skipped: { name: string; reason: string }[] }> {
    const db = this.d.db;
    const row = db.prepare("SELECT account_id AS accountId, remote_id AS remoteId, attachments FROM mails WHERE id=?").get(mailId) as
      | { accountId: string; remoteId: string; attachments: string }
      | undefined;
    if (!row) throw new Error("Mail introuvable");
    const atts = JSON.parse(row.attachments) as StoredAttachment[];
    const skipped: { name: string; reason: string }[] = [];
    if (!atts.length) return { imported: 0, skipped };
    const provider = this.d.accounts.mailProvider(row.accountId);
    if (!provider) throw new Error("Ce compte n'a pas accès au mail");
    const hasOcr = !!this.d.settings().ai.routes.ocr;
    const dir = join(this.d.dataDir(), "attachments", createHash("sha1").update(mailId).digest("hex").slice(0, 16));
    let imported = 0;

    for (const [i, a] of atts.entries()) {
      if (a.documentId) continue;
      const image = /^image\//.test(a.mime);
      if (!isSupported(a.name)) { skipped.push({ name: a.name, reason: "format non pris en charge" }); continue; }
      if (a.size > ATTACH_MAX_BYTES) { skipped.push({ name: a.name, reason: "trop volumineuse (15 Mo max)" }); continue; }
      if (image && a.size > 0 && a.size < IMAGE_MIN_BYTES) { skipped.push({ name: a.name, reason: "image trop petite (logo ?)" }); continue; }
      if (image && !hasOcr) { skipped.push({ name: a.name, reason: "image : configurez une route « OCR »" }); continue; }
      if (imported >= ATTACH_MAX_PER_MAIL) { skipped.push({ name: a.name, reason: `limite de ${ATTACH_MAX_PER_MAIL} pièces jointes par mail` }); continue; }
      try {
        const buf = await provider.fetchAttachment(row.remoteId, a);
        if (!buf.length || buf.length > ATTACH_MAX_BYTES) throw new Error("contenu vide ou trop volumineux");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${i}-${safeName(a.name)}`);
        writeFileSync(file, buf);
        const doc = await this.d.documents.add(file, { sourceRef: { type: "mail", id: mailId } });
        a.documentId = doc.id;
        imported++;
      } catch (e) {
        skipped.push({ name: a.name, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    db.prepare("UPDATE mails SET attachments=? WHERE id=?").run(JSON.stringify(atts), mailId);
    if (imported) audit(db, "ai", "mail.attachments", { mailId, imported });
    return { imported, skipped };
  }

  // --- envoi (action sensible) ---

  /**
   * Envoie un brouillon de réponse. Trois verrous : réglage « autoriser l'envoi » activé, compte autorisé à envoyer,
   * et confirmation explicite de l'utilisateur pour CE message. Jamais appelé par l'agent, un plugin ou le chat.
   */
  async sendDraft(p: { draftId: string; to?: string[]; cc?: string[]; subject?: string; confirm: boolean }) {
    if (p.confirm !== true) throw new Error("Confirmation explicite requise avant tout envoi.");
    if (!this.d.settings().mail.allowSend) throw new Error("L'envoi est désactivé (Settings › Comptes › « Autoriser l'envoi de mails »).");
    const db = this.d.db;
    const sentLastHour = (db.prepare("SELECT count(*) AS n FROM audit_log WHERE action='mail.send' AND at > ?").get(this.now() - 3600_000) as { n: number }).n;
    if (sentLastHour >= SEND_LIMIT_PER_HOUR) throw new Error(`Limite de sécurité atteinte (${SEND_LIMIT_PER_HOUR} envois par heure).`);

    const dr = db.prepare("SELECT id, mail_id AS mailId, body, sent_at AS sentAt FROM drafts WHERE id=?").get(p.draftId) as
      | { id: string; mailId: string; body: string; sentAt: number | null }
      | undefined;
    if (!dr) throw new Error("Brouillon introuvable");
    if (dr.sentAt) throw new Error("Ce brouillon a déjà été envoyé.");
    const mail = db.prepare("SELECT account_id AS accountId, remote_id AS remoteId, thread_id AS threadId, subject, from_addr AS fromAddr, rfc_id AS rfcId FROM mails WHERE id=?").get(dr.mailId) as any;
    if (!mail) throw new Error("Mail d'origine introuvable");
    const provider = this.d.accounts.mailProvider(mail.accountId);
    if (!provider?.send) throw new Error("Ce compte n'est pas autorisé à envoyer (reconnectez-le avec l'envoi activé, ou renseignez le serveur SMTP).");
    const account = this.d.accounts.row(mail.accountId);

    const to = (p.to?.length ? p.to : [mail.fromAddr]).map((x) => String(x).trim());
    const subject = (p.subject?.trim() || (/^re\s*:/i.test(mail.subject) ? mail.subject : `Re: ${mail.subject}`)).slice(0, 300);
    await provider.send({
      from: account.email, to, cc: p.cc, subject, text: dr.body,
      replyTo: { remoteId: mail.remoteId, messageId: mail.rfcId ?? undefined, threadId: mail.threadId ?? undefined, senderAddr: mail.fromAddr },
    });
    db.prepare("UPDATE drafts SET sent_at=? WHERE id=?").run(this.now(), dr.id);
    // Journal : destinataires et objet, jamais le corps du message.
    audit(db, "user", "mail.send", { mailId: dr.mailId, accountId: mail.accountId, to, subject });
    return { sent: true, to };
  }
}

function ftsExpr(q: string): string | null {
  const words = q.normalize("NFKC").match(/[\p{L}\p{N}]{2,}/gu);
  return words?.length ? words.slice(0, 12).map((w, i, a) => (i === a.length - 1 ? `"${w}"*` : `"${w}"`)).join(" AND ") : null;
}

void extname;
