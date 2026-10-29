import { useCallback, useEffect, useState } from "react";
import { rpc } from "../rpc";

const btn = "rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";
interface Stats { nodes: number; edges: number; manualNodes: number; manualEdges: number; chunks: number }

function download(name: string, data: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type: "application/json" }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

export function SettingsMemory() {
  const [st, setSt] = useState<Stats | null>(null);
  const [msg, setMsg] = useState("");
  const load = useCallback(() => { rpc<Stats>("memory.stats").then(setSt).catch((e) => setMsg(String(e))); }, []);
  useEffect(load, [load]);

  const importFile = async (f: File) => {
    try { const r = await rpc<{ nodes: number; edges: number }>("memory.import", { data: JSON.parse(await f.text()) }); setMsg(`${r.nodes} nœud(s) et ${r.edges} lien(s) importés.`); load(); } catch (e) { setMsg(`Import impossible : ${e}`); }
  };

  return (
    <div className="max-w-2xl space-y-4 text-sm">
      <h2 className="text-lg font-medium">Mémoire</h2>
      {st && <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {([["Nœuds", st.nodes], ["Liens", st.edges], ["Passages indexés", st.chunks], ["Nœuds manuels / plugins", st.manualNodes], ["Liens manuels", st.manualEdges]] as const).map(([l, n]) => <li key={l} className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800"><div className="text-xl font-semibold">{n}</div><div className="text-xs text-neutral-500">{l}</div></li>)}
      </ul>}
      <div className="flex flex-wrap gap-2">
        <button className={btn} onClick={async () => download("memoire-assistant.json", JSON.stringify(await rpc("memory.export"), null, 2))}>Exporter mes ajouts manuels</button>
        <label className={`${btn} cursor-pointer`}>Importer…<input type="file" accept="application/json" className="sr-only" onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} /></label>
        <button className={`${btn} text-red-700`} onClick={() => { if (confirm("Effacer toute la mémoire en graphe, y compris vos ajouts manuels ? Mails, documents et événements ne sont pas touchés ; le graphe automatique se reconstruira.")) void rpc("memory.clear").then(() => { setMsg("Mémoire effacée."); load(); }); }}>Purger la mémoire…</button>
      </div>
      <p className="text-neutral-500">Pour oublier un élément précis, ouvrez la page Graphe, sélectionnez-le et choisissez « Oublier ce nœud » : il ne sera pas recréé automatiquement. L'export contient uniquement ce que vous (ou un plugin) avez ajouté ; le reste se reconstruit à partir de vos données.</p>
      <p role="status" className="text-neutral-500">{msg}</p>
    </div>
  );
}
