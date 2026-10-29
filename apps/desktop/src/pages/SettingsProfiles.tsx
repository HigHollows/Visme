import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface Profile { id: string; name: string; color: string }
export interface Registry { current: string; profiles: Profile[] }
const btn = "rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";
const input = "rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700";
const COLORS = ["#2563eb", "#16a34a", "#ea580c", "#9333ea", "#dc2626", "#0891b2", "#ca8a04", "#64748b"];

export function SettingsProfiles() {
  const [reg, setReg] = useState<Registry | null>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState(COLORS[1]!);
  const [msg, setMsg] = useState("");
  const load = useCallback(() => { invoke<Registry>("profiles_list").then(setReg).catch((e) => setMsg(String(e))); }, []);
  useEffect(load, [load]);
  if (!reg) return <p className="text-sm text-neutral-500">{msg || "Chargement…"}</p>;
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); setMsg(""); } catch (e) { setMsg(String(e)); } load(); };

  return (
    <div className="max-w-2xl space-y-4 text-sm">
      <p className="text-neutral-600 dark:text-neutral-400">Chaque profil a sa propre base chiffrée : comptes, mémoire, documents, règles, préréglages, style de réponse, clés API, plafonds de coût et niveau d'autonomie. Rien n'est partagé : quand vous changez de profil, le moteur du précédent est arrêté et aucune de ses données n'est envoyée à l'IA dans le contexte du suivant. L'agent d'arrière-plan ne travaille que pour le profil actif.</p>
      <ul className="space-y-2">
        {reg.profiles.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-2 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
            <span className="inline-block h-3 w-3 rounded-full" style={{ background: p.color }} />
            <strong>{p.name}</strong>{reg.current === p.id && <span className="text-xs text-green-600">actif</span>}
            <span className="ml-auto flex gap-2">
              {reg.current !== p.id && <button className={btn} onClick={() => act(() => invoke("profile_switch", { id: p.id }))}>Basculer</button>}
              <button className={btn} onClick={() => { const n = prompt("Nom du profil", p.name); if (n) void act(() => invoke("profile_rename", { id: p.id, name: n, color: p.color })); }}>Renommer</button>
              <button className={btn} disabled={reg.current === p.id || reg.profiles.length <= 1} onClick={() => { if (confirm(`Supprimer définitivement le profil « ${p.name} » et toutes ses données ?`)) void act(() => invoke("profile_delete", { id: p.id })); }}>Supprimer</button>
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-2">
        <label>Nouveau profil<br /><input className={input} value={name} placeholder="ex. Perso, Association" onChange={(e) => setName(e.target.value)} /></label>
        <div role="radiogroup" aria-label="Couleur" className="flex gap-1">{COLORS.map((c) => <button key={c} role="radio" aria-checked={color === c} aria-label={c} onClick={() => setColor(c)} className={`h-6 w-6 rounded-full border-2 ${color === c ? "border-black dark:border-white" : "border-transparent"}`} style={{ background: c }} />)}</div>
        <button className={btn} disabled={!name.trim()} onClick={() => act(async () => { await invoke("profile_create", { name, color }); setName(""); })}>Créer</button>
      </div>
      <p className="text-xs text-neutral-500">Un nouveau profil démarre vide : reconfigurez-y vos fournisseurs IA et comptes (Settings → IA, Comptes). Raccourci de changement rapide : Ctrl/Cmd+Maj+P.</p>
      {msg && <p role="alert" className="text-red-600">{msg}</p>}
    </div>
  );
}
