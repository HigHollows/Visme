import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Écran de verrouillage : tant qu'il est affiché, le moteur n'est pas démarré et la base chiffrée n'est pas ouverte. */
export function LockScreen() {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr("");
    try { await invoke("unlock", { password: pw }); window.location.reload(); }
    catch (x) { setErr(String(x)); setBusy(false); setPw(""); }
  };
  return (
    <main className="flex h-screen items-center justify-center bg-white p-6 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <form onSubmit={submit} className="w-80 space-y-4 text-center" aria-labelledby="lock-title">
        <div className="text-4xl" aria-hidden>🔒</div>
        <h1 id="lock-title" className="text-xl font-semibold">ASSISTANT est verrouillé</h1>
        <input type="password" autoFocus autoComplete="current-password" aria-label="Mot de passe" placeholder="Mot de passe" value={pw} onChange={(e) => setPw(e.target.value)}
          className="w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 dark:border-neutral-700" />
        {err && <p role="alert" className="text-sm text-red-600">{err}</p>}
        <button type="submit" disabled={!pw || busy} className="w-full rounded-md border border-neutral-300 px-3 py-2 font-medium hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800">{busy ? "Vérification…" : "Déverrouiller"}</button>
        <p className="text-xs text-neutral-500">Vos données restent chiffrées tant que l'application est verrouillée.</p>
      </form>
    </main>
  );
}
