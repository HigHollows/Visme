import { randomUUID } from "node:crypto";
import type { ChatMessage } from "@assistant/ai";
import type { Db } from "@assistant/db";
import type { Settings } from "@assistant/schemas";
import { buildProviders, buildRouter } from "./ai";
import { SYSTEM_PROMPT } from "./prompts";
import { RpcError, type RpcServer } from "./rpc";

export type Notify = (method: string, params: unknown) => void;

const HISTORY_LIMIT = 40;
const MAX_INPUT = 20_000;

export interface ChatDeps {
  rpc: RpcServer;
  db: () => Db;
  settings: () => Settings;
  keys: ReadonlyMap<string, string>;
  fetch?: typeof fetch;
  notify: Notify;
}

export function registerChat(d: ChatDeps) {
  const streams = new Map<string, AbortController>();

  d.rpc.register("chat.list", () =>
    d.db().prepare("SELECT id, title, updated_at AS updatedAt FROM conversations ORDER BY updated_at DESC LIMIT 200").all(),
  );

  d.rpc.register("chat.get", (p: { id: string }) =>
    d
      .db()
      .prepare("SELECT id, role, content, created_at AS createdAt FROM messages WHERE conversation_id = ? ORDER BY id")
      .all(p.id),
  );

  d.rpc.register("chat.delete", (p: { id: string }) => {
    d.db().prepare("DELETE FROM conversations WHERE id = ?").run(p.id);
    return { ok: true };
  });

  d.rpc.register("chat.cancel", (p: { streamId: string }) => {
    streams.get(p.streamId)?.abort();
    return { ok: true };
  });

  d.rpc.register("chat.send", (p: { streamId: string; conversationId?: string; text: string }) => {
    const text = (p.text ?? "").trim();
    if (!text) throw new RpcError(-32602, "Message vide");
    if (text.length > MAX_INPUT) throw new RpcError(-32602, "Message trop long");
    if (!p.streamId || streams.has(p.streamId)) throw new RpcError(-32602, "streamId invalide");

    const settings = d.settings();
    const route = settings.ai.routes.chat;
    if (!route) throw new RpcError(-32010, "Aucun modèle configuré pour le chat (Settings → IA).");
    if (!d.keys.has(route.primary.provider))
      throw new RpcError(-32010, `Aucune clé API pour « ${route.primary.provider} » (Settings → IA).`);

    const db = d.db();
    const now = Date.now();
    let conversationId = p.conversationId;
    if (conversationId) {
      if (!db.prepare("SELECT 1 FROM conversations WHERE id = ?").get(conversationId))
        throw new RpcError(-32602, "Conversation introuvable");
    } else {
      conversationId = randomUUID();
      const title = text.replace(/\s+/g, " ").slice(0, 60);
      db.prepare("INSERT INTO conversations(id, title, created_at, updated_at) VALUES (?,?,?,?)").run(
        conversationId,
        title,
        now,
        now,
      );
    }
    db.prepare("INSERT INTO messages(conversation_id, role, content, created_at) VALUES (?,?,?,?)").run(
      conversationId,
      "user",
      text,
      now,
    );

    const history = (
      db
        .prepare("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?")
        .all(conversationId, HISTORY_LIMIT) as ChatMessage[]
    ).reverse();

    const controller = new AbortController();
    streams.set(p.streamId, controller);
    const convId = conversationId;
    const emit = (e: Record<string, unknown>) => d.notify("chat.event", { streamId: p.streamId, conversationId: convId, ...e });

    void (async () => {
      let answer = "";
      let cancelled = false;
      try {
        const router = buildRouter(db, settings, buildProviders(settings, d.keys, d.fetch));
        for await (const chunk of router.chat("chat", {
          messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
          signal: controller.signal,
        })) {
          if (chunk.type === "text") {
            answer += chunk.text;
            emit({ type: "text", text: chunk.text });
          }
        }
      } catch (e) {
        if (controller.signal.aborted) cancelled = true;
        else emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
      } finally {
        streams.delete(p.streamId);
        if (answer) {
          db.prepare("INSERT INTO messages(conversation_id, role, content, created_at, model) VALUES (?,?,?,?,?)").run(
            convId,
            "assistant",
            answer,
            Date.now(),
            route.primary.model,
          );
        }
        db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(Date.now(), convId);
        emit({ type: "done", cancelled });
      }
    })();

    return { conversationId };
  });
}
