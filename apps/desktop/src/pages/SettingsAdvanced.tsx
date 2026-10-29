import { useEffect, useState } from "react";
import { tr, locale } from "../i18n";
import { invoke } from "@tauri-apps/api/core";
import { rpc } from "../rpc";

interface Diag { node: string; platform: string; dbBytes: number; schemaVersion: number; counts: Record<string, number>; lastErrors: { at: number; action: string; detail: string | null }[] }
const btn = "rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";

function download(name: string, data: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type: "application/json" }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

export function SettingsAdvanced() {
  const [d, setD] = useState<Diag | null>(null);
  const [version, setVersion] = useState("");
  const [msg, setMsg] = useState("");
  useEffect(() => { rpc<Diag>("diagnostics.get").then(setD).catch((e) => setMsg(String(e))); invoke<string>("app_version").then(setVersion).catch(() => {}); }, []);

  const importFile = async (f: File) => {
    try { await rpc("settings.import", { json: await f.text() }); setMsg(tr("Réglages importés (les clés API ne sont jamais importées : à ressaisir).")); } catch (e) { setMsg(tr("Import impossible : {0}", e)); }
  };

  return (
    <div className="max-w-2xl space-y-6 text-sm">
      <section className="space-y-2">
        <h2 className="text-lg font-medium">{tr("Réglages : sauvegarde")}</h2>
        <div className="flex flex-wrap gap-2">
          <button className={btn} onClick={async () => download("reglages-assistant.json", await rpc<string>("settings.export"))}>{tr("Exporter les réglages (sans clés API)")}</button>
          <label className={`${btn} cursor-pointer`}>{tr("Importer…")}<input type="file" accept="application/json" className="sr-only" onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} /></label>
          <button className={btn} onClick={() => { if (confirm(tr("Rétablir tous les réglages par défaut de ce profil ? Vos données et clés API ne sont pas touchées."))) void rpc("settings.reset").then(() => { setMsg(tr("Réglages rétablis.")); }); }}>{tr("Rétablir les réglages par défaut")}</button>
        </div>
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-medium">{tr("Diagnostic")}</h2>
        {d ? (
          <>
            <p className="text-neutral-600 dark:text-neutral-400">{tr("ASSISTANT")} {version} {tr("· moteur Node")} {d.node} · {d.platform} {tr("· base v")}{d.schemaVersion}, {(d.dbBytes / 1e6).toFixed(1)} {tr("Mo")}</p>
            <ul className="grid grid-cols-2 gap-x-6 gap-y-0.5 sm:grid-cols-3">{Object.entries(d.counts).map(([k, n]) => <li key={k} className="flex justify-between"><span className="text-neutral-500">{k}</span><span>{n}</span></li>)}</ul>
            {d.lastErrors.length > 0 && <div><h3 className="mt-2 font-medium">{tr("Dernières erreurs")}</h3><ul className="text-xs">{d.lastErrors.map((e, i) => <li key={i}>{new Date(e.at).toLocaleString(locale())} — {e.action} {e.detail}</li>)}</ul></div>}
            <button className={btn} onClick={() => download("diagnostic-assistant.json", JSON.stringify({ app: version, ...d }, null, 2))}>{tr("Copier pour un rapport de bug (JSON, sans contenu personnel)")}</button>
          </>
        ) : <p className="text-neutral-500">{tr("Chargement…")}</p>}
      </section>
      <p role="status" className="text-neutral-500">{msg}</p>
    </div>
  );
}
