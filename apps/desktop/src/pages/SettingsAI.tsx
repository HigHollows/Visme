import { useCallback, useEffect, useState } from "react";
import { tr } from "../i18n";
import { invoke } from "@tauri-apps/api/core";
import { rpc, TASKS, type AiStatus, type AppSettings, type Kind, type TaskRoute } from "../rpc";

const input = "rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700";
const btn = "rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800";

type TestState = { ok: boolean; error?: string } | "pending";

export function SettingsAI() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState("");
  const [np, setNp] = useState<{ id: string; kind: Kind; baseUrl: string }>({ id: "", kind: "anthropic", baseUrl: "" });

  const refreshStatus = useCallback(() => rpc<AiStatus>("ai.status").then(setStatus), []);

  useEffect(() => {
    rpc<AppSettings>("settings.get").then(setSettings).catch((e) => setMsg(String(e)));
    refreshStatus().catch((e) => setMsg(String(e)));
  }, [refreshStatus]);

  if (!settings) return <p className="text-sm text-neutral-500">{msg || tr("Chargement…")}</p>;
  const ai = settings.ai;
  const providerIds = Object.keys(ai.providers);

  const patch = (fn: (a: AppSettings["ai"]) => void) => {
    const next = structuredClone(settings);
    fn(next.ai);
    setSettings(next);
    setDirty(true);
  };

  const save = async () => {
    try {
      setSettings(await rpc<AppSettings>("settings.set", { settings }));
      setDirty(false);
      setMsg(tr("Réglages enregistrés."));
      await refreshStatus();
    } catch (e) {
      setMsg(tr("Erreur : {0}", e));
    }
  };

  const saveKey = async (id: string) => {
    await invoke("secret_set", { provider: id, key: keys[id] ?? "" });
    setKeys((k) => ({ ...k, [id]: "" }));
    await refreshStatus();
    setMsg(tr("Clé de « {0} » enregistrée dans le trousseau système.", id));
  };

  const test = async (id: string) => {
    if (dirty) await save(); // le sidecar teste la configuration enregistrée
    setTests((t) => ({ ...t, [id]: "pending" }));
    try {
      const r = await rpc<{ ok: boolean; error?: string }>("ai.test", { provider: id });
      setTests((t) => ({ ...t, [id]: r }));
    } catch (e) {
      setTests((t) => ({ ...t, [id]: { ok: false, error: String(e) } }));
    }
  };

  const addProvider = () => {
    const id = np.id.trim();
    if (!/^[a-z0-9_-]+$/i.test(id) || ai.providers[id]) return setMsg(tr("Identifiant invalide ou déjà utilisé."));
    if (np.kind === "openai_compatible" && !np.baseUrl) return setMsg(tr("URL de base requise."));
    patch((a) => {
      a.providers[id] = { kind: np.kind, ...(np.baseUrl && { baseUrl: np.baseUrl }) };
    });
    setNp({ id: "", kind: "anthropic", baseUrl: "" });
  };

  const setRoute = (task: string, slot: "primary" | "fallback", field: "provider" | "model", v: string) =>
    patch((a) => {
      const r: TaskRoute = a.routes[task] ?? { primary: { provider: providerIds[0] ?? "", model: "" } };
      if (slot === "fallback" && !r.fallback) r.fallback = { provider: providerIds[0] ?? "", model: "" };
      if (slot === "primary") r.primary = { ...r.primary, [field]: v };
      else if (r.fallback) r.fallback = { ...r.fallback, [field]: v };
      if (slot === "fallback" && field === "provider" && v === "") delete r.fallback;
      a.routes[task] = r;
    });

  const num = (v: string) => (v === "" ? undefined : Math.max(0, Number(v)));

  return (
    <div className="max-w-3xl space-y-8">
      <section aria-labelledby="prov">
        <h2 id="prov" className="mb-2 text-lg font-medium">{tr("Fournisseurs et clés API")}</h2>
        <p className="mb-3 text-sm text-neutral-500">
          {tr("Les clés sont stockées dans le trousseau du système et ne sont jamais relues par l'interface.")}
        </p>
        <ul className="space-y-3">
          {providerIds.map((id) => {
            const has = status?.providers.find((p) => p.id === id)?.hasKey;
            const t = tests[id];
            return (
              <li key={id} className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="text-sm">{id}</strong>
                  <span className="text-xs text-neutral-500">{ai.providers[id]!.kind}{ai.providers[id]!.baseUrl ? ` · ${ai.providers[id]!.baseUrl}` : ""}</span>
                  <span className={`text-xs ${has ? "text-green-600" : "text-amber-600"}`}>{has ? tr("clé enregistrée") : tr("aucune clé")}</span>
                  <button className={`${btn} ml-auto`} onClick={() => patch((a) => { delete a.providers[id]; })}>{tr("Retirer")}</button>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    type="password"
                    autoComplete="off"
                    aria-label={tr("Clé API {0}", id)}
                    placeholder={has ? tr("•••••••• (remplacer)") : tr("Coller la clé API")}
                    className={`${input} w-72`}
                    value={keys[id] ?? ""}
                    onChange={(e) => setKeys((k) => ({ ...k, [id]: e.target.value }))}
                  />
                  <button className={btn} disabled={!keys[id]} onClick={() => saveKey(id)}>{tr("Enregistrer la clé")}</button>
                  {has && <button className={btn} onClick={() => invoke("secret_set", { provider: id, key: "" }).then(refreshStatus)}>{tr("Supprimer la clé")}</button>}
                  <button className={btn} onClick={() => test(id)}>{tr("Tester la connexion")}</button>
                  <span role="status" className="text-sm">
                    {t === "pending" ? tr("Test en cours…") : t ? (t.ok ? tr("✅ Connexion réussie") : `❌ ${t.error}`) : ""}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-xs">{tr("Identifiant")}<br /><input className={`${input} w-32`} value={np.id} onChange={(e) => setNp({ ...np, id: e.target.value })} /></label>
          <label className="text-xs">{tr("Type")}<br />
            <select className={input} value={np.kind} onChange={(e) => setNp({ ...np, kind: e.target.value as Kind })}>
              <option value="anthropic">{tr("Anthropic (Claude)")}</option>
              <option value="openai">{tr("OpenAI (GPT)")}</option>
              <option value="openai_compatible">{tr("Compatible OpenAI")}</option>
            </select>
          </label>
          {np.kind !== "anthropic" && (
            <label className="text-xs">{tr("URL de base")}{np.kind === "openai" ? tr(" (optionnel)") : ""}<br /><input className={`${input} w-64`} placeholder={tr("https://…/v1")} value={np.baseUrl} onChange={(e) => setNp({ ...np, baseUrl: e.target.value })} /></label>
          )}
          <button className={btn} onClick={addProvider}>{tr("Ajouter")}</button>
        </div>
      </section>

      <section aria-labelledby="routes">
        <h2 id="routes" className="mb-2 text-lg font-medium">{tr("Modèle par tâche")}</h2>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-neutral-500">
            <tr><th className="py-1">{tr("Tâche")}</th><th>{tr("Fournisseur / modèle")}</th><th>{tr("Secours (optionnel)")}</th></tr>
          </thead>
          <tbody>
            {TASKS.map((t) => {
              const r = ai.routes[t.id];
              return (
                <tr key={t.id} className="border-t border-neutral-200 align-top dark:border-neutral-800">
                  <td className="py-2 pr-2">{t.label}<div className="text-xs text-neutral-500">{t.hint}</div></td>
                  <td className="py-2 pr-2">
                    <select aria-label={tr("Fournisseur {0}", t.label)} className={input} value={r?.primary.provider ?? ""} onChange={(e) => setRoute(t.id, "primary", "provider", e.target.value)}>
                      <option value="" disabled>—</option>
                      {providerIds.map((id) => <option key={id}>{id}</option>)}
                    </select>{" "}
                    <input aria-label={tr("Modèle {0}", t.label)} className={`${input} w-44`} placeholder={tr("modèle")} value={r?.primary.model ?? ""} onChange={(e) => setRoute(t.id, "primary", "model", e.target.value)} />
                  </td>
                  <td className="py-2">
                    <select aria-label={tr("Fournisseur de secours {0}", t.label)} className={input} value={r?.fallback?.provider ?? ""} onChange={(e) => setRoute(t.id, "fallback", "provider", e.target.value)}>
                      <option value="">{tr("aucun")}</option>
                      {providerIds.map((id) => <option key={id}>{id}</option>)}
                    </select>{" "}
                    {r?.fallback && <input aria-label={tr("Modèle de secours {0}", t.label)} className={`${input} w-44`} placeholder={tr("modèle")} value={r.fallback.model} onChange={(e) => setRoute(t.id, "fallback", "model", e.target.value)} />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="cost">
        <h2 id="cost" className="mb-2 text-lg font-medium">{tr("Coûts et confidentialité")}</h2>
        <div className="space-y-2 text-sm">
          <p>{tr("Dépense :")} <strong>{status?.usage.todayUsd.toFixed(4) ?? "…"} $</strong> {tr("aujourd'hui ·")} <strong>{status?.usage.monthUsd.toFixed(4) ?? "…"} $</strong> {tr("ce mois-ci")}</p>
          <label className="mr-4">{tr("Plafond journalier ($)")} <input type="number" min="0" step="0.5" className={`${input} w-24`} value={ai.limits.dailyUsd ?? ""} onChange={(e) => patch((a) => { a.limits.dailyUsd = num(e.target.value) || undefined; })} /></label>
          <label>{tr("Plafond mensuel ($)")} <input type="number" min="0" step="1" className={`${input} w-24`} value={ai.limits.monthlyUsd ?? ""} onChange={(e) => patch((a) => { a.limits.monthlyUsd = num(e.target.value) || undefined; })} /></label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={ai.redactSensitive} onChange={(e) => patch((a) => { a.redactSensitive = e.target.checked; })} /> {tr("Masquer les données sensibles (IBAN, cartes, mots de passe, clés) avant envoi")}</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={ai.economyMode} onChange={(e) => patch((a) => { a.economyMode = e.target.checked; })} /> {tr("Mode économique")}</label>
        </div>
      </section>

      <div className="sticky bottom-0 flex items-center gap-3 bg-white/90 py-3 dark:bg-neutral-950/90">
        <button className={`${btn} font-medium`} disabled={!dirty} onClick={save}>{tr("Enregistrer les réglages")}</button>
        <span role="status" className="text-sm text-neutral-500">{dirty ? tr("Modifications non enregistrées") : msg}</span>
      </div>
    </div>
  );
}
