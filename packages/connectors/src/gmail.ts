import { htmlToText } from "./html";
import type { FetchFn } from "./oauth";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_BODY = 200_000;

export interface MailAttachment {
  name: string;
  mime: string;
  size: number;
  attachmentId: string;
}

export interface MailMessage {
  id: string;
  threadId: string;
  subject: string;
  fromName: string;
  fromAddr: string;
  to: string;
  /** Epoch ms */
  date: number;
  snippet: string;
  bodyText: string;
  labels: string[];
  attachments: MailAttachment[];
}

export class HistoryExpiredError extends Error {
  constructor() {
    super("Historique Gmail expiré : resynchronisation complète nécessaire");
  }
}

export class GmailError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface GmailOptions {
  getAccessToken: () => Promise<string>;
  /** Appelé après un 401 pour obtenir un jeton frais. */
  refreshAccessToken?: () => Promise<string>;
  fetch?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
}

export function parseAddress(raw: string): { name: string; addr: string } {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1]!.trim(), addr: m[2]!.trim().toLowerCase() };
  return { name: "", addr: raw.trim().toLowerCase() };
}

const decode = (data: string) => Buffer.from(data, "base64url").toString("utf8");

interface Part {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: Part[];
}

export function parseMessage(m: any): MailMessage {
  const payload: Part = m.payload ?? {};
  const header = (n: string) =>
    payload.headers?.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? "";

  let plain = "";
  let html = "";
  const attachments: MailAttachment[] = [];
  const walk = (p: Part) => {
    if (p.filename && p.body?.attachmentId) {
      attachments.push({ name: p.filename, mime: p.mimeType ?? "application/octet-stream", size: p.body.size ?? 0, attachmentId: p.body.attachmentId });
    } else if (p.mimeType === "text/plain" && p.body?.data) plain += decode(p.body.data);
    else if (p.mimeType === "text/html" && p.body?.data) html += decode(p.body.data);
    p.parts?.forEach(walk);
  };
  walk(payload);

  const from = parseAddress(header("From"));
  const body = (plain.trim() ? plain : htmlToText(html)).slice(0, MAX_BODY);
  return {
    id: m.id,
    threadId: m.threadId,
    subject: header("Subject") || "(sans objet)",
    fromName: from.name,
    fromAddr: from.addr,
    to: header("To"),
    date: Number(m.internalDate) || Date.parse(header("Date")) || 0,
    snippet: String(m.snippet ?? ""),
    bodyText: body,
    labels: m.labelIds ?? [],
    attachments,
  };
}

export class GmailClient {
  private f: FetchFn;
  private sleep: (ms: number) => Promise<void>;

  constructor(private o: GmailOptions) {
    this.f = o.fetch ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async req(path: string, retried = false): Promise<any> {
    let token = await this.o.getAccessToken();
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const res = await this.f(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
      if (res.ok) return res.json();
      if (res.status === 401 && !refreshed && this.o.refreshAccessToken) {
        token = await this.o.refreshAccessToken();
        refreshed = true;
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        const ra = Number(res.headers.get("retry-after"));
        await this.sleep(Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** attempt, 30_000));
        continue;
      }
      throw new GmailError(`Gmail ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status);
    }
  }

  async profile(): Promise<{ email: string; historyId: string }> {
    const p = await this.req("/profile");
    return { email: p.emailAddress, historyId: String(p.historyId) };
  }

  async listIds(query: string, max: number): Promise<string[]> {
    const ids: string[] = [];
    let pageToken = "";
    while (ids.length < max) {
      const qs = new URLSearchParams({ q: query, maxResults: String(Math.min(100, max - ids.length)) });
      if (pageToken) qs.set("pageToken", pageToken);
      const r = await this.req(`/messages?${qs}`);
      for (const m of r.messages ?? []) ids.push(m.id);
      if (!r.nextPageToken) break;
      pageToken = r.nextPageToken;
    }
    return ids;
  }

  async getMessage(id: string): Promise<MailMessage | null> {
    try {
      return parseMessage(await this.req(`/messages/${encodeURIComponent(id)}?format=full`));
    } catch (e) {
      if (e instanceof GmailError && e.status === 404) return null; // supprimé entre-temps
      throw e;
    }
  }

  /** Changements depuis `historyId` : ids ajoutés et supprimés. */
  async changesSince(historyId: string): Promise<{ added: string[]; deleted: string[]; historyId: string }> {
    const added = new Set<string>();
    const deleted = new Set<string>();
    let latest = historyId;
    let pageToken = "";
    try {
      do {
        const qs = new URLSearchParams({ startHistoryId: historyId });
        qs.append("historyTypes", "messageAdded");
        qs.append("historyTypes", "messageDeleted");
        if (pageToken) qs.set("pageToken", pageToken);
        const r = await this.req(`/history?${qs}`);
        if (r.historyId) latest = String(r.historyId);
        for (const h of r.history ?? []) {
          for (const a of h.messagesAdded ?? []) (added.add(a.message.id), deleted.delete(a.message.id));
          for (const d of h.messagesDeleted ?? []) (deleted.add(d.message.id), added.delete(d.message.id));
        }
        pageToken = r.nextPageToken ?? "";
      } while (pageToken);
    } catch (e) {
      if (e instanceof GmailError && e.status === 404) throw new HistoryExpiredError();
      throw e;
    }
    return { added: [...added], deleted: [...deleted], historyId: latest };
  }
}
