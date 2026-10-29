import { useEffect, useMemo, useRef, useState } from "react";
import { tr } from "./i18n";
import { rpc } from "./rpc";

export interface PaletteAction { id: string; label: string; run: () => void }
interface Hit { type: "document" | "conversation" | "mail" | "event"; id: string; title: string; snippet: string }
type Row = { key: string; group: string; title: string; sub?: string; run: () => void };

const GROUP: Record<Hit["type"], string> = { document: tr("Documents"), conversation: tr("Conversations"), mail: tr("Mails"), event: tr("Événements") };

/** Recherche globale (Cmd/Ctrl+K) : actions rapides + recherche hybride dans les données. */
export function SearchPalette({ actions, onOpen, onClose }: {
  actions: PaletteAction[];
  onOpen: (type: Hit["type"], id: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [idx, setIdx] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setHits([]); setBusy(false); return; }
    const mine = ++seq.current;
    setBusy(true);
    const t = setTimeout(() => {
      rpc<Hit[]>("search.query", { q: term })
        .then((r) => { if (mine === seq.current) { setHits(r); setErr(""); } })
        .catch((e) => { if (mine === seq.current) setErr(String(e)); })
        .finally(() => { if (mine === seq.current) setBusy(false); });
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  const rows: Row[] = useMemo(() => {
    const term = q.trim().toLowerCase();
    const acts = actions
      .filter((a) => !term || a.label.toLowerCase().includes(term))
      .slice(0, term ? 5 : 8)
      .map((a) => ({ key: `a:${a.id}`, group: "Actions", title: a.label, run: a.run }));
    const found = hits.map((h) => ({
      key: `${h.type}:${h.id}`, group: GROUP[h.type], title: h.title, sub: h.snippet, run: () => onOpen(h.type, h.id),
    }));
    return [...acts, ...found];
  }, [q, hits, actions, onOpen]);

  useEffect(() => setIdx(0), [rows.length, q]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, rows.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && rows[idx]) { e.preventDefault(); rows[idx]!.run(); onClose(); }
  };

  let lastGroup = "";
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-24" onMouseDown={onClose}>
      <div
        role="dialog" aria-modal="true" aria-label={tr("Recherche globale")}
        className="w-[640px] max-w-[92vw] overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-700 dark:bg-neutral-900"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKey}
      >
        <input
          autoFocus
          role="combobox" aria-expanded="true" aria-controls="palette-list"
          aria-label={tr("Rechercher ou saisir une commande")}
          className="w-full border-b border-neutral-200 bg-transparent px-4 py-3 text-base outline-none dark:border-neutral-700"
          placeholder={tr("Rechercher dans vos mails, documents, conversations… ou lancer une action")}
          value={q} onChange={(e) => setQ(e.target.value)}
        />
        <ul id="palette-list" role="listbox" className="max-h-96 overflow-y-auto py-1">
          {rows.map((r, i) => {
            const header = r.group !== lastGroup ? (lastGroup = r.group) : null;
            return (
              <li key={r.key} role="presentation">
                {header && <div className="px-4 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-neutral-500">{header}</div>}
                <div
                  role="option" aria-selected={i === idx}
                  className={`cursor-pointer px-4 py-1.5 text-sm ${i === idx ? "bg-neutral-100 dark:bg-neutral-800" : ""}`}
                  onMouseEnter={() => setIdx(i)} onClick={() => { r.run(); onClose(); }}
                >
                  <div className="truncate">{r.title}</div>
                  {r.sub && <div className="truncate text-xs text-neutral-500">{r.sub.replace(/[«»]/g, "")}</div>}
                </div>
              </li>
            );
          })}
          {q.trim().length >= 2 && !busy && !err && hits.length === 0 && (
            <li className="px-4 py-2 text-sm text-neutral-500">{tr("Aucun résultat dans vos données.")}</li>
          )}
          {busy && <li className="px-4 py-2 text-sm text-neutral-500">{tr("Recherche…")}</li>}
          {err && <li role="alert" className="px-4 py-2 text-sm text-red-600">{err}</li>}
        </ul>
        <div className="border-t border-neutral-200 px-4 py-1.5 text-xs text-neutral-500 dark:border-neutral-700">{tr("↑↓ naviguer · Entrée ouvrir · Échap fermer")}</div>
      </div>
    </div>
  );
}
