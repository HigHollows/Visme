import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { rpc, type Preset, type SourceRef } from "../rpc";

interface Conv { id: string; title: string; updatedAt: number }
interface Msg { role: "user" | "assistant"; content: string; sources?: SourceRef[]; notes?: string[] }
interface Hit { type: "document" | "mail" | "event"; id: string; title: string }
interface ChatEvent {
  streamId: string;
  conversationId: string;
  type: "text" | "error" | "done" | "sources" | "tool";
  sources?: SourceRef[];
  name?: string;
  result?: string;
  text?: string;
  message?: string;
  cancelled?: boolean;
}

const btn = "rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";

export function Chat({ openId, onOpenSource }: { openId?: string | null; onOpenSource: (type: string, id: string) => void }) {
  const [convs, setConvs] = useState<Conv[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [streamId, setStreamId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetId, setPresetId] = useState("general");
  const [mention, setMention] = useState<{ q: string; hits: Hit[]; idx: number } | null>(null);
  const streamRef = useRef<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const refreshList = useCallback(() => rpc<Conv[]>("chat.list").then(setConvs).catch((e) => setError(String(e))), []);

  const open = useCallback(async (id: string | null) => {
    setCurrent(id);
    setError("");
    setMessages(id ? await rpc<Msg[]>("chat.get", { id }) : []);
    if (id) { const c = (await rpc<{ id: string; presetId: string | null }[]>("chat.list")).find((x) => x.id === id); if (c?.presetId) setPresetId(c.presetId); }
  }, []);

  useEffect(() => { rpc<Preset[]>("presets.list").then(setPresets).catch(() => {}); }, []);

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
            ? [...m.slice(0, -1), { ...last, content: last.content + ev.text }]
            : [...m, { role: "assistant", content: ev.text ?? "" }];
        });
      } else if (ev.type === "sources") {
        setMessages((m) => {
          const last = m[m.length - 1];
          return last?.role === "assistant" ? [...m.slice(0, -1), { ...last, sources: ev.sources }] : [...m, { role: "assistant", content: "", sources: ev.sources }];
        });
      } else if (ev.type === "tool") {
        setMessages((m) => {
          const note = ev.result ?? "";
          const last = m[m.length - 1];
          return last?.role === "assistant" ? [...m.slice(0, -1), { ...last, notes: [...(last.notes ?? []), note] }] : [...m, { role: "assistant", content: "", notes: [note] }];
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
      const r = await rpc<{ conversationId: string; presetId: string }>("chat.send", { streamId: id, conversationId: current, text, presetId });
      setCurrent(r.conversationId);
      if (text.startsWith("/")) setPresetId(r.presetId);
    } catch (e) {
      streamRef.current = null;
      setStreamId(null);
      setError(String(e));
      setMessages((m) => m.slice(0, -1));
      setDraft(text);
    }
  };

  /** Détecte « @mot » en fin de saisie et propose des éléments à mentionner. */
  const onDraft = (v: string) => {
    setDraft(v);
    const m = v.match(/(?:^|\s)@([^\s@\[]{0,40})$/);
    if (!m || m[1]!.length < 2) { setMention(null); return; }
    const q = m[1]!;
    rpc<{ type: string; id: string; title: string }[]>("search.query", { q, limit: 8 })
      .then((r) => setMention({ q, idx: 0, hits: r.filter((h) => h.type === "document" || h.type === "mail").map((h) => ({ type: h.type as Hit["type"], id: h.id, title: h.title })) }))
      .catch(() => setMention(null));
  };
  const pickMention = (h: Hit) => {
    setDraft((d) => d.replace(/@[^\s@\[]{0,40}$/, `@[${h.title.replace(/[\]\[()]/g, " ")}](${h.type}:${h.id}) `));
    setMention(null);
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
        <div className="mb-2 flex items-center gap-2 text-sm">
          <label htmlFor="preset">Préréglage</label>
          <select id="preset" className="rounded-md border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700" value={presetId} onChange={(e) => setPresetId(e.target.value)} disabled={!!streamId}>
            {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <span className="text-xs text-neutral-500">/resume · /traduis · /agenda · /cherche · /tache · @ pour mentionner</span>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto pr-2" aria-live="polite">
          {messages.length === 0 && <p className="text-sm text-neutral-500">Posez une question pour commencer.</p>}
          {messages.map((m, i) => (
            <div key={i} className={m.role === "user" ? "ml-auto max-w-[80%] rounded-lg bg-neutral-100 px-3 py-2 dark:bg-neutral-800" : "max-w-[90%]"}>
              <div className="mb-0.5 text-xs text-neutral-500">{m.role === "user" ? "Vous" : "Assistant"}</div>
              {/* Texte brut : jamais de HTML injecté depuis la réponse du modèle. */}
              <div className="whitespace-pre-wrap text-sm">{m.content}</div>
              {m.notes?.map((n, k) => <div key={k} className="mt-1 text-xs italic text-neutral-500">🛠 {n}</div>)}
              {m.sources && m.sources.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1" aria-label="Sources">
                  {m.sources.map((src) => (
                    <button key={src.n} onClick={() => onOpenSource(src.type, src.id)} title={src.title}
                      className="max-w-[16rem] truncate rounded-full border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800">
                      [S{src.n}] {src.title}
                    </button>
                  ))}
                </div>
              )}
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
          <div className="relative flex-1">
          {mention && mention.hits.length > 0 && (
            <ul role="listbox" aria-label="Mentions" className="absolute bottom-full left-0 z-10 mb-1 max-h-48 w-full overflow-y-auto rounded-md border border-neutral-200 bg-white text-sm shadow dark:border-neutral-700 dark:bg-neutral-900">
              {mention.hits.map((h, i) => (
                <li key={h.type + h.id} role="option" aria-selected={i === mention.idx} onMouseDown={(e) => { e.preventDefault(); pickMention(h); }}
                  className={`cursor-pointer px-3 py-1 ${i === mention.idx ? "bg-neutral-100 dark:bg-neutral-800" : ""}`}>
                  <span className="mr-2 text-xs text-neutral-500">{h.type === "document" ? "Document" : h.type === "mail" ? "Mail" : "Événement"}</span>{h.title}
                </li>
              ))}
            </ul>
          )}
          <textarea
            aria-label="Message"
            rows={2}
            className="w-full resize-none rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm dark:border-neutral-700"
            placeholder="Écrivez votre message (Entrée pour envoyer, Maj+Entrée pour une nouvelle ligne)"
            value={draft}
            onChange={(e) => onDraft(e.target.value)}
            onKeyDown={(e) => {
              if (mention && mention.hits.length) {
                if (e.key === "ArrowDown") { e.preventDefault(); setMention({ ...mention, idx: (mention.idx + 1) % mention.hits.length }); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); setMention({ ...mention, idx: (mention.idx - 1 + mention.hits.length) % mention.hits.length }); return; }
                if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickMention(mention.hits[mention.idx]!); return; }
                if (e.key === "Escape") { setMention(null); return; }
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
            }}
          />
          </div>
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
