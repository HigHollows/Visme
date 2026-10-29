import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { rpc } from "../rpc";

const btn = "rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";

export function SettingsFolders() {
  const [list, setList] = useState<{ path: string }[]>([]);
  const [msg, setMsg] = useState("");
  const load = useCallback(() => { rpc<{ path: string }[]>("watch.list").then(setList).catch((e) => setMsg(String(e))); }, []);
  useEffect(load, [load]);
  const act = async (fn: () => Promise<unknown>, ok = "") => { try { await fn(); setMsg(ok); } catch (e) { setMsg(String(e)); } load(); };

  return (
    <div className="max-w-2xl space-y-3 text-sm">
      <h2 className="text-lg font-medium">Dossiers surveillés</h2>
      <p className="text-neutral-600 dark:text-neutral-400">Tout nouveau fichier pris en charge (PDF, DOCX, XLSX, PPTX, TXT, MD, CSV, images) déposé dans ces dossiers est importé et indexé automatiquement. Les fichiers d'origine ne sont jamais modifiés ni supprimés ; les doublons sont ignorés.</p>
      <button className={btn} onClick={async () => { const d = await open({ directory: true, multiple: false, title: "Dossier à surveiller" }); if (typeof d === "string") void act(() => rpc("watch.add", { path: d }), "Dossier ajouté : import en cours."); }}>Ajouter un dossier…</button>
      <ul className="space-y-1">
        {list.length === 0 && <li className="text-neutral-500">Aucun dossier surveillé.</li>}
        {list.map((f) => (
          <li key={f.path} className="flex items-center gap-2 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800">
            <code className="min-w-0 flex-1 truncate">{f.path}</code>
            <button className={btn} onClick={() => act(async () => { const r = await rpc<{ candidates: number }>("watch.scan", { path: f.path }); setMsg(`${r.candidates} fichier(s) examiné(s).`); })}>Analyser maintenant</button>
            <button className={btn} onClick={() => act(() => rpc("watch.remove", { path: f.path }))}>Retirer</button>
          </li>
        ))}
      </ul>
      <p role="status" className="text-neutral-500">{msg}</p>
    </div>
  );
}
