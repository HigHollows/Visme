import { AIError } from "../types";

export type FetchFn = typeof fetch;

export function httpError(status: number, body: string): AIError {
  const msg = `HTTP ${status}: ${body.slice(0, 300)}`;
  if (status === 401 || status === 403) return new AIError(msg, "auth");
  if (status === 429) return new AIError(msg, "rate_limit");
  if (status >= 500) return new AIError(msg, "unavailable");
  return new AIError(msg, "other");
}

/** Itère les événements `data:` d'un flux Server-Sent Events. */
export async function* sseData(res: Response): AsyncIterable<string> {
  if (!res.ok) throw httpError(res.status, await res.text().catch(() => ""));
  if (!res.body) throw new AIError("Réponse sans corps", "other");
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i: number;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) yield data;
    }
  }
}

export async function networkGuard<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof AIError) throw e;
    if (e instanceof Error && e.name === "AbortError") throw e;
    throw new AIError(`Réseau : ${e instanceof Error ? e.message : String(e)}`, "unavailable");
  }
}
