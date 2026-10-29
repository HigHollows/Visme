import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { rpc } from "../rpc";

interface Doc {
  id: string;
  name: string;
  ext: string;
  size: number;
  status: "indexing" | "ready" | "error";
  error: string | null;
  warnings: string[];
  summary: string | null;
  tags: string[];
  entities: { name: string; type: string }[];
  dates: { date: string; label: string }[];
  createdAt: number;
}
interface AddResult { path: string; id?: string; duplicate?: boolean; error?: string }

const EXTENSIONS = ["pdf", "docx", "xlsx", "pptx", "txt", "md", "csv", "png", "jpg", "jpeg", "webp", "gif"];
const btn = "rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";
const size = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} Mo` : `${Math.max(1, Math.round(n / 1e3))} Ko`);

export function Documents({ selectedId }: { selectedId?: string | null }) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [sel, setSel] = useState<string | null>(selectedId ?? null);
  const [over, setOver] = useState(false);
  const [msg, setMsg] = useState("");

  const refresh = useCallback(() => rpc<Doc[]>("documents.list").then(setDocs).catch((e) => setMsg(String(e))), []);

  const add = useCallback(async (paths: string[]) => {
    if (!paths.length) return;
    const res = await rpc<AddResult[]>("documents.add", { paths });
    const errors = res.filter((r) => r.error).map((r) => `${r.path.split(/[\\/]/).pop()} : ${r.error}`);
    const dups = res.filter((r) => r.duplicate).length;
    setMsg([errors.join(" · "), dups ? `${dups} déjà importé(s)` : ""].filter(Boolean).join(" — "));
    await refresh();
  }, [refresh]);

  useEffect(() => { if (selectedId) setSel(selectedId); }, [selectedId]);

  useEffect(() => {
    refresh();
    const un1 = listen<{ method: string }>("sidecar-event", ({ payload }) => {
      if (payload.method === "documents.event") refresh();
    });
    const un2 = getCurrentWebview().onDragDropEvent((e) => {
      const t = e.payload.type;
      if (t === "enter" || t === "over") setOver(true);
      else if (t === "leave") setOver(false);
      else if (t === "drop") { setOver(false); void add(e.payload.paths); }
    });
    return () => { void un1.then((f) => f()); void un2.then((f) => f()); };
  }, [refresh, add]);

  const pick = async () => {
    const r = await open({ multiple: true, filters: [{ name: "Documents", extensions: EXTENSIONS }] });
    if (r) await add(Array.isArray(r) ? r : [r]);
  };

  const current = docs.find((d) => d.id === sel);

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-4">
      <section className="flex min-w-0 flex-1 flex-col">
        <div
          className={`mb-3 flex items-center gap-3 rounded-md border-2 border-dashed p-4 text-sm ${over ? "border-blue-500 bg-blue-50 dark:bg-blue-950" : "border-neutral-300 dark:border-neutral-700"}`}
        >
          <span className="flex-1">Glissez des fichiers ici (PDF, DOCX, XLSX, PPTX, TXT, MD, CSV, images).</span>
          <button className={btn} onClick={pick}>Choisir des fichiers…</button>
        </div>
        {msg && <p role="status" className="mb-2 text-sm text-amber-700 dark:text-amber-400">{msg}</p>}
        <ul className="flex-1 space-y-1 overflow-y-auto">
          {docs.length === 0 && <li className="text-sm text-neutral-500">Aucun document pour l'instant.</li>}
          {docs.map((d) => (
            <li key={d.id}>
              <button
                onClick={() => setSel(d.id)}
                className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm ${sel === d.id ? "bg-neutral-100 dark:bg-neutral-800" : "hover:bg-neutral-50 dark:hover:bg-neutral-900"}`}
              >
                <span className="min-w-0 flex-1 truncate">{d.name}</span>
                <span className="text-xs text-neutral-500">{size(d.size)}</span>
                <span className={`text-xs ${d.status === "ready" ? "text-green-600" : d.status === "error" ? "text-red-600" : "text-amber-600"}`}>
                  {d.status === "ready" ? "indexé" : d.status === "error" ? "erreur" : "indexation…"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <aside className="w-80 shrink-0 overflow-y-auto border-l border-neutral-200 pl-4 dark:border-neutral-800" aria-label="Détail du document">
        {!current ? (
          <p className="text-sm text-neutral-500">Sélectionnez un document.</p>
        ) : (
          <div className="space-y-3 text-sm">
            <h2 className="break-words text-base font-medium">{current.name}</h2>
            {current.error && <p role="alert" className="text-red-600">{current.error}</p>}
            {current.summary && <p>{current.summary}</p>}
            {current.tags.length > 0 && (
              <p className="flex flex-wrap gap-1">{current.tags.map((t) => <span key={t} className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs dark:bg-neutral-800">{t}</span>)}</p>
            )}
            {current.dates.length > 0 && (
              <div><h3 className="font-medium">Dates détectées</h3><ul>{current.dates.map((x, i) => <li key={i}>{x.date} — {x.label}</li>)}</ul></div>
            )}
            {current.entities.length > 0 && (
              <div><h3 className="font-medium">Entités</h3><ul>{current.entities.map((x, i) => <li key={i}>{x.name} <span className="text-neutral-500">({x.type})</span></li>)}</ul></div>
            )}
            {current.warnings.length > 0 && <ul className="text-xs text-neutral-500">{current.warnings.map((w, i) => <li key={i}>• {w}</li>)}</ul>}
            <div className="flex gap-2">
              <button className={btn} onClick={() => rpc("documents.reindex", { id: current.id }).then(refresh)}>Ré-indexer</button>
              <button className={btn} onClick={async () => { await rpc("documents.delete", { id: current.id }); setSel(null); refresh(); }}>Supprimer</button>
            </div>
            <p className="text-xs text-neutral-500">Le fichier d'origine n'est jamais modifié ni supprimé.</p>
          </div>
        )}
      </aside>
    </div>
  );
}
