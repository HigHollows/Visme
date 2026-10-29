import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { rpc } from "../rpc";

interface Account {
  id: string; provider: string; email: string; status: "ok" | "reauth";
  syncStatus: "idle" | "syncing" | "error"; syncError: string | null; lastSyncAt: number | null; mailCount: number;
}

const input = "rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700";
const btn = "rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";

export function SettingsAccounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [hasSecret, setHasSecret] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [msg, setMsg] = useState("");

  const refresh = useCallback(() => rpc<Account[]>("accounts.list").then(setAccounts).catch((e) => setMsg(String(e))), []);

  useEffect(() => {
    rpc<{ clientId: string; hasSecret: boolean }>("google.config.get").then((c) => { setClientId(c.clientId); setHasSecret(c.hasSecret); });
    refresh();
    const un = listen<{ method: string }>("sidecar-event", ({ payload }) => { if (payload.method === "mail.event") refresh(); });
    return () => void un.then((f) => f());
  }, [refresh]);

  const saveConfig = async () => {
    try {
      await rpc("google.config.set", { clientId, clientSecret: secret });
      setSecret(""); setHasSecret(hasSecret || !!secret);
      setMsg("Identifiants Google enregistrés.");
    } catch (e) { setMsg(String(e)); }
  };

  const connect = async () => {
    setConnecting(true);
    setMsg("Une page Google s'est ouverte dans votre navigateur : autorisez l'accès en lecture à vos mails…");
    try {
      const a = await rpc<{ email: string }>("accounts.connectGoogle");
      setMsg(`Compte ${a.email} connecté ; synchronisation en cours.`);
    } catch (e) { setMsg(`Connexion impossible : ${e}`); }
    setConnecting(false);
    refresh();
  };

  return (
    <div className="max-w-3xl space-y-8">
      <section aria-labelledby="g">
        <h2 id="g" className="mb-2 text-lg font-medium">Google (Gmail)</h2>
        <details className="mb-3 text-sm text-neutral-600 dark:text-neutral-400">
          <summary className="cursor-pointer">Comment obtenir l'identifiant client ?</summary>
          <ol className="ml-5 mt-2 list-decimal space-y-1">
            <li>Console Google Cloud → créez un projet, activez l'<em>API Gmail</em>.</li>
            <li>« Écran de consentement OAuth » : type Externe, ajoutez votre adresse comme utilisateur de test.</li>
            <li>« Identifiants » → Créer → <em>ID client OAuth</em> → type <strong>Application de bureau</strong>.</li>
            <li>Collez ci-dessous l'ID client (et le code secret s'il est affiché). Aucun serveur tiers n'est impliqué.</li>
          </ol>
        </details>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs">ID client<br /><input className={`${input} w-96`} value={clientId} placeholder="xxx.apps.googleusercontent.com" onChange={(e) => setClientId(e.target.value)} /></label>
          <label className="text-xs">Code secret (optionnel)<br /><input type="password" autoComplete="off" className={`${input} w-56`} value={secret} placeholder={hasSecret ? "•••••• (remplacer)" : ""} onChange={(e) => setSecret(e.target.value)} /></label>
          <button className={btn} onClick={saveConfig} disabled={!clientId}>Enregistrer</button>
        </div>
      </section>

      <section aria-labelledby="acc">
        <div className="mb-2 flex items-center gap-3">
          <h2 id="acc" className="text-lg font-medium">Comptes connectés</h2>
          <button className={btn} onClick={connect} disabled={connecting || !clientId}>{connecting ? "En attente de Google…" : "Connecter un compte Gmail"}</button>
        </div>
        {msg && <p role="status" className="mb-2 text-sm text-neutral-600 dark:text-neutral-400">{msg}</p>}
        <ul className="space-y-2">
          {accounts.length === 0 && <li className="text-sm text-neutral-500">Aucun compte connecté.</li>}
          {accounts.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 rounded-md border border-neutral-200 p-3 text-sm dark:border-neutral-800">
              <strong>{a.email}</strong>
              <span className="text-xs text-neutral-500">{a.provider} · {a.mailCount} mails</span>
              <span className={`text-xs ${a.status === "reauth" || a.syncStatus === "error" ? "text-red-600" : a.syncStatus === "syncing" ? "text-amber-600" : "text-green-600"}`}>
                {a.status === "reauth" ? "à reconnecter" : a.syncStatus === "syncing" ? "synchronisation…" : a.syncStatus === "error" ? `erreur : ${a.syncError}` : a.lastSyncAt ? `synchronisé ${new Date(a.lastSyncAt).toLocaleString("fr-FR")}` : ""}
              </span>
              <span className="ml-auto flex gap-2">
                <button className={btn} disabled={a.syncStatus === "syncing"} onClick={() => rpc("mail.sync", { accountId: a.id }).then(refresh)}>Synchroniser</button>
                <button className={btn} onClick={async () => { if (confirm(`Retirer ${a.email} et supprimer ses mails de cet appareil ?`)) { await rpc("accounts.remove", { id: a.id }); refresh(); } }}>Retirer</button>
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-neutral-500">Accès en lecture seule. Les mails sont stockés uniquement dans la base chiffrée de cet appareil ; rien n'est envoyé à l'IA pour l'instant.</p>
      </section>
    </div>
  );
}
