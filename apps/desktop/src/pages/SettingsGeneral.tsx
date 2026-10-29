import { useEffect, useState } from "react";
import { getLang, rememberLang, tr, type Lang } from "../i18n";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { rpc, type AppSettings } from "../rpc";
import { applyTheme, type Theme } from "../theme";

type S = AppSettings & {
  general: { language: "fr" | "en"; theme: Theme; launchAtLogin: boolean; checkUpdates: boolean };
  notifications: { deadlineAlerts: boolean; newProposals: boolean };
};
const input = "rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700";

export function SettingsGeneral() {
  const [s, setS] = useState<S | null>(null);
  const [msg, setMsg] = useState("");
  useEffect(() => { rpc<S>("settings.get").then(setS).catch((e) => setMsg(String(e))); }, []);
  if (!s) return <p className="text-sm text-neutral-500">{msg || tr("Chargement…")}</p>;

  const save = async (next: S) => {
    try { setS(await rpc<S>("settings.set", { settings: next })); setMsg(tr("Enregistré.")); applyTheme(next.general.theme); } catch (e) { setMsg(String(e)); }
  };
  const toggleLogin = async (v: boolean) => {
    try {
      if (v) await enable(); else await disable();
      await save({ ...s, general: { ...s.general, launchAtLogin: (await isEnabled()) } });
    } catch (e) { setMsg(tr("Démarrage automatique indisponible : {0}", e)); }
  };

  return (
    <div className="max-w-2xl space-y-6 text-sm">
      <section className="space-y-3">
        <h2 className="text-lg font-medium">{tr("Général")}</h2>
        <label className="block">{tr("Thème")}<br />
          <select className={input} value={s.general.theme} onChange={(e) => save({ ...s, general: { ...s.general, theme: e.target.value as Theme } })}>
            <option value="system">{tr("Suivre le système")}</option><option value="light">{tr("Clair")}</option><option value="dark">{tr("Sombre")}</option>
          </select></label>
        <label className="block">{tr("Langue de l'interface")}<br />
          <select className={input} value={getLang()} onChange={async (e) => {
            const l = e.target.value as Lang;
            try { await rpc<S>("settings.set", { settings: { ...s, general: { ...s.general, language: l } } }); } catch { /* la langue mémorisée suffit */ }
            rememberLang(l);
            location.reload();
          }}><option value="fr">{tr("Français")}</option><option value="en">{tr("English")}</option></select>
          <span id="lang-help" className="ml-2 text-xs text-neutral-500">{tr("L'interface est rechargée au changement de langue.")}</span></label>
        <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={s.general.launchAtLogin} onChange={(e) => toggleLogin(e.target.checked)} />
          <span>{tr("Lancer ASSISTANT à l'ouverture de session")}<br /><span className="text-neutral-500">{tr("Démarre dans la barre de menus (fenêtre masquée) pour que l'agent et la capture rapide soient prêts.")}</span></span></label>
        <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={s.general.checkUpdates} onChange={(e) => save({ ...s, general: { ...s.general, checkUpdates: e.target.checked } })} />
          <span>{tr("Rechercher les mises à jour au démarrage")}<br /><span className="text-neutral-500">{tr("Contacte GitHub (releases du projet) et n'envoie que le numéro de version et le système. Aucune donnée personnelle.")}</span></span></label>
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-medium">{tr("Notifications")}</h2>
        <label className="flex items-center gap-2"><input type="checkbox" checked={s.notifications.deadlineAlerts} onChange={(e) => save({ ...s, notifications: { ...s.notifications, deadlineAlerts: e.target.checked } })} /> {tr("Alertes d'échéances et de résiliation (jours configurés dans la page Échéances)")}</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={s.notifications.newProposals} onChange={(e) => save({ ...s, notifications: { ...s.notifications, newProposals: e.target.checked } })} /> {tr("Nouvelles suggestions de l'IA à valider")}</label>
        <p className="text-xs text-neutral-500">{tr("Le compteur sur l'icône de l'application reste toujours actif.")}</p>
      </section>
      <p role="status" className="text-neutral-500">{msg}</p>
    </div>
  );
}
