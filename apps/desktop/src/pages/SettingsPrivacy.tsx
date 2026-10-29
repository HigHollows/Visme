import { useCallback, useEffect, useState } from "react";
import { tr, locale } from "../i18n";
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
      <h3 id="lock" className="font-medium">{tr("Verrouillage par mot de passe")}</h3>
      <p className="text-neutral-600 dark:text-neutral-400">{tr("Quand le verrou est actif, la base chiffrée n'est")} <strong>{tr("pas ouverte")}</strong> {tr("au démarrage ni après verrouillage : sans le mot de passe, ni le moteur ni l'agent ne tournent. (Le déverrouillage biométrique n'est pas disponible dans cette version.) Si vous oubliez le mot de passe, il n'existe aucun moyen de le récupérer sans effacer les données.")}</p>
      <div className="flex flex-wrap items-end gap-2">
        {st.enabled && <label>{tr("Mot de passe actuel")}<br /><input type="password" className={input} value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" /></label>}
        <label>{st.enabled ? tr("Nouveau mot de passe") : tr("Mot de passe")} {tr("(8 car. min.)")}<br /><input type="password" className={input} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></label>
        <label>{tr("Confirmation")}<br /><input type="password" className={input} value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" /></label>
        <label>{tr("Verrouiller après")}<br /><select className={input} value={idle} onChange={(e) => setIdle(Number(e.target.value))}>{[0, 5, 10, 30, 60].map((n) => <option key={n} value={n}>{n === 0 ? tr("jamais (manuel)") : tr("{0} min d'inactivité", n)}</option>)}</select></label>
        <button className={btn} disabled={pw.length < 8 || pw !== pw2 || (st.enabled && !cur)} onClick={() => act(() => invoke("lock_set_password", { current: cur || null, password: pw, idleMinutes: idle }), st.enabled ? tr("Mot de passe modifié.") : tr("Verrouillage activé."))}>{st.enabled ? tr("Modifier") : tr("Activer")}</button>
      </div>
      {st.enabled && (
        <div className="flex flex-wrap items-center gap-2">
          <button className={btn} onClick={() => invoke("lock_now").then(() => window.location.reload())}>{tr("Verrouiller maintenant")}</button>
          <button className={btn} disabled={!cur} onClick={() => act(() => invoke("lock_disable", { password: cur }), tr("Verrouillage désactivé."))}>{tr("Désactiver (saisir le mot de passe actuel)")}</button>
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
    a.href = URL.createObjectURL(new Blob([`${tr("date,acteur,action,détail")}\n${body}`], { type: "text/csv" }));
    a.download = "journal-assistant.csv"; a.click(); URL.revokeObjectURL(a.href);
  };
  return (
    <section className="space-y-2" aria-labelledby="audit">
      <h3 id="audit" className="font-medium">{tr("Journal d'audit")}</h3>
      <p className="text-neutral-600 dark:text-neutral-400">{tr("Toutes les actions de l'IA, des plugins et les vôtres sont consignées localement (jamais les clés API ni le contenu complet des mails).")}</p>
      <div className="flex flex-wrap items-end gap-2">
        <label>{tr("Acteur")}<br /><select className={input} value={actor} onChange={(e) => setActor(e.target.value)}><option value="">{tr("Tous")}</option><option value="user">{tr("Vous")}</option><option value="ai">{tr("IA")}</option><option value="plugin:">{tr("Plugins")}</option></select></label>
        <label>{tr("Action commence par")}<br /><input className={input} placeholder={tr("ex. event., plugin.")} value={action} onChange={(e) => setAction(e.target.value)} /></label>
        <button className={btn} onClick={csv} disabled={!rows.length}>{tr("Exporter en CSV")}</button>
      </div>
      {err && <p role="alert" className="text-red-600">{err}</p>}
      <div className="max-h-72 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-800">
        <table className="w-full text-xs"><thead className="sticky top-0 bg-white text-left text-neutral-500 dark:bg-neutral-950"><tr><th className="p-1">{tr("Date")}</th><th>{tr("Acteur")}</th><th>{tr("Action")}</th><th>{tr("Détail")}</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id} className="border-t border-neutral-100 dark:border-neutral-900"><td className="whitespace-nowrap p-1">{new Date(r.at).toLocaleString(locale())}</td><td>{r.actor}</td><td>{r.action}</td><td className="max-w-xs truncate" title={r.detail ?? ""}>{r.detail}</td></tr>)}</tbody></table>
      </div>
      {rows.length >= 100 && rows.length % 100 === 0 && <button className={btn} onClick={() => load(rows.at(-1)!.id)}>{tr("Plus ancien…")}</button>}
    </section>
  );
}

export function SettingsPrivacy() {
  const [msg, setMsg] = useState("");
  const exportAll = async () => {
    try {
      const path = await save({ title: tr("Exporter mes données"), defaultPath: "assistant-export.json", filters: [{ name: "JSON", extensions: ["json"] }] });
      if (!path) return;
      const r = await rpc<{ rows: number }>("privacy.export", { path });
      setMsg(tr("{0} enregistrements exportés. Le fichier contient vos données personnelles en clair : conservez-le avec soin.", r.rows));
    } catch (e) { setMsg(String(e)); }
  };
  const erase = async () => {
    if (!confirm(tr("EFFACEMENT TOTAL\n\nToutes les données de TOUS les profils (mails, documents, mémoire, réglages, clés API, base chiffrée) seront supprimées de cet appareil, puis l'application se fermera. Cette action est irréversible."))) return;
    if (prompt(tr("Tapez EFFACER pour confirmer")) !== "EFFACER") return;
    try { await invoke("erase_all_data"); } catch (e) { setMsg(String(e)); }
  };
  return (
    <div className="max-w-3xl space-y-6 text-sm">
      <h2 className="text-lg font-medium">{tr("Confidentialité et sécurité")}</h2>
      <section className="space-y-1">
        <h3 className="font-medium">{tr("Chiffrement et envois")}</h3>
        <ul className="list-disc space-y-1 pl-5 text-neutral-600 dark:text-neutral-400">
          <li>{tr("Chaque profil est une base SQLCipher chiffrée ; sa clé est dans le trousseau du système (macOS Trousseau, Windows Credential Manager).")}</li>
          <li>{tr("Les clés API sont dans le trousseau, jamais en clair, jamais exportées.")}</li>
          <li>{tr("Seuls partent de l'appareil : les appels à vos fournisseurs IA (extraits minimaux, données sensibles masquées si l'option est active), à Google (mails, calendrier) et la recherche de mises à jour.")}</li>
          <li>{tr("Le contenu des mails, documents et transcriptions est traité comme des données, jamais comme des instructions.")}</li>
        </ul>
      </section>
      <LockSection />
      <section className="space-y-2">
        <h3 className="font-medium">{tr("Vos droits (RGPD)")}</h3>
        <div className="flex flex-wrap gap-2">
          <button className={btn} onClick={exportAll}>{tr("Exporter toutes les données de ce profil…")}</button>
          <button className={`${btn} text-red-700`} onClick={erase}>{tr("Effacement total de l'appareil…")}</button>
        </div>
        <p className="text-neutral-500">{tr("Pour effacer un seul profil : Settings › Profils. Pour effacer un compte mail et ses messages : Settings › Comptes.")}</p>
        <p role="status" className="text-neutral-500">{msg}</p>
      </section>
      <AuditSection />
    </div>
  );
}
