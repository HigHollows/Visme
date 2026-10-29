import { useCallback, useEffect, useRef, useState } from "react";
import { tr } from "./i18n";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { blobToBase64, SimpleRecorder } from "./audio";
import { rpc } from "./rpc";

interface Result { kind: string; message: string }
const btn = "rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";
const input = "w-full rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm dark:border-neutral-700";

/** Petite fenêtre flottante de capture rapide (raccourci global). */
export function CaptureApp() {
  const [text, setText] = useState("");
  const [instruction, setInstruction] = useState("");
  const [image, setImage] = useState<{ b64: string; mime: string } | null>(null);
  const [audio, setAudio] = useState<{ data: string; mime: string } | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const [err, setErr] = useState("");
  const [over, setOver] = useState(false);
  const rec = useRef(new SimpleRecorder());
  const area = useRef<HTMLTextAreaElement>(null);

  const reset = useCallback(() => {
    setText(""); setInstruction(""); setImage(null); setAudio(null); setFiles([]); setResults(null); setErr(""); setRecording(false);
    rec.current.cancel();
    setTimeout(() => area.current?.focus(), 50);
  }, []);

  useEffect(() => {
    const un1 = listen("capture-open", reset);
    const un2 = getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === "enter" || p.type === "over") setOver(true);
      else if (p.type === "leave") setOver(false);
      else if (p.type === "drop") { setOver(false); setFiles((f) => [...new Set([...f, ...p.paths])]); }
    });
    reset();
    return () => { void un1.then((f) => f()); void un2.then((f) => f()); };
  }, [reset]);

  const nothing = !text.trim() && !instruction.trim() && !image && !audio && files.length === 0;

  const send = async () => {
    if (nothing || busy) return;
    setBusy(true); setErr("");
    try {
      const r = await rpc<Result[]>("capture.submit", {
        text, instruction, filePaths: files,
        ...(image && { imageB64: image.b64, imageMime: image.mime }),
        ...(audio && { audioB64: audio.data, audioMime: audio.mime }),
      });
      setResults(r);
      setText(""); setInstruction(""); setImage(null); setAudio(null); setFiles([]);
    } catch (e) { setErr(String(e)); }
    setBusy(false);
  };

  const onPaste = async (e: React.ClipboardEvent) => {
    const f = [...e.clipboardData.files].find((x) => x.type.startsWith("image/"));
    if (f) { e.preventDefault(); setImage({ b64: await blobToBase64(f), mime: f.type }); }
  };
  const pasteClipboard = async () => {
    try { const clip = await navigator.clipboard.readText(); setText((t) => (t ? t + "\n" : "") + clip); } catch { setErr(tr("Presse-papiers inaccessible : collez avec Ctrl/Cmd+V.")); }
  };
  const screenshot = async () => {
    try { setImage({ b64: await invoke<string>("capture_screen"), mime: "image/png" }); setErr(""); } catch (e) { setErr(String(e)); }
  };
  const toggleVoice = async () => {
    try {
      if (!recording) { await rec.current.start(); setRecording(true); }
      else { setAudio(await rec.current.stop()); setRecording(false); }
    } catch (e) { setErr(tr("Micro indisponible : {0}", e instanceof Error ? e.message : e)); setRecording(false); }
  };

  return (
    <div className="flex h-screen flex-col gap-2 bg-white p-3 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100"
      onKeyDown={(e) => { if (e.key === "Escape") void invoke("hide_capture"); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(); }}>
      {results ? (
        <div className="flex flex-1 flex-col justify-center gap-3" role="status">
          {results.map((r, i) => <p key={i} className="text-sm">✔ {r.message}</p>)}
          <div className="flex gap-2"><button className={`${btn} font-medium`} autoFocus onClick={reset}>{tr("Nouvelle capture")}</button><button className={btn} onClick={() => invoke("hide_capture")}>{tr("Fermer")}</button></div>
        </div>
      ) : (
        <>
          <textarea ref={area} aria-label={tr("Contenu à capturer")} autoFocus rows={5} className={`${input} flex-1 resize-none`} placeholder={tr("Tapez, collez un texte ou une image, ou glissez des fichiers ici…")} value={text}
            onChange={(e) => setText(e.target.value)} onPaste={onPaste} />
          <input aria-label={tr("Que faire de ça ?")} className={input} placeholder={tr("Que faire de ça ? (facultatif) — ex. « ajoute ça à mon agenda vendredi »")} value={instruction} onChange={(e) => setInstruction(e.target.value)} />
          {(image || audio || files.length > 0) && (
            <div className={`flex flex-wrap gap-2 text-xs ${over ? "text-blue-600" : ""}`}>
              {image && <span className="rounded bg-neutral-100 px-2 py-1 dark:bg-neutral-800">{tr("🖼 image")} <button aria-label={tr("Retirer l'image")} onClick={() => setImage(null)}>{tr("×")}</button></span>}
              {audio && <span className="rounded bg-neutral-100 px-2 py-1 dark:bg-neutral-800">{tr("🎙 note vocale")} <button aria-label={tr("Retirer la note vocale")} onClick={() => setAudio(null)}>{tr("×")}</button></span>}
              {files.map((f) => <span key={f} className="rounded bg-neutral-100 px-2 py-1 dark:bg-neutral-800">📄 {f.split(/[\\/]/).pop()} <button aria-label={tr("Retirer le fichier")} onClick={() => setFiles(files.filter((x) => x !== f))}>{tr("×")}</button></span>)}
            </div>
          )}
          {over && <p className="rounded-md border-2 border-dashed border-blue-500 p-2 text-center text-sm text-blue-600">{tr("Déposez les fichiers")}</p>}
          {err && <p role="alert" className="text-xs text-red-600">{err}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <button className={btn} onClick={pasteClipboard}>{tr("Coller")}</button>
            <button className={btn} onClick={screenshot}>{tr("Capturer l'écran")}</button>
            <button className={`${btn} ${recording ? "border-red-500 text-red-600" : ""}`} onClick={toggleVoice} aria-pressed={recording}>{recording ? tr("■ Arrêter") : tr("🎙 Voix")}</button>
            <span className="ml-auto text-xs text-neutral-500">{tr("⌘/Ctrl+Entrée")}</span>
            <button className={`${btn} font-medium`} disabled={nothing || busy || recording} onClick={send}>{busy ? tr("Envoi…") : tr("Envoyer")}</button>
          </div>
        </>
      )}
    </div>
  );
}
