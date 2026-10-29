import { useCallback, useEffect, useState } from "react";
import { rpc, type AppSettings, type Preset } from "../rpc";

const input = "rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700";
const btn = "rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";
const BUILTIN_TOOLS: [string, string][] = [["search_data", "Chercher dans mes données"], ["create_event", "Proposer un événement"], ["create_task", "Proposer une tâche"]];

export function SettingsPresets() {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [pluginTools, setPluginTools] = useState<string[]>([]);
  const [providers, setProviders] = useState<string[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [f, setF] = useState<Omit<Preset, "id" | "builtin">>({ name: "", systemPrompt: "", tools: [], tone: "", language: "", provider: null, model: null });
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const [p, pl, s] = await Promise.all([rpc<Preset[]>("presets.list"), rpc<{ id: string; enabled: boolean; tools: string[] }[]>("plugins.list"), rpc<AppSettings>("settings.get")]);
    setPresets(p);
    setPluginTools(pl.filter((x) => x.enabled).flatMap((x) => x.tools.map((t) => `plugin:${x.id}:${t}`)));
    setProviders(Object.keys(s.ai.providers));
  }, []);
  useEffect(() => { void load(); }, [load]);

  const pick = (p: Preset | null) => {
    setSel(p?.id ?? "new");
    setF(p ? { name: p.name, systemPrompt: p.systemPrompt, tools: p.tools, tone: p.tone, language: p.language, provider: p.provider, model: p.model } : { name: "", systemPrompt: "", tools: ["search_data"], tone: "", language: "", provider: null, model: null });
    setMsg("");
  };
  const cur = presets.find((p) => p.id === sel);
  const save = async () => {
    try {
      const body = { ...f, provider: f.provider || null, model: f.model || null };
      const saved = await rpc<Preset>(cur ? "presets.update" : "presets.create", cur ? { id: cur.id, ...body } : body);
      await load(); setSel(saved.id); setMsg("Enregistré.");
    } catch (e) { setMsg(String(e)); }
  };
  const toggleTool = (t: string) => setF({ ...f, tools: f.tools.includes(t) ? f.tools.filter((x) => x !== t) : [...f.tools, t] });

  return (
    <div className="flex max-w-4xl gap-6">
      <aside className="w-56 shrink-0">
        <button className={`${btn} mb-2 w-full`} onClick={() => pick(null)}>+ Nouveau préréglage</button>
        <ul className="space-y-1">{presets.map((p) => <li key={p.id}><button onClick={() => pick(p)} className={`w-full truncate rounded-md px-2 py-1 text-left text-sm ${sel === p.id ? "bg-neutral-100 dark:bg-neutral-800" : "hover:bg-neutral-50 dark:hover:bg-neutral-900"}`}>{p.name}{p.builtin && <span className="ml-1 text-xs text-neutral-400">·</span>}</button></li>)}</ul>
      </aside>
      <section className="min-w-0 flex-1 space-y-3 text-sm">
        {!sel ? <p className="text-neutral-500">Un préréglage = prompt système + outils autorisés + ton + langue + modèle. Sélectionnez-en un pour le modifier, ou créez le vôtre. Dans le chat, tapez <code>/resume</code>, <code>/traduis</code>, <code>/agenda</code>, <code>/cherche</code> ou <code>/tache</code> pour les utiliser en un clin d'œil.</p> : (
          <>
            <label className="block">Nom<input className={`${input} w-full`} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
            <label className="block">Prompt système<textarea rows={6} className={`${input} w-full`} value={f.systemPrompt} onChange={(e) => setF({ ...f, systemPrompt: e.target.value })} /></label>
            <fieldset><legend className="mb-1">Outils autorisés</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1">{[...BUILTIN_TOOLS, ...pluginTools.map((t) => [t, t] as [string, string])].map(([t, l]) => <label key={t} className="flex items-center gap-1"><input type="checkbox" checked={f.tools.includes(t)} onChange={() => toggleTool(t)} />{l}</label>)}</div>
              <p className="text-xs text-neutral-500">Les outils ne créent jamais d'action directe : ils proposent, vous validez dans « À valider ».</p></fieldset>
            <div className="flex flex-wrap gap-3">
              <label>Ton<br /><input className={input} value={f.tone} onChange={(e) => setF({ ...f, tone: e.target.value })} /></label>
              <label>Langue<br /><input className={input} value={f.language} placeholder="(celle de la question)" onChange={(e) => setF({ ...f, language: e.target.value })} /></label>
            </div>
            <div className="flex flex-wrap gap-3">
              <label>Fournisseur<br /><select className={input} value={f.provider ?? ""} onChange={(e) => setF({ ...f, provider: e.target.value || null })}><option value="">(route « Chat » des réglages)</option>{providers.map((p) => <option key={p}>{p}</option>)}</select></label>
              <label>Modèle<br /><input className={input} value={f.model ?? ""} disabled={!f.provider} onChange={(e) => setF({ ...f, model: e.target.value || null })} /></label>
            </div>
            <div className="flex items-center gap-2">
              <button className={`${btn} font-medium`} onClick={save}>Enregistrer</button>
              {cur?.builtin && <button className={btn} onClick={async () => { const r = await rpc<Preset>("presets.reset", { id: cur.id }); await load(); pick(r); setMsg("Rétabli."); }}>Rétablir la version d'origine</button>}
              {cur && !cur.builtin && <button className={btn} onClick={async () => { if (confirm(`Supprimer « ${cur.name} » ?`)) { await rpc("presets.delete", { id: cur.id }); setSel(null); void load(); } }}>Supprimer</button>}
              <span role="status" className="text-xs text-neutral-500">{msg}</span>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
