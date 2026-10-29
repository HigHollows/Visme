import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

const btn = "rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";
const SHORTCUTS: [string, string][] = [
  ["Ctrl/Cmd + K", "Recherche globale et actions rapides"],
  ["Ctrl/Cmd + Maj + Espace", "Capture rapide (global, modifiable dans Réunions)"],
  ["Ctrl/Cmd + Maj + P", "Changer de profil"],
  ["Ctrl/Cmd + L", "Verrouiller (si un mot de passe est défini)"],
  ["A / R / E", "Dans « À valider » : accepter / refuser / modifier"],
  ["↑ ↓ · Espace", "Dans « À valider » : naviguer · sélectionner"],
  ["Entrée · Maj + Entrée", "Dans le chat : envoyer · nouvelle ligne"],
  ["Ctrl/Cmd + Entrée", "Dans la capture rapide : envoyer"],
  ["Échap", "Fermer une fenêtre de dialogue ou la capture rapide"],
];

/** Vérifie et installe une mise à jour (réutilisé par le bandeau de l'App). */
export async function checkForUpdate(): Promise<Update | null> {
  return check();
}

export function SettingsAbout() {
  const [version, setVersion] = useState("");
  const [update, setUpdate] = useState<Update | null>(null);
  const [state, setState] = useState<"idle" | "checking" | "none" | "downloading" | "error">("idle");
  const [progress, setProgress] = useState(0);
  const [err, setErr] = useState("");
  useEffect(() => { invoke<string>("app_version").then(setVersion).catch(() => {}); }, []);

  const doCheck = async () => {
    setState("checking"); setErr("");
    try { const u = await checkForUpdate(); setUpdate(u); setState(u ? "idle" : "none"); } catch (e) { setErr(String(e)); setState("error"); }
  };
  const install = async () => {
    if (!update) return;
    setState("downloading");
    try {
      let total = 0, got = 0;
      await update.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? 0;
        else if (ev.event === "Progress") { got += ev.data.chunkLength; if (total) setProgress(Math.round((got / total) * 100)); }
      });
      await relaunch();
    } catch (e) { setErr(String(e)); setState("error"); }
  };

  return (
    <div className="max-w-2xl space-y-6 text-sm">
      <section className="space-y-2">
        <h2 className="text-lg font-medium">À propos</h2>
        <p>ASSISTANT <strong>{version || "…"}</strong> — assistant personnel IA local : vos données restent sur cet appareil, seules les API que vous connectez sont appelées.</p>
        <div className="flex flex-wrap items-center gap-2">
          <button className={btn} onClick={doCheck} disabled={state === "checking" || state === "downloading"}>{state === "checking" ? "Recherche…" : "Rechercher une mise à jour"}</button>
          {state === "none" && <span role="status" className="text-green-600">Vous êtes à jour.</span>}
          {update && <>
            <span role="status">Version <strong>{update.version}</strong> disponible.</span>
            <button className={`${btn} font-medium`} onClick={install} disabled={state === "downloading"}>{state === "downloading" ? `Téléchargement… ${progress}%` : "Installer et redémarrer"}</button>
          </>}
        </div>
        {update?.body && <pre className="whitespace-pre-wrap rounded-md bg-neutral-50 p-3 text-xs dark:bg-neutral-900">{update.body}</pre>}
        {state === "error" && <p role="alert" className="text-red-600">Mise à jour impossible : {err}. Les versions sont aussi téléchargeables depuis la page des releases du projet.</p>}
        <p className="text-xs text-neutral-500">Les mises à jour sont vérifiées par une signature cryptographique avant installation. Les installateurs ne sont pas signés par Apple/Microsoft pour l'instant (voir le README).</p>
      </section>
      <section>
        <h2 className="mb-2 text-lg font-medium">Raccourcis clavier</h2>
        <table className="w-full"><tbody>{SHORTCUTS.map(([k, d]) => <tr key={k} className="border-t border-neutral-100 dark:border-neutral-900"><td className="py-1 pr-4"><kbd className="rounded border border-neutral-300 px-1.5 py-0.5 text-xs dark:border-neutral-700">{k}</kbd></td><td>{d}</td></tr>)}</tbody></table>
      </section>
    </div>
  );
}
