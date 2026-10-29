import { useEffect, useState } from "react";
import { tr } from "../i18n";
import { rpc, type AgentSettings, type Autonomy, type AppSettings } from "../rpc";

const input = "rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700";
const btn = "rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";

const LEVELS: { id: Autonomy; label: string; help: string }[] = [
  { id: "observe", label: tr("Observer"), help: tr("Trie et résume les mails, mais ne crée jamais rien.") },
  { id: "propose", label: tr("Proposer"), help: tr("Tout ce que l'IA détecte (événements, tâches) arrive dans « À valider ».") },
  { id: "act_with_approval", label: tr("Agir avec validation"), help: tr("Les événements très fiables (preuve retrouvée dans le mail, confiance au-dessus du seuil) sont ajoutés seuls et annulables ; le reste est validé par vous.") },
  { id: "act_alone", label: tr("Agir seul"), help: tr("Événements et tâches fiables sont ajoutés seuls et annulables. Un envoi de mail, une suppression ou un paiement exigent toujours votre validation.") },
];

export function SettingsAgent() {
  const [s, setS] = useState<AppSettings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => { rpc<AppSettings>("settings.get").then(setS).catch((e) => setMsg(String(e))); }, []);
  if (!s) return <p className="text-sm text-neutral-500">{msg || tr("Chargement…")}</p>;
  const a = (s as unknown as { agent: AgentSettings }).agent;
  const hasTriage = !!s.ai.routes.triage;

  const patch = (p: Partial<AgentSettings>) => {
    setS({ ...s, agent: { ...a, ...p } } as AppSettings);
    setDirty(true);
  };
  const save = async () => {
    try { setS(await rpc<AppSettings>("settings.set", { settings: s })); setDirty(false); setMsg(tr("Réglages enregistrés.")); }
    catch (e) { setMsg(tr("Erreur : {0}", e)); }
  };

  return (
    <div className="max-w-2xl space-y-6">
      <section aria-labelledby="ag-en">
        <h2 id="ag-en" className="mb-2 text-lg font-medium">{tr("Agent d'arrière-plan")}</h2>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={a.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
          <span><strong>{tr("Analyser automatiquement mes mails")}</strong><br />
            <span className="text-neutral-500">{tr("Lorsque c'est activé, des extraits de vos mails (objet, expéditeur, 4 000 premiers caractères, données sensibles masquées) sont envoyés au fournisseur IA choisi pour la tâche « Tri des mails ». Désactivé par défaut.")}</span></span>
        </label>
        {a.enabled && !hasTriage && <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">{tr("Aucune route « Tri des mails » : configurez-la dans l'onglet IA, sinon l'agent ne fera rien.")}</p>}
      </section>

      <section aria-labelledby="ag-aut">
        <h2 id="ag-aut" className="mb-2 text-lg font-medium">{tr("Niveau d'autonomie")}</h2>
        <div role="radiogroup" className="space-y-2">
          {LEVELS.map((l) => (
            <label key={l.id} className="flex items-start gap-2 text-sm">
              <input type="radio" name="autonomy" className="mt-1" checked={a.autonomy === l.id} onChange={() => patch({ autonomy: l.id })} />
              <span><strong>{l.label}</strong><br /><span className="text-neutral-500">{l.help}</span></span>
            </label>
          ))}
        </div>
      </section>

      <section aria-labelledby="ag-par" className="space-y-3 text-sm">
        <h2 id="ag-par" className="text-lg font-medium">{tr("Paramètres")}</h2>
        <label className="block">{tr("Fréquence de synchronisation : toutes les")}{" "}
          <input type="number" min={1} max={1440} className={`${input} w-20`} value={a.syncIntervalMinutes} onChange={(e) => patch({ syncIntervalMinutes: Math.min(1440, Math.max(1, Math.round(Number(e.target.value) || 15))) })} /> {tr("minutes")}</label>
        <label className="block">{tr("Seuil de confiance pour agir seul :")} <strong>{Math.round(a.eventConfidenceThreshold * 100)} %</strong>
          <input type="range" min={0.5} max={1} step={0.05} className="ml-3 align-middle" value={a.eventConfidenceThreshold} onChange={(e) => patch({ eventConfidenceThreshold: Number(e.target.value) })} /></label>
        <p className="text-neutral-500">{tr("Sous ce seuil, ou si la preuve citée est introuvable dans le mail, la suggestion passe par « À valider ».")}</p>
        <label className="flex items-center gap-2 text-neutral-500"><input type="checkbox" checked disabled /> {tr("Mails : brouillons seulement, jamais d'envoi sans validation (aucun envoi n'est encore possible).")}</label>
      </section>

      <div className="flex items-center gap-3">
        <button className={`${btn} font-medium`} disabled={!dirty} onClick={save}>{tr("Enregistrer")}</button>
        <span role="status" className="text-sm text-neutral-500">{dirty ? tr("Modifications non enregistrées") : msg}</span>
      </div>
    </div>
  );
}
