import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { rpc, type AppSettings } from "../rpc";

const input = "rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700";
const btn = "rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";

export function SettingsMeetings() {
  const [s, setS] = useState<(AppSettings & { meetings: { retainAudio: boolean; language: string }; capture: { shortcut: string } }) | null>(null);
  const [shortcut, setShortcut] = useState("");
  const [msg, setMsg] = useState("");
  useEffect(() => { rpc<NonNullable<typeof s>>("settings.get").then((x) => { setS(x); setShortcut(x.capture.shortcut); }).catch((e) => setMsg(String(e))); }, []);
  if (!s) return <p className="text-sm text-neutral-500">{msg || "Chargement…"}</p>;

  const save = async (next: NonNullable<typeof s>) => {
    try { setS(await rpc<NonNullable<typeof s>>("settings.set", { settings: next })); setMsg("Enregistré."); } catch (e) { setMsg(String(e)); }
  };
  const saveShortcut = async () => {
    try {
      await invoke("set_capture_shortcut", { accelerator: shortcut }); // refuse si invalide ou déjà pris
      await save({ ...s, capture: { shortcut } });
    } catch (e) { setMsg(String(e)); }
  };

  return (
    <div className="max-w-2xl space-y-6 text-sm">
      <section className="space-y-2">
        <h2 className="text-lg font-medium">Réunions</h2>
        <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={!s.meetings.retainAudio} onChange={(e) => save({ ...s, meetings: { ...s.meetings, retainAudio: !e.target.checked } })} />
          <span><strong>Supprimer l'audio après la transcription</strong> (recommandé)<br /><span className="text-neutral-500">Le transcript et le compte-rendu restent. Décochez pour conserver les enregistrements sur cet appareil.</span></span></label>
        <label className="block">Langue des réunions <select className={input} value={s.meetings.language} onChange={(e) => save({ ...s, meetings: { ...s.meetings, language: e.target.value } })}><option value="">Détection automatique</option><option value="fr">Français</option><option value="en">English</option></select></label>
        <p className="text-neutral-500">La transcription passe par la route « Transcription audio » (Settings → IA). Choisissez un modèle « diarize » (ex. <code>gpt-4o-transcribe-diarize</code>) pour identifier les interlocuteurs. Anthropic ne propose pas de transcription.</p>
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-medium">Capture rapide</h2>
        <label className="block">Raccourci global<br /><input className={`${input} w-64`} value={shortcut} onChange={(e) => setShortcut(e.target.value)} placeholder="CommandOrControl+Shift+Space" /></label>
        <button className={btn} disabled={!shortcut || shortcut === s.capture.shortcut} onClick={saveShortcut}>Appliquer</button>
        <p className="text-neutral-500">Syntaxe : <code>CommandOrControl+Shift+Space</code>, <code>Alt+N</code>… Le raccourci fonctionne même quand l'application est en arrière-plan (fenêtre fermée dans la barre de menus).</p>
      </section>
      <p role="status" className="text-neutral-500">{msg}</p>
    </div>
  );
}
