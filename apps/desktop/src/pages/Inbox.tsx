import { useCallback, useEffect, useRef, useState } from "react";
import { tr, locale } from "../i18n";
import { listen } from "@tauri-apps/api/event";
import { rpc, type Proposal } from "../rpc";

const btn = "rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";
const input = "rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700";
const pad = (n: number) => String(n).padStart(2, "0");
const dt = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmt = (t: number, allDay?: boolean) => new Date(t).toLocaleString(locale(), allDay ? { dateStyle: "full" } : { dateStyle: "medium", timeStyle: "short" });

function describe(p: Proposal) {
  if (p.kind === "deadline") {
    const d = p.payload as { service?: string; amount?: number | null; currency?: string; nextDate?: number | null; cancelBy?: number | null };
    return `💶 ${p.title}${d.nextDate ? tr(" — échéance le {0}", fmt(d.nextDate, true)) : ""}${d.cancelBy ? tr(" · résilier avant le {0}", fmt(d.cancelBy, true)) : ""}`;
  }
  if (p.kind === "event") return `📅 ${p.payload.title ?? p.title} — ${p.payload.start ? fmt(p.payload.start, p.payload.allDay) : ""}${p.payload.location ? ` · ${p.payload.location}` : ""}`;
  return `☑ ${p.title}${p.payload.due ? tr(" — pour le {0}", fmt(p.payload.due, true)) : ""}`;
}

function EditDialog({ p, onClose, onSave }: { p: Proposal; onClose: () => void; onSave: (edits: Record<string, unknown>) => void }) {
  const [title, setTitle] = useState(p.payload.title ?? p.title);
  const [start, setStart] = useState(p.payload.start ? dt(p.payload.start) : "");
  const [end, setEnd] = useState(p.payload.end ? dt(p.payload.end) : "");
  const [due, setDue] = useState(p.payload.due ? dt(p.payload.due).slice(0, 10) : "");
  const dl = p.payload as { nextDate?: number | null; cancelBy?: number | null };
  const [nextDate, setNextDate] = useState(dl.nextDate ? dt(dl.nextDate).slice(0, 10) : "");
  const [cancelBy, setCancelBy] = useState(dl.cancelBy ? dt(dl.cancelBy).slice(0, 10) : "");
  const day = (s: string) => (s ? new Date(`${s}T00:00`).getTime() : null);
  const save = () => {
    if (p.kind === "deadline") {
      onSave({ nextDate: day(nextDate), cancelBy: day(cancelBy) });
    } else if (p.kind === "event") {
      const s = new Date(start).getTime();
      const e = end ? new Date(end).getTime() : s + 3600_000;
      onSave({ title, start: s, end: e });
    } else onSave({ title, due: due ? new Date(`${due}T00:00`).getTime() : null });
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label={tr("Modifier la suggestion")} onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}
        className="w-[420px] max-w-[92vw] space-y-3 rounded-xl border border-neutral-200 bg-white p-5 shadow-2xl dark:border-neutral-700 dark:bg-neutral-900">
        <input autoFocus aria-label={tr("Titre")} className={`${input} w-full`} value={title} onChange={(e) => setTitle(e.target.value)} />
        {p.kind === "deadline" ? (
          <div className="flex flex-wrap gap-3 text-sm">
            <label>{tr("Échéance")}<br /><input type="date" className={input} value={nextDate} onChange={(e) => setNextDate(e.target.value)} /></label>
            <label>{tr("Résilier avant")}<br /><input type="date" className={input} value={cancelBy} onChange={(e) => setCancelBy(e.target.value)} /></label>
          </div>
        ) : p.kind === "event" ? (
          <div className="flex flex-wrap items-center gap-2">
            <input type="datetime-local" aria-label={tr("Début")} className={input} value={start} onChange={(e) => setStart(e.target.value)} />→
            <input type="datetime-local" aria-label={tr("Fin")} className={input} value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
        ) : <input type="date" aria-label={tr("Échéance")} className={input} value={due} onChange={(e) => setDue(e.target.value)} />}
        <div className="flex justify-end gap-2"><button className={btn} onClick={onClose}>{tr("Annuler")}</button><button className={`${btn} font-medium`} onClick={save}>{tr("Accepter avec ces changements")}</button></div>
      </div>
    </div>
  );
}

export function Inbox({ onOpenMail }: { onOpenMail: (id: string) => void }) {
  const [tab, setTab] = useState<"pending" | "decided">("pending");
  const [items, setItems] = useState<Proposal[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [cur, setCur] = useState(0);
  const [editing, setEditing] = useState<Proposal | null>(null);
  const [err, setErr] = useState("");
  const list = useRef<HTMLUListElement>(null);

  const load = useCallback(() => {
    rpc<Proposal[]>("proposals.list", { status: tab }).then((r) => { setItems(r); setErr(""); setSel(new Set()); setCur((c) => Math.min(c, Math.max(r.length - 1, 0))); }).catch((e) => setErr(String(e)));
  }, [tab]);
  useEffect(load, [load]);
  useEffect(() => {
    const un = listen<{ method: string }>("sidecar-event", ({ payload }) => { if (payload.method === "proposals.event" || payload.method === "agent.event") load(); });
    return () => void un.then((f) => f());
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => { try { await fn(); load(); } catch (e) { setErr(String(e)); } };
  const accept = (ids: string[]) => act(async () => {
    const r = await rpc<{ id: string; error?: string }[]>("proposals.acceptMany", { ids });
    const bad = r.filter((x) => x.error);
    if (bad.length) throw new Error(bad.map((b) => b.error).join(" · "));
  });
  const reject = (ids: string[]) => act(() => rpc("proposals.reject", { ids }));
  const targets = (p: Proposal) => (sel.size && sel.has(p.id) ? [...sel] : [p.id]);

  const onKey = (e: React.KeyboardEvent) => {
    if (tab !== "pending" || editing || (e.target as HTMLElement).tagName === "INPUT") return;
    const p = items[cur];
    const k = e.key.toLowerCase();
    if (k === "arrowdown") { e.preventDefault(); setCur((c) => Math.min(c + 1, items.length - 1)); }
    else if (k === "arrowup") { e.preventDefault(); setCur((c) => Math.max(c - 1, 0)); }
    else if (!p) return;
    else if (k === "a") { e.preventDefault(); void accept(targets(p)); }
    else if (k === "r") { e.preventDefault(); void reject(targets(p)); }
    else if (k === "e") { e.preventDefault(); setEditing(p); }
    else if (k === " ") { e.preventDefault(); setSel((s) => { const n = new Set(s); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n; }); }
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {(["pending", "decided"] as const).map((t) => (
          <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)} className={`${btn} ${tab === t ? "bg-neutral-100 font-medium dark:bg-neutral-800" : ""}`}>{t === "pending" ? tr("En attente") : tr("Historique")}</button>
        ))}
        {tab === "pending" && items.length > 0 && (
          <>
            <button className={btn} onClick={() => setSel(sel.size === items.length ? new Set() : new Set(items.map((i) => i.id)))}>{sel.size === items.length ? tr("Tout désélectionner") : tr("Tout sélectionner")}</button>
            <button className={btn} disabled={!sel.size} onClick={() => accept([...sel])}>{tr("Accepter la sélection (")}{sel.size})</button>
            <button className={btn} disabled={!sel.size} onClick={() => reject([...sel])}>{tr("Refuser la sélection")}</button>
            <span className="ml-auto text-xs text-neutral-500">{tr("↑↓ naviguer · A accepter · R refuser · E modifier · Espace sélectionner")}</span>
          </>
        )}
      </div>
      {err && <p role="alert" className="mb-2 text-sm text-red-600">{err}</p>}
      {items.length === 0 && <p className="text-sm text-neutral-500">{tab === "pending" ? tr("Rien à valider pour l'instant 🎉") : tr("Aucune décision pour l'instant.")}</p>}
      <ul ref={list} tabIndex={0} onKeyDown={onKey} aria-label={tr("Suggestions")} className="space-y-2 outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
        {items.map((p, i) => (
          <li key={p.id} aria-current={i === cur && tab === "pending"} onClick={() => setCur(i)}
            className={`rounded-md border p-3 ${i === cur && tab === "pending" ? "border-blue-500" : "border-neutral-200 dark:border-neutral-800"}`}>
            <div className="flex items-start gap-3">
              {tab === "pending" && <input type="checkbox" aria-label={tr("Sélectionner")} checked={sel.has(p.id)} onChange={() => setSel((s) => { const n = new Set(s); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n; })} className="mt-1" />}
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{describe(p)}</div>
                <div className="mt-0.5 text-xs text-neutral-600 dark:text-neutral-400">{tr("Pourquoi :")} {p.reason}</div>
                <div className="mt-0.5 text-xs text-neutral-500">
                  {tr("Confiance")} {Math.round(p.confidence * 100)} %{p.confidence < 0.6 && tr(" (faible)")}
                  {p.sourceRef?.type === "mail" && <> · <button className="underline" onClick={() => onOpenMail(p.sourceRef!.id)}>{tr("voir le mail")}</button></>}
                  {tab === "decided" && <> · {p.status === "accepted" ? tr("✅ accepté") : p.status === "auto" ? tr("🤖 ajouté automatiquement") : tr("❌ refusé")}</>}
                </div>
              </div>
              {tab === "pending" && (
                <div className="flex shrink-0 gap-1">
                  <button className={btn} onClick={() => accept([p.id])}>{tr("Accepter")}</button>
                  <button className={btn} onClick={() => setEditing(p)}>{tr("Modifier")}</button>
                  <button className={btn} onClick={() => reject([p.id])}>{tr("Refuser")}</button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      {editing && <EditDialog p={editing} onClose={() => setEditing(null)} onSave={(edits) => { const id = editing.id; setEditing(null); void act(() => rpc("proposals.accept", { id, edits })); }} />}
    </div>
  );
}
