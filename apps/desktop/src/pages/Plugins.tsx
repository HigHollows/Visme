import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { describePermission, rpc } from "../rpc";

interface Plugin {
  id: string; name: string; version: string; description: string; author: string | null; permissions: string[]; granted: string[];
  enabled: boolean; needsConsent: boolean; triggers: string[]; tools: string[]; lastError: string | null;
}
interface Available { id: string; name: string; version: string; description: string; permissions: string[]; installedVersion: string | null }

const btn = "rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";

function Consent({ p, onClose, onDone }: { p: Plugin; onClose: () => void; onDone: () => void }) {
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState("");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label={`Activer ${p.name}`} onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}
        className="w-[460px] max-w-[92vw] space-y-3 rounded-xl border border-neutral-200 bg-white p-5 shadow-2xl dark:border-neutral-700 dark:bg-neutral-900">
        <h2 className="text-lg font-medium">Activer « {p.name} »</h2>
        {p.permissions.length === 0 ? <p className="text-sm">Ce plugin ne demande aucune permission.</p> : (
          <>
            <p className="text-sm">Ce plugin pourra :</p>
            <ul className="list-disc space-y-1 pl-5 text-sm">{p.permissions.map((x) => <li key={x}>{describePermission(x)}</li>)}</ul>
          </>
        )}
        <p className="text-xs text-neutral-500">Il s'exécute dans un processus isolé et ne peut jamais agir seul : au mieux, il propose des éléments à valider. Ses actions sont journalisées.</p>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /> J'accepte ces permissions</label>
        {err && <p role="alert" className="text-sm text-red-600">{err}</p>}
        <div className="flex justify-end gap-2"><button className={btn} onClick={onClose}>Annuler</button>
          <button className={`${btn} font-medium`} disabled={!ok} onClick={async () => { try { await rpc("plugins.enable", { id: p.id, permissions: p.permissions }); onDone(); onClose(); } catch (e) { setErr(String(e)); } }}>Activer</button></div>
      </div>
    </div>
  );
}

export function Plugins() {
  const [list, setList] = useState<Plugin[]>([]);
  const [avail, setAvail] = useState<Available[]>([]);
  const [consent, setConsent] = useState<Plugin | null>(null);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    try { const [l, a] = await Promise.all([rpc<Plugin[]>("plugins.list"), rpc<Available[]>("plugins.available")]); setList(l); setAvail(a); } catch (e) { setMsg(String(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<unknown>, ok = "") => { try { await fn(); setMsg(ok); } catch (e) { setMsg(String(e)); } void load(); };
  const installFolder = async () => {
    const dir = await open({ directory: true, multiple: false, title: "Dossier du plugin" });
    if (typeof dir === "string") await act(() => rpc("plugins.installFolder", { path: dir }), "Plugin installé (désactivé) : activez-le pour accepter ses permissions.");
  };

  return (
    <div className="max-w-3xl space-y-8">
      {msg && <p role="status" className="text-sm text-amber-700 dark:text-amber-400">{msg}</p>}
      <section aria-labelledby="inst">
        <div className="mb-2 flex items-center gap-3"><h2 id="inst" className="text-lg font-medium">Installés</h2><button className={btn} onClick={installFolder}>Installer depuis un dossier…</button></div>
        {list.length === 0 && <p className="text-sm text-neutral-500">Aucun plugin installé.</p>}
        <ul className="space-y-3">
          {list.map((p) => (
            <li key={p.id} className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
              <div className="flex flex-wrap items-center gap-2">
                <strong>{p.name}</strong><span className="text-xs text-neutral-500">v{p.version}{p.author ? ` · ${p.author}` : ""}</span>
                <span className={`text-xs ${p.enabled ? "text-green-600" : "text-neutral-500"}`}>{p.enabled ? "actif" : p.needsConsent ? "en attente d'autorisation" : "désactivé"}</span>
                <span className="ml-auto flex gap-2">
                  {p.enabled ? <button className={btn} onClick={() => act(() => rpc("plugins.disable", { id: p.id }))}>Désactiver</button> : <button className={`${btn} font-medium`} onClick={() => setConsent(p)}>Activer…</button>}
                  <button className={btn} onClick={() => { if (confirm(`Supprimer « ${p.name} » et ses données ?`)) void act(() => rpc("plugins.remove", { id: p.id })); }}>Supprimer</button>
                </span>
              </div>
              <p className="mt-1 text-sm">{p.description}</p>
              <details className="mt-1 text-sm"><summary className="cursor-pointer text-neutral-500">Permissions ({p.permissions.length})</summary>
                <ul className="ml-5 list-disc">{p.permissions.length ? p.permissions.map((x) => <li key={x}>{describePermission(x)} {p.granted.includes(x) ? "✓" : ""}</li>) : <li>Aucune</li>}</ul>
                {p.triggers.length > 0 && <p className="mt-1 text-xs text-neutral-500">Réagit à : {p.triggers.join(", ")}</p>}
                {p.tools.length > 0 && <p className="text-xs text-neutral-500">Outils de chat : {p.tools.map((t) => `plugin:${p.id}:${t}`).join(", ")} (à autoriser dans Settings → Préréglages)</p>}
              </details>
              {p.lastError && <p role="alert" className="mt-1 text-xs text-red-600">Dernière erreur : {p.lastError}</p>}
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="off">
        <h2 id="off" className="mb-2 text-lg font-medium">Plugins officiels</h2>
        <ul className="space-y-2">
          {avail.length === 0 && <li className="text-sm text-neutral-500">Aucun plugin officiel trouvé.</li>}
          {avail.map((a) => {
            const outdated = a.installedVersion && a.installedVersion !== a.version;
            return (
              <li key={a.id} className="flex items-center gap-3 rounded-md border border-neutral-200 p-3 text-sm dark:border-neutral-800">
                <div className="flex-1"><strong>{a.name}</strong> <span className="text-xs text-neutral-500">v{a.version}</span><p>{a.description}</p></div>
                {a.installedVersion === null ? <button className={btn} onClick={() => act(() => rpc("plugins.installBundled", { id: a.id }), "Installé (désactivé) : activez-le pour accepter ses permissions.")}>Installer</button>
                  : outdated ? <button className={btn} onClick={() => act(() => rpc("plugins.installBundled", { id: a.id }), "Mis à jour.")}>Mettre à jour ({a.installedVersion} → {a.version})</button>
                  : <span className="text-xs text-neutral-500">installé</span>}
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-xs text-neutral-500">Les plugins s'exécutent dans un bac à sable applicatif et ne peuvent que proposer des actions. Ce n'est pas une isolation système : n'installez que des plugins dont vous connaissez l'auteur. Voir docs/plugins.md.</p>
      </section>
      {consent && <Consent p={consent} onClose={() => setConsent(null)} onDone={load} />}
    </div>
  );
}
