import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { rpc } from "../rpc";

interface LockStatus { enabled: boolean; idleMinutes: number }
interface AuditRow { id: number; at: number; actor: string; action: string; detail: string | null }
const btn = "rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";
const input = "rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700";

function LockSection() {
  const [st, setSt] = useState<LockStatus | null>(null);
  const [cur, setCur] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [idle, setIdle] = useState(10);
  const [msg, setMsg] = useState("");
  const load = useCallback(() => { invoke<LockStatus>("lock_status").then((s) => { setSt(s); if (s.enabled) setIdle(s.idleMinutes); }).catch((e) => setMsg(String(e))); }, []);
  useEffect(load, [load]);
  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); setMsg(ok); setCur(""); setPw(""); setPw2(""); } catch (e) { setMsg(String(e)); } load(); };
  if (!st) return null;
  return (
    <section className="space-y-2" aria-labelledby="lock">
      <h3 id="lock" className="font-medium">Verrouillage par mot de passe</h3>
      <p className="text-neutral-600 dark:text-neutral-400">Quand le verrou est actif, la base chiffrée n'est <strong>pas ouverte</strong> au démarrage ni après verrouillage : sans le mot de passe, ni le moteur ni l'agent ne tournent. (Le déverrouillage biométrique n'est pas disponible dans cette version.) Si vous oubliez le mot de passe, il n'existe aucun moyen de le récupérer sans effacer les données.</p>
      <div className="flex flex-wrap items-end gap-2">
        {st.enabled && <label>Mot de passe actuel<br /><input type="password" className={input} value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" /></label>}
        <label>{st.enabled ? "Nouveau mot de passe" : "Mot de passe"} (8 car. min.)<br /><input type="password" className={input} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></label>
        <label>Confirmation<br /><input type="password" className={input} value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" /></label>
        <label>Verrouiller après<br /><select className={input} value={idle} onChange={(e) => setIdle(Number(e.target.value))}>{[0, 5, 10, 30, 60].map((n) => <option key={n} value={n}>{n === 0 ? "jamais (manuel)" : `${n} min d'inactivité`}</option>)}</select></label>
        <button className={btn} disabled={pw.length < 8 || pw !== pw2 || (st.enabled && !cur)} onClick={() => act(() => invoke("lock_set_password", { current: cur || null, password: pw, idleMinutes: idle }), st.enabled ? "Mot de passe modifié." : "Verrouillage activé.")}>{st.enabled ? "Modifier" : "Activer"}</button>
      </div>
      {st.enabled && (
        <div className="flex flex-wrap items-center gap-2">
          <button className={btn} onClick={() => invoke("lock_now").then(() => window.location.reload())}>Verrouiller maintenant</button>
          <button className={btn} disabled={!cur} onClick={() => act(() => invoke("lock_disable", { password: cur }), "Verrouillage désactivé.")}>Désactiver (saisir le mot de passe actuel)</button>
        </div>
      )}
      <p role="status" className="text-neutral-500">{msg}</p>
    </section>
  );
}

function AuditSection() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [err, setErr] = useState("");
  const load = useCallback((before?: number) => {
    rpc<AuditRow[]>("audit.list", { actor: actor || undefined, action: action || undefined, beforeId: before, limit: 100 })
      .then((r) => setRows((cur) => (before ? [...cur, ...r] : r))).catch((e) => setErr(String(e)));
  }, [actor, action]);
  useEffect(() => { const t = setTimeout(() => load(), 250); return () => clearTimeout(t); }, [load]);
  const csv = () => {
    const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const body = rows.map((r) => [new Date(r.at).toISOString(), r.actor, r.action, r.detail ?? ""].map((x) => q(String(x))).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([`date,acteur,action,détail\n${body}`], { type: "text/csv" }));
    a.download = "journal-assistant.csv"; a.click(); URL.revokeObjectURL(a.href);
  };
  return (
    <section className="space-y-2" aria-labelledby="audit">
      <h3 id="audit" className="font-medium">Journal d'audit</h3>
      <p className="text-neutral-600 dark:text-neutral-400">Toutes les actions de l'IA, des plugins et les vôtres sont consignées localement (jamais les clés API ni le contenu complet des mails).</p>
      <div className="flex flex-wrap items-end gap-2">
        <label>Acteur<br /><select className={input} value={actor} onChange={(e) => setActor(e.target.value)}><option value="">Tous</option><option value="user">Vous</option><option value="ai">IA</option><option value="plugin:">Plugins</option></select></label>
        <label>Action commence par<br /><input className={input} placeholder="ex. event., plugin." value={action} onChange={(e) => setAction(e.target.value)} /></label>
        <button className={btn} onClick={csv} disabled={!rows.length}>Exporter en CSV</button>
      </div>
      {err && <p role="alert" className="text-red-600">{err}</p>}
      <div className="max-h-72 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-800">
        <table className="w-full text-xs"><thead className="sticky top-0 bg-white text-left text-neutral-500 dark:bg-neutral-950"><tr><th className="p-1">Date</th><th>Acteur</th><th>Action</th><th>Détail</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id} className="border-t border-neutral-100 dark:border-neutral-900"><td className="whitespace-nowrap p-1">{new Date(r.at).toLocaleString("fr-FR")}</td><td>{r.actor}</td><td>{r.action}</td><td className="max-w-xs truncate" title={r.detail ?? ""}>{r.detail}</td></tr>)}</tbody></table>
      </div>
      {rows.length >= 100 && rows.length % 100 === 0 && <button className={btn} onClick={() => load(rows.at(-1)!.id)}>Plus ancien…</button>}
    </section>
  );
}

export function SettingsPrivacy() {
  const [msg, setMsg] = useState("");
  const exportAll = async () => {
    try {
      const path = await save({ title: "Exporter mes données", defaultPath: "assistant-export.json", filters: [{ name: "JSON", extensions: ["json"] }] });
      if (!path) return;
      const r = await rpc<{ rows: number }>("privacy.export", { path });
      setMsg(`${r.rows} enregistrements exportés. Le fichier contient vos données personnelles en clair : conservez-le avec soin.`);
    } catch (e) { setMsg(String(e)); }
  };
  const erase = async () => {
    if (!confirm("EFFACEMENT TOTAL\n\nToutes les données de TOUS les profils (mails, documents, mémoire, réglages, clés API, base chiffrée) seront supprimées de cet appareil, puis l'application se fermera. Cette action est irréversible.")) return;
    if (prompt("Tapez EFFACER pour confirmer") !== "EFFACER") return;
    try { await invoke("erase_all_data"); } catch (e) { setMsg(String(e)); }
  };
  return (
    <div className="max-w-3xl space-y-6 text-sm">
      <h2 className="text-lg font-medium">Confidentialité et sécurité</h2>
      <section className="space-y-1">
        <h3 className="font-medium">Chiffrement et envois</h3>
        <ul className="list-disc space-y-1 pl-5 text-neutral-600 dark:text-neutral-400">
          <li>Chaque profil est une base SQLCipher chiffrée ; sa clé est dans le trousseau du système (macOS Trousseau, Windows Credential Manager).</li>
          <li>Les clés API sont dans le trousseau, jamais en clair, jamais exportées.</li>
          <li>Seuls partent de l'appareil : les appels à vos fournisseurs IA (extraits minimaux, données sensibles masquées si l'option est active), à Google (mails, calendrier) et la recherche de mises à jour.</li>
          <li>Le contenu des mails, documents et transcriptions est traité comme des données, jamais comme des instructions.</li>
        </ul>
      </section>
      <LockSection />
      <section className="space-y-2">
        <h3 className="font-medium">Vos droits (RGPD)</h3>
        <div className="flex flex-wrap gap-2">
          <button className={btn} onClick={exportAll}>Exporter toutes les données de ce profil…</button>
          <button className={`${btn} text-red-700`} onClick={erase}>Effacement total de l'appareil…</button>
        </div>
        <p className="text-neutral-500">Pour effacer un seul profil : Settings › Profils. Pour effacer un compte mail et ses messages : Settings › Comptes.</p>
        <p role="status" className="text-neutral-500">{msg}</p>
      </section>
      <AuditSection />
    </div>
  );
}
