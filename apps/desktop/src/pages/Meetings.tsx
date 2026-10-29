import { useCallback, useEffect, useState } from "react";
import { tr, locale } from "../i18n";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listMics } from "../audio";
import { rpc } from "../rpc";

interface Meeting { id: string; title: string; source: string; startedAt: number; durationMs: number; status: "recording" | "transcribing" | "processing" | "ready" | "error"; error: string | null; audioKept: boolean; documentId: string | null }
interface Detail extends Meeting {
  transcript: { start: number; end: number; speaker?: string; text: string }[];
  minutes: null | { summary: string; decisions: string[]; actions: { title: string; owner: string; due: number | null; confidence: number }[]; nextMeetings: { title: string; start: number; confidence: number }[] };
}

const btn = "rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";
const input = "rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700";
const mmss = (ms: number) => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
const STATUS: Record<Meeting["status"], string> = { recording: tr("● enregistrement"), transcribing: tr("transcription…"), processing: tr("rédaction du compte-rendu…"), ready: tr("terminée"), error: tr("à reprendre") };

export interface RecorderApi {
  recording: { id: string; title: string } | null;
  start: (o: { title: string; deviceId: string; language: string; systemAudio: boolean }) => Promise<void>;
}

function ConsentDialog({ recorder, onClose }: { recorder: RecorderApi; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [ok, setOk] = useState(false);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [device, setDevice] = useState(() => { try { return localStorage.getItem("mic") ?? ""; } catch { return ""; } });
  const [language, setLanguage] = useState("fr");
  const [err, setErr] = useState("");
  const [sys, setSys] = useState<{ supported: boolean; reason?: string } | null>(null);
  const [systemAudio, setSystemAudio] = useState(false);
  useEffect(() => { void listMics().then(setMics); invoke<{ supported: boolean; reason?: string }>("system_audio_supported").then(setSys).catch(() => setSys({ supported: false })); }, []);
  const go = async () => {
    try { try { localStorage.setItem("mic", device); } catch { /* facultatif */ } await recorder.start({ title, deviceId: device, language, systemAudio }); onClose(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label={tr("Nouvelle réunion")} onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}
        className="w-[480px] max-w-[92vw] space-y-3 rounded-xl border border-neutral-200 bg-white p-5 shadow-2xl dark:border-neutral-700 dark:bg-neutral-900">
        <h2 className="text-lg font-medium">{tr("Enregistrer une réunion")}</h2>
        <input autoFocus aria-label={tr("Titre")} placeholder={tr("Titre (facultatif)")} className={`${input} w-full`} value={title} onChange={(e) => setTitle(e.target.value)} />
        <div className="flex flex-wrap gap-3 text-sm">
          <label>{tr("Micro")}<br /><select className={input} value={device} onChange={(e) => setDevice(e.target.value)}><option value="">{tr("Micro par défaut")}</option>{mics.map((m) => <option key={m.deviceId} value={m.deviceId}>{m.label || tr("Micro")}</option>)}</select></label>
          <label>{tr("Langue")}<br /><select className={input} value={language} onChange={(e) => setLanguage(e.target.value)}><option value="fr">{tr("Français")}</option><option value="en">{tr("English")}</option><option value="">{tr("Détection auto")}</option></select></label>
        </div>
        {sys?.supported ? (
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={systemAudio} onChange={(e) => setSystemAudio(e.target.checked)} />
            <span><strong>{tr("Capter aussi le son de l'ordinateur")}</strong> {tr("(participants d'une visioconférence)")}<br /><span className="text-xs text-neutral-500">{tr("Deux pistes : « Vous » (micro) et « Participants » (système). Utilisez un casque pour éviter que le micro ne reprenne les haut-parleurs. Sur macOS, l'autorisation « Enregistrement audio du système » sera demandée.")}</span></span></label>
        ) : (
          <p className="text-xs text-neutral-500">{sys?.reason ?? tr("Audio système non disponible.")} {tr("Pour capter une visioconférence, vous pouvez choisir un périphérique de bouclage (ex. BlackHole) comme micro.")}</p>
        )}
        <label className="flex items-start gap-2 rounded-md bg-amber-50 p-3 text-sm dark:bg-amber-950/40">
          <input type="checkbox" className="mt-1" checked={ok} onChange={(e) => setOk(e.target.checked)} />
          <span><strong>{tr("J'ai prévenu les participants")}</strong> {tr("que cette réunion est enregistrée et transcrite (obligation légale dans de nombreux pays). Un indicateur rouge reste affiché pendant l'enregistrement.")}</span>
        </label>
        {err && <p role="alert" className="text-sm text-red-600">{err}</p>}
        <div className="flex justify-end gap-2"><button className={btn} onClick={onClose}>{tr("Annuler")}</button><button className={`${btn} font-medium`} disabled={!ok} onClick={go}>{tr("● Démarrer")}</button></div>
      </div>
    </div>
  );
}

export function Meetings({ recorder, onOpenDoc }: { recorder: RecorderApi; onOpenDoc: (id: string) => void }) {
  const [list, setList] = useState<Meeting[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [d, setD] = useState<Detail | null>(null);
  const [consent, setConsent] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(() => { rpc<Meeting[]>("meetings.list").then(setList).catch((e) => setMsg(String(e))); }, []);
  useEffect(load, [load]);
  useEffect(() => { if (!sel) { setD(null); return; } rpc<Detail>("meetings.get", { id: sel }).then(setD).catch((e) => setMsg(String(e))); }, [sel, list]);
  useEffect(() => {
    const un = listen<{ method: string }>("sidecar-event", ({ payload }) => { if (payload.method === "meetings.event") load(); });
    return () => void un.then((f) => f());
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => { try { await fn(); setMsg(""); } catch (e) { setMsg(String(e)); } load(); };
  const importFile = async () => {
    const p = await open({ multiple: false, filters: [{ name: tr("Audio / vidéo"), extensions: ["mp3", "mp4", "m4a", "wav", "webm", "ogg", "flac", "mpeg", "mpga"] }] });
    if (typeof p === "string") await act(async () => { const r = await rpc<{ id: string }>("meetings.import", { path: p }); setSel(r.id); });
  };

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-4">
      <aside className="flex w-72 shrink-0 flex-col">
        <div className="mb-2 flex gap-2">
          <button className={`${btn} font-medium`} disabled={!!recorder.recording} onClick={() => setConsent(true)}>{tr("● Enregistrer")}</button>
          <button className={btn} onClick={importFile}>{tr("Importer…")}</button>
        </div>
        {msg && <p role="alert" className="mb-2 text-sm text-red-600">{msg}</p>}
        <ul className="flex-1 space-y-1 overflow-y-auto">
          {list.length === 0 && <li className="text-sm text-neutral-500">{tr("Aucune réunion.")}</li>}
          {list.map((m) => (
            <li key={m.id}><button onClick={() => setSel(m.id)} className={`block w-full rounded-md px-3 py-2 text-left ${sel === m.id ? "bg-neutral-100 dark:bg-neutral-800" : "hover:bg-neutral-50 dark:hover:bg-neutral-900"}`}>
              <div className="truncate text-sm font-medium">{m.title}</div>
              <div className="text-xs text-neutral-500">{new Date(m.startedAt).toLocaleString(locale(), { dateStyle: "short", timeStyle: "short" })} · <span className={m.status === "error" ? "text-red-600" : m.status === "recording" ? "text-red-600" : ""}>{STATUS[m.status]}</span></div>
            </button></li>
          ))}
        </ul>
      </aside>

      <article className="min-w-0 flex-1 overflow-y-auto border-l border-neutral-200 pl-4 text-sm dark:border-neutral-800" aria-label={tr("Réunion")}>
        {!d ? <p className="text-neutral-500">{tr("Sélectionnez une réunion, ou enregistrez-en une.")}</p> : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-medium">{d.title}</h2>
              <span className="text-xs text-neutral-500">{STATUS[d.status]}{d.durationMs ? ` · ${mmss(d.durationMs)}` : ""}</span>
              <span className="ml-auto flex flex-wrap gap-2">
                {d.documentId && <button className={btn} onClick={() => onOpenDoc(d.documentId!)}>{tr("Compte-rendu indexé")}</button>}
                {d.transcript.length > 0 && d.status !== "processing" && <button className={btn} onClick={() => act(() => rpc("meetings.reprocess", { id: d.id }))}>{tr("Régénérer le compte-rendu")}</button>}
                {d.audioKept && d.status !== "recording" && <button className={btn} onClick={() => { if (confirm(tr("Supprimer l'audio de cette réunion ? Le transcript est conservé."))) void act(() => rpc("meetings.deleteAudio", { id: d.id })); }}>{tr("Supprimer l'audio")}</button>}
                <button className={btn} onClick={() => { const t = prompt(tr("Nouveau titre"), d.title); if (t) void act(() => rpc("meetings.rename", { id: d.id, title: t })); }}>{tr("Renommer")}</button>
                <button className={btn} onClick={() => { if (confirm(tr("Supprimer cette réunion, son transcript et son compte-rendu ?"))) void act(async () => { await rpc("meetings.delete", { id: d.id }); setSel(null); }); }}>{tr("Supprimer")}</button>
              </span>
            </div>
            {d.error && <div role="alert" className="rounded-md bg-red-50 p-3 text-red-800 dark:bg-red-950/40 dark:text-red-200">{d.error}{d.status === "error" && <button className={`${btn} ml-3`} onClick={() => act(() => rpc("meetings.retry", { id: d.id }))}>{tr("Réessayer")}</button>}</div>}
            {d.status === "transcribing" || d.status === "processing" ? <p className="text-neutral-500">{tr("Traitement en cours…")}</p> : null}
            {d.audioKept && d.status === "ready" && <p className="text-xs text-amber-700 dark:text-amber-400">{tr("L'audio de cette réunion est conservé sur cet appareil (Settings → Réunions pour le supprimer automatiquement).")}</p>}

            {d.minutes && (
              <>
                <section aria-label={tr("Compte-rendu")}><h3 className="mb-1 font-medium">{tr("Compte-rendu")}</h3><div className="whitespace-pre-wrap">{d.minutes.summary}</div></section>
                {d.minutes.decisions.length > 0 && <section><h3 className="mb-1 font-medium">{tr("Décisions")}</h3><ul className="list-disc pl-5">{d.minutes.decisions.map((x, i) => <li key={i}>{x}</li>)}</ul></section>}
                {d.minutes.actions.length > 0 && <section><h3 className="mb-1 font-medium">{tr("Actions")}</h3><ul className="list-disc pl-5">{d.minutes.actions.map((a, i) => <li key={i}>{a.title}{a.owner && ` (${a.owner})`}{a.due && tr(" — pour le {0}", new Date(a.due).toLocaleDateString(locale()))}</li>)}</ul><p className="text-xs text-neutral-500">{tr("Ces actions sont dans « À valider » ou dans vos tâches, selon le niveau d'autonomie.")}</p></section>}
                {d.minutes.nextMeetings.length > 0 && <section><h3 className="mb-1 font-medium">{tr("Prochains rendez-vous")}</h3><ul className="list-disc pl-5">{d.minutes.nextMeetings.map((a, i) => <li key={i}>{a.title} — {new Date(a.start).toLocaleString(locale(), { dateStyle: "full", timeStyle: "short" })}</li>)}</ul></section>}
              </>
            )}
            {d.transcript.length > 0 && (
              <details><summary className="cursor-pointer font-medium">{tr("Transcription (")}{d.transcript.length} {tr("passages)")}</summary>
                <ul className="mt-2 space-y-1">{d.transcript.map((s, i) => <li key={i}><span className="mr-2 font-mono text-xs text-neutral-500">{mmss(s.start)}</span>{s.speaker && <strong className="mr-1">{s.speaker} :</strong>}{s.text}</li>)}</ul>
              </details>
            )}
          </div>
        )}
      </article>
      {consent && <ConsentDialog recorder={recorder} onClose={() => setConsent(false)} />}
    </div>
  );
}
