import {
  buildIcs, createRealDav, fetchImapAttachment, parseIcs, sendSmtp, syncImap, updateIcs,
  type CalDavConfig, type DavLike, type EventWrite, type ImapConfig, type ImapCursor, type ImapFactory, type SmtpConfig,
} from "@assistant/connectors";
import type { CalendarProvider, MailProvider, OutgoingReply } from "./types";

export interface ImapAccountConfig {
  imap: ImapConfig;
  smtp?: SmtpConfig;
}

export function imapMail(cfg: ImapAccountConfig, email: string, factory?: ImapFactory): MailProvider {
  const provider: MailProvider = {
    async sync(cursor, known) {
      const r = await syncImap(cfg.imap, cursor ? (JSON.parse(cursor) as ImapCursor) : null, known, {
        sinceMs: Date.now() - 30 * 86_400_000, max: 500, factory,
      });
      return { upserts: r.upserts, deleteIds: r.deletes, cursor: JSON.stringify(r.cursor) };
    },
    fetchAttachment: (remoteId, att) => fetchImapAttachment(cfg.imap, remoteId, att, factory),
  };
  if (cfg.smtp) {
    const smtp = cfg.smtp;
    provider.send = (m: OutgoingReply) =>
      sendSmtp(smtp, {
        from: email, to: m.to, cc: m.cc, subject: m.subject, text: m.text,
        inReplyTo: m.replyTo?.messageId, references: m.replyTo?.messageId ? [m.replyTo.messageId] : undefined,
      });
  }
  return provider;
}

export function caldavCalendar(cfg: CalDavConfig, dav?: () => Promise<DavLike>): CalendarProvider {
  const open = dav ?? (() => createRealDav(cfg));
  const baseUrl = (remoteId: string) => {
    if (remoteId.includes("#")) throw new Error("Occurrence d'une série récurrente : modifiez-la dans votre application d'agenda.");
    return remoteId;
  };
  return {
    async sync(cursor, win) {
      const d = await open();
      const ctag = await d.ctag();
      // Même ctag = aucun changement côté serveur : on évite de tout relire.
      if (ctag && ctag === cursor) return { events: [], cursor: ctag, full: false, unchanged: true };
      const objs = await d.fetchObjects({ start: new Date(win.from).toISOString(), end: new Date(win.to).toISOString() });
      const events = objs.flatMap((o) => parseIcs(o.data, o.url, win.from, win.to));
      return { events, cursor: ctag ?? String(Date.now()), full: true };
    },
    async create(e: EventWrite) {
      const { ics, uid } = buildIcs(e);
      return (await open()).create(`${uid}.ics`, ics);
    },
    async update(remoteId, e) {
      const d = await open();
      const url = baseUrl(remoteId);
      const cur = await d.get(url);
      if (!cur) throw new Error("Événement introuvable sur le serveur");
      await d.update({ url, etag: cur.etag, data: updateIcs(cur.data, e) });
    },
    async remove(remoteId) {
      const d = await open();
      const url = baseUrl(remoteId);
      const cur = await d.get(url);
      await d.remove({ url, etag: cur?.etag });
    },
  };
}
