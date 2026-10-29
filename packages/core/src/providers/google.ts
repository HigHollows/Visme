import {
  CalendarClient, GmailClient, HistoryExpiredError, SyncTokenExpiredError, buildRfc822,
  type EventWrite, type FetchFn, type MailAttachment, type MailMessage,
} from "@assistant/connectors";
import { CAL_ID, pool, type CalendarProvider, type MailProvider, type OutgoingReply } from "./types";

const INITIAL_QUERY = "newer_than:30d";
const INITIAL_MAX = 500;
const CONCURRENCY = 5;

interface Common {
  getAccessToken: () => Promise<string>;
  refreshAccessToken: () => Promise<string>;
  fetch?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
}

export function googleMail(c: Common, email: string, canSend: boolean): MailProvider {
  const gmail = new GmailClient(c);
  const fetchMany = async (ids: string[]) => {
    const out: MailMessage[] = [];
    await pool(ids, CONCURRENCY, async (id) => {
      const m = await gmail.getMessage(id);
      if (m) out.push(m);
    });
    return out;
  };
  const provider: MailProvider = {
    async sync(cursor) {
      let historyId = cursor;
      let upserts: MailMessage[] = [];
      let deleteIds: string[] = [];
      let full = !cursor;
      if (cursor) {
        try {
          const ch = await gmail.changesSince(cursor);
          upserts = await fetchMany(ch.added);
          deleteIds = ch.deleted;
          historyId = ch.historyId;
        } catch (e) {
          if (!(e instanceof HistoryExpiredError)) throw e;
          full = true;
        }
      }
      if (full) {
        // Point de départ relevé AVANT de lister : aucun mail arrivé pendant la synchro n'est raté.
        const profile = await gmail.profile();
        upserts = await fetchMany(await gmail.listIds(INITIAL_QUERY, INITIAL_MAX));
        deleteIds = [];
        historyId = profile.historyId;
      }
      return { upserts, deleteIds, cursor: historyId! };
    },
    fetchAttachment: (remoteId: string, att: MailAttachment) => gmail.getAttachment(remoteId, att.attachmentId),
  };
  if (canSend)
    provider.send = async (m: OutgoingReply) => {
      const raw = await buildRfc822({
        from: email, to: m.to, cc: m.cc, subject: m.subject, text: m.text,
        inReplyTo: m.replyTo?.messageId, references: m.replyTo?.messageId ? [m.replyTo.messageId] : undefined,
      });
      await gmail.sendRaw(raw, m.replyTo?.threadId);
    };
  return provider;
}

export function googleCalendar(c: Common, canWrite: boolean): CalendarProvider {
  const cal = new CalendarClient(c);
  const id = CAL_ID.google!;
  const provider: CalendarProvider = {
    async sync(cursor, win) {
      if (cursor) {
        try {
          const r = await cal.sync(id, { syncToken: cursor });
          return { events: r.events, cursor: r.syncToken, full: false };
        } catch (e) {
          if (!(e instanceof SyncTokenExpiredError)) throw e;
        }
      }
      const r = await cal.sync(id, { timeMin: new Date(win.from).toISOString(), timeMax: new Date(win.to).toISOString() });
      return { events: r.events, cursor: r.syncToken, full: true };
    },
  };
  if (canWrite) {
    provider.create = (e: EventWrite) => cal.createEvent(id, e);
    provider.update = (rid: string, e: EventWrite) => cal.updateEvent(id, rid, e);
    provider.remove = (rid: string) => cal.deleteEvent(id, rid);
  }
  return provider;
}
