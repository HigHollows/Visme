import type { CalEvent, EventWrite, MailAttachment, MailMessage } from "@assistant/connectors";

export interface MailSyncOut {
  upserts: MailMessage[];
  /** Identifiants distants à supprimer de la base locale. */
  deleteIds: string[];
  /** État à conserver pour la prochaine synchro incrémentale (opaque). */
  cursor: string;
}

export interface OutgoingReply {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  /** Mail auquel on répond (conserve le fil de discussion). */
  replyTo?: { remoteId: string; messageId?: string; threadId?: string; senderAddr?: string };
}

export interface MailProvider {
  sync(cursor: string | null, knownRemoteIds: string[]): Promise<MailSyncOut>;
  fetchAttachment(remoteId: string, att: MailAttachment): Promise<Buffer>;
  /** Absent si le compte ne peut pas envoyer. Action sensible : appelée uniquement après validation explicite. */
  send?(m: OutgoingReply): Promise<void>;
}

export interface CalSyncOut {
  events: CalEvent[];
  cursor: string;
  /** Vrai : `events` est l'état complet (les événements distants absents sont supprimés). Faux : simples changements. */
  full: boolean;
  /** Rien n'a changé côté serveur : ne rien modifier. */
  unchanged?: boolean;
}

export interface CalendarProvider {
  sync(cursor: string | null, win: { from: number; to: number }): Promise<CalSyncOut>;
  create?(e: EventWrite): Promise<string>;
  update?(remoteId: string, e: EventWrite): Promise<void>;
  remove?(remoteId: string): Promise<void>;
}

export const CAL_ID: Record<string, string> = { google: "primary", microsoft: "primary", caldav: "default" };

export async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]!);
    }),
  );
}
