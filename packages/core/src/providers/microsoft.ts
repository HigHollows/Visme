import {
  GraphClient, GraphError, parseGraphEvent, parseGraphMessage,
  type EventWrite, type FetchFn, type MailAttachment, type MailMessage,
} from "@assistant/connectors";
import type { CalendarProvider, MailProvider, OutgoingReply } from "./types";

interface Common {
  getAccessToken: () => Promise<string>;
  refreshAccessToken: () => Promise<string>;
  fetch?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
}

const FOLDERS = ["inbox", "sentitems"] as const;

export function microsoftMail(c: Common, canSend: boolean): MailProvider {
  const g = new GraphClient(c);
  const provider: MailProvider = {
    async sync(cursor) {
      const links: Partial<Record<(typeof FOLDERS)[number], string>> = cursor ? JSON.parse(cursor) : {};
      const since = new Date(Date.now() - 30 * 86_400_000).toISOString().replace(/\.\d+Z$/, "Z");
      const upserts: MailMessage[] = [];
      const deleteIds: string[] = [];
      const next: typeof links = {};
      for (const folder of FOLDERS) {
        let r;
        try {
          r = await g.mailDelta(folder, links[folder] ?? null, since);
        } catch (e) {
          // Jeton delta expiré : on repart de zéro pour ce dossier.
          if (e instanceof GraphError && e.status === 410) r = await g.mailDelta(folder, null, since);
          else throw e;
        }
        for (const item of r.items) {
          if (item["@removed"]) { deleteIds.push(String(item.id)); continue; }
          const atts = item.hasAttachments ? await g.listAttachments(String(item.id)).catch(() => [] as MailAttachment[]) : [];
          upserts.push(parseGraphMessage(item, folder, atts));
        }
        next[folder] = r.deltaLink;
      }
      return { upserts, deleteIds, cursor: JSON.stringify(next) };
    },
    fetchAttachment: (remoteId, att) => g.getAttachment(remoteId, att.attachmentId),
  };
  if (canSend)
    provider.send = async (m: OutgoingReply) => {
      // Répondre à l'expéditeur seul : /reply conserve le fil ; sinon, envoi simple.
      const onlySender = m.replyTo?.senderAddr && m.to.length === 1 && !m.cc?.length && m.to[0]!.toLowerCase() === m.replyTo.senderAddr.toLowerCase();
      await g.sendMail({ to: m.to, cc: m.cc, subject: m.subject, text: m.text, replyToRemoteId: onlySender ? m.replyTo!.remoteId : undefined });
    };
  return provider;
}

export function microsoftCalendar(c: Common, canWrite: boolean): CalendarProvider {
  const g = new GraphClient(c);
  const provider: CalendarProvider = {
    async sync(cursor, win) {
      const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
      let full = !cursor;
      let r;
      try {
        r = await g.calendarDelta(cursor, iso(win.from), iso(Math.min(win.to, win.from + 360 * 86_400_000)));
      } catch (e) {
        if (!(e instanceof GraphError && e.status === 410 && cursor)) throw e;
        full = true;
        r = await g.calendarDelta(null, iso(win.from), iso(Math.min(win.to, win.from + 360 * 86_400_000)));
      }
      const events = r.items.map(parseGraphEvent).filter((e): e is NonNullable<typeof e> => !!e);
      return { events, cursor: r.deltaLink, full };
    },
  };
  if (canWrite) {
    provider.create = (e: EventWrite) => g.createEvent(e);
    provider.update = (id, e) => g.updateEvent(id, e);
    provider.remove = (id) => g.deleteEvent(id);
  }
  return provider;
}
