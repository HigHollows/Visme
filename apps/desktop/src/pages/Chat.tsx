import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { rpc } from "../rpc";

interface Conv { id: string; title: string; updatedAt: number }
interface Msg { role: "user" | "assistant"; content: string }
interface ChatEvent {
  streamId: string;
  conversationId: string;
  type: "text" | "error" | "done";
  text?: string;
  message?: string;
  cancelled?: boolean;
}

const btn = "rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";

export function Chat({ openId }: { openId?: string | null }) {
  const [convs, setConvs] = useState<Conv[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [streamId, setStreamId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const streamRef = useRef<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const refreshList = useCallback(() => rpc<Conv[]>("chat.list").then(setConvs).catch((e) => setError(String(e))), []);

  const open = useCallback(async (id: string | null) => {
    setCurrent(id);
    setError("");
    setMessages(id ? await rpc<Msg[]>("chat.get", { id }) : []);
  }, []);

  useEffect(() => {
    refreshList();
    const un = listen<{ method: string; params: ChatEvent }>("sidecar-event", ({ payload }) => {
      if (payload.method !== "chat.event") return;
      const ev = payload.params;
      if (ev.streamId !== streamRef.current) return;
      if (ev.type === "text") {
        setMessages((m) => {
          const last = m[m.length - 1];
          return last?.role === "assistant"
            ? [...m.slice(0, -1), { role: "assistant", content: last.content + ev.text }]
            : [...m, { role: "assistant", content: ev.text ?? "" }];
        });
      } else if (ev.type === "error") {
        setError(ev.message ?? "Erreur");
      } else if (ev.type === "done") {
        streamRef.current = null;
        setStreamId(null);
        refreshList();
      }
    });
    return () => void un.then((f) => f());
  }, [refreshList]);

  useEffect(() => {
    if (openId !== undefined && !streamRef.current) void open(openId);
  }, [openId, open]);

  useEffect(() => bottom.current?.scrollIntoView({ block: "end" }), [messages]);

  const send = async () => {
    const text = draft.trim();
    if (!text || streamRef.current) return;
    const id = crypto.randomUUID();
    streamRef.current = id; // avant l'appel : les premiers événements peuvent arriver avant la réponse RPC
    setStreamId(id);
    setError("");
    setDraft("");
    setMessages((m) => [...m, { role: "user", content: text }]);
    try {
      const r = await rpc<{ conversationId: string }>("chat.send", { streamId: id, conversationId: current, text });
      setCurrent(r.conversationId);
    } catch (e) {
      streamRef.current = null;
      setStreamId(null);
      setError(String(e));
      setMessages((m) => m.slice(0, -1));
      setDraft(text);
    }
  };

  const remove = async (id: string) => {
    await rpc("chat.delete", { id });
    if (current === id) await open(null);
    refreshList();
  };

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-4">
      <aside className="w-56 shrink-0 overflow-y-auto">
        <button className={`${btn} mb-2 w-full`} onClick={() => open(null)} disabled={!!streamId}>Nouvelle conversation</button>
        <ul className="space-y-1">
          {convs.map((c) => (
            <li key={c.id} className="group flex items-center">
              <button
                onClick={() => open(c.id)}
                disabled={!!streamId}
                className={`flex-1 truncate rounded-md px-2 py-1 text-left text-sm ${current === c.id ? "bg-neutral-100 dark:bg-neutral-800" : "hover:bg-neutral-50 dark:hover:bg-neutral-900"}`}
              >
                {c.title}
              </button>
              <button aria-label={`Supprimer ${c.title}`} className="px-1 text-neutral-400 opacity-0 hover:text-red-600 focus:opacity-100 group-hover:opacity-100" onClick={() => remove(c.id)}>×</button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex-1 space-y-4 overflow-y-auto pr-2" aria-live="polite">
          {messages.length === 0 && <p className="text-sm text-neutral-500">Posez une question pour commencer.</p>}
          {messages.map((m, i) => (
            <div key={i} className={m.role === "user" ? "ml-auto max-w-[80%] rounded-lg bg-neutral-100 px-3 py-2 dark:bg-neutral-800" : "max-w-[90%]"}>
              <div className="mb-0.5 text-xs text-neutral-500">{m.role === "user" ? "Vous" : "Assistant"}</div>
              {/* Texte brut : jamais de HTML injecté depuis la réponse du modèle. */}
              <div className="whitespace-pre-wrap text-sm">{m.content}</div>
            </div>
          ))}
          {streamId && messages[messages.length - 1]?.role === "user" && <p className="text-sm text-neutral-500">…</p>}
          <div ref={bottom} />
        </div>
        {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => { e.preventDefault(); void send(); }}
        >
          <textarea
            aria-label="Message"
            rows={2}
            className="flex-1 resize-none rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm dark:border-neutral-700"
            placeholder="Écrivez votre message (Entrée pour envoyer, Maj+Entrée pour une nouvelle ligne)"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
          />
          {streamId ? (
            <button type="button" className={btn} onClick={() => rpc("chat.cancel", { streamId })}>Arrêter</button>
          ) : (
            <button type="submit" className={btn} disabled={!draft.trim()}>Envoyer</button>
          )}
        </form>
      </section>
    </div>
  );
}
