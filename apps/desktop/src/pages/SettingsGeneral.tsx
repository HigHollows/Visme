import { useEffect, useState } from "react";
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
  if (!s) return <p className="text-sm text-neutral-500">{msg || "Chargement…"}</p>;

  const save = async (next: S) => {
    try { setS(await rpc<S>("settings.set", { settings: next })); setMsg("Enregistré."); applyTheme(next.general.theme); } catch (e) { setMsg(String(e)); }
  };
  const toggleLogin = async (v: boolean) => {
    try {
      if (v) await enable(); else await disable();
      await save({ ...s, general: { ...s.general, launchAtLogin: (await isEnabled()) } });
    } catch (e) { setMsg(`Démarrage automatique indisponible : ${e}`); }
  };

  return (
    <div className="max-w-2xl space-y-6 text-sm">
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Général</h2>
        <label className="block">Thème<br />
          <select className={input} value={s.general.theme} onChange={(e) => save({ ...s, general: { ...s.general, theme: e.target.value as Theme } })}>
            <option value="system">Suivre le système</option><option value="light">Clair</option><option value="dark">Sombre</option>
          </select></label>
        <label className="block">Langue de l'interface<br />
          <select className={input} value="fr" disabled aria-describedby="lang-help"><option value="fr">Français</option></select>
          <span id="lang-help" className="ml-2 text-xs text-neutral-500">Seul le français est disponible pour l'instant.</span></label>
        <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={s.general.launchAtLogin} onChange={(e) => toggleLogin(e.target.checked)} />
          <span>Lancer ASSISTANT à l'ouverture de session<br /><span className="text-neutral-500">Démarre dans la barre de menus (fenêtre masquée) pour que l'agent et la capture rapide soient prêts.</span></span></label>
        <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={s.general.checkUpdates} onChange={(e) => save({ ...s, general: { ...s.general, checkUpdates: e.target.checked } })} />
          <span>Rechercher les mises à jour au démarrage<br /><span className="text-neutral-500">Contacte GitHub (releases du projet) et n'envoie que le numéro de version et le système. Aucune donnée personnelle.</span></span></label>
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-medium">Notifications</h2>
        <label className="flex items-center gap-2"><input type="checkbox" checked={s.notifications.deadlineAlerts} onChange={(e) => save({ ...s, notifications: { ...s.notifications, deadlineAlerts: e.target.checked } })} /> Alertes d'échéances et de résiliation (jours configurés dans la page Échéances)</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={s.notifications.newProposals} onChange={(e) => save({ ...s, notifications: { ...s.notifications, newProposals: e.target.checked } })} /> Nouvelles suggestions de l'IA à valider</label>
        <p className="text-xs text-neutral-500">Le compteur sur l'icône de l'application reste toujours actif.</p>
      </section>
      <p role="status" className="text-neutral-500">{msg}</p>
    </div>
  );
}
