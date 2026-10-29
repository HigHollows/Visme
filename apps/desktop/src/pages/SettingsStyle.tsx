import { useCallback, useEffect, useState } from "react";
import { rpc, type StyleProfile } from "../rpc";

interface Entry { scope: string; profile: StyleProfile; source: "learned" | "manual"; sampleCount: number; updatedAt: number }
const input = "rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700";
const btn = "rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";
const EMPTY: StyleProfile = { greetings: [], closings: [], formality: "vous", length: "moyen", tone: "", signature: "", notes: "" };
const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

function Editor({ scope, entry, onChange }: { scope: string; entry?: Entry; onChange: () => void }) {
  const p = entry?.profile ?? EMPTY;
  const [f, setF] = useState({ greetings: p.greetings.join("\n"), closings: p.closings.join("\n"), formality: p.formality, length: p.length, tone: p.tone, signature: p.signature, notes: p.notes });
  const [msg, setMsg] = useState("");
  useEffect(() => { setF({ greetings: p.greetings.join("\n"), closings: p.closings.join("\n"), formality: p.formality, length: p.length, tone: p.tone, signature: p.signature, notes: p.notes }); }, [entry?.updatedAt, scope]);
  const learn = async () => {
    setMsg("Analyse de vos mails envoyés…");
    try { const r = await rpc<{ samples: number }>("style.learn", { scope }); setMsg(`Appris à partir de ${r.samples} mails.`); onChange(); } catch (e) { setMsg(String(e)); }
  };
  return (
    <div className="space-y-2 rounded-md border border-neutral-200 p-3 text-sm dark:border-neutral-800">
      <div className="flex items-center gap-2"><strong>{scope === "global" ? "Style général" : scope.replace(/^(group|contact):/, "")}</strong>
        {entry && <span className="text-xs text-neutral-500">{entry.source === "learned" ? `appris (${entry.sampleCount} mails)` : "écrit à la main"}</span>}
        {scope !== "global" && <button className="ml-auto px-1 text-neutral-400 hover:text-red-600" aria-label="Supprimer ce profil" onClick={() => rpc("style.delete", { scope }).then(onChange)}>×</button>}</div>
      <div className="grid gap-2 md:grid-cols-2">
        <label>Formules d'ouverture (une par ligne)<textarea rows={2} className={`${input} w-full`} value={f.greetings} onChange={(e) => setF({ ...f, greetings: e.target.value })} /></label>
        <label>Formules de clôture (une par ligne)<textarea rows={2} className={`${input} w-full`} value={f.closings} onChange={(e) => setF({ ...f, closings: e.target.value })} /></label>
      </div>
      <div className="flex flex-wrap gap-3">
        <label>Registre <select className={input} value={f.formality} onChange={(e) => setF({ ...f, formality: e.target.value as StyleProfile["formality"] })}><option value="vous">Vouvoiement</option><option value="tu">Tutoiement</option><option value="mixte">Mixte</option></select></label>
        <label>Longueur <select className={input} value={f.length} onChange={(e) => setF({ ...f, length: e.target.value as StyleProfile["length"] })}><option value="court">Court</option><option value="moyen">Moyen</option><option value="long">Long</option></select></label>
        <label className="flex-1">Ton <input className={`${input} w-full`} value={f.tone} onChange={(e) => setF({ ...f, tone: e.target.value })} /></label>
      </div>
      <label className="block">Signature <input className={`${input} w-full`} value={f.signature} onChange={(e) => setF({ ...f, signature: e.target.value })} /></label>
      <label className="block">Consignes personnelles <textarea rows={2} className={`${input} w-full`} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
      <div className="flex flex-wrap items-center gap-2">
        <button className={`${btn} font-medium`} onClick={async () => { try { await rpc("style.set", { scope, profile: { ...f, greetings: lines(f.greetings), closings: lines(f.closings) } }); setMsg("Enregistré."); onChange(); } catch (e) { setMsg(String(e)); } }}>Enregistrer</button>
        <button className={btn} onClick={learn}>Apprendre depuis mes mails envoyés</button>
        <span role="status" className="text-xs text-neutral-500">{msg}</span>
      </div>
    </div>
  );
}

export function SettingsStyle() {
  const [data, setData] = useState<{ profiles: Entry[]; groups: { addr: string; group: string }[]; learningEnabled: boolean } | null>(null);
  const [g, setG] = useState({ addr: "", group: "" });
  const [msg, setMsg] = useState("");
  const load = useCallback(() => { rpc<NonNullable<typeof data>>("style.list").then(setData).catch((e) => setMsg(String(e))); }, []);
  useEffect(load, [load]);
  if (!data) return <p className="text-sm text-neutral-500">{msg || "Chargement…"}</p>;

  const toggle = async (v: boolean) => {
    const cur = await rpc<Record<string, any>>("settings.get");
    await rpc("settings.set", { settings: { ...cur, style: { learningEnabled: v } } });
    load();
  };
  const find = (scope: string) => data.profiles.find((p) => p.scope === scope);
  const groupNames = [...new Set(data.groups.map((x) => x.group))];

  return (
    <div className="max-w-3xl space-y-6">
      <section>
        <h2 className="mb-2 text-lg font-medium">Style de réponse</h2>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={data.learningEnabled} onChange={(e) => toggle(e.target.checked)} />
          <span><strong>Autoriser l'apprentissage de mon style depuis mes mails envoyés</strong><br />
            <span className="text-neutral-500">Quand vous cliquez sur « Apprendre », des extraits de vos mails <em>envoyés</em> (sans les citations, données sensibles masquées) sont envoyés au fournisseur IA de la tâche « Rédaction ». Décocher cette case bloque l'apprentissage et suspend l'usage des profils appris ; vos profils écrits à la main restent actifs.</span></span>
        </label>
        <div className="mt-2"><button className={btn} onClick={async () => { if (confirm("Effacer tous les profils appris ? Vos profils écrits à la main sont conservés.")) { const r = await rpc<{ removed: number }>("style.reset"); setMsg(`${r.removed} profil(s) appris effacé(s).`); load(); } }}>Réinitialiser ce qui a été appris</button>
          <span role="status" className="ml-2 text-xs text-neutral-500">{msg}</span></div>
      </section>
      <Editor scope="global" entry={find("global")} onChange={load} />
      <section className="space-y-2">
        <h3 className="font-medium">Groupes et contacts</h3>
        <p className="text-sm text-neutral-500">Rangez un contact dans un groupe (client, ami, administration…) pour lui donner un style distinct. Priorité : contact, puis groupe, puis style général.</p>
        <div className="flex flex-wrap items-end gap-2">
          <input aria-label="Adresse du contact" placeholder="adresse@exemple.com" className={`${input} w-64`} value={g.addr} onChange={(e) => setG({ ...g, addr: e.target.value })} />
          <input aria-label="Groupe" list="groups" placeholder="Groupe (ex. client)" className={`${input} w-44`} value={g.group} onChange={(e) => setG({ ...g, group: e.target.value })} />
          <datalist id="groups">{groupNames.map((n) => <option key={n} value={n} />)}</datalist>
          <button className={btn} disabled={!g.addr || !g.group} onClick={async () => { try { await rpc("style.setGroup", g); setG({ addr: "", group: "" }); load(); } catch (e) { setMsg(String(e)); } }}>Ranger</button>
        </div>
        <ul className="text-sm">{data.groups.map((x) => <li key={x.addr}>{x.addr} → <strong>{x.group}</strong> <button className="px-1 text-neutral-400 hover:text-red-600" aria-label="Retirer du groupe" onClick={() => rpc("style.setGroup", { addr: x.addr, group: null }).then(load)}>×</button></li>)}</ul>
        {groupNames.map((n) => <Editor key={n} scope={`group:${n}`} entry={find(`group:${n}`)} onChange={load} />)}
        {data.profiles.filter((p) => p.scope.startsWith("contact:")).map((p) => <Editor key={p.scope} scope={p.scope} entry={p} onChange={load} />)}
      </section>
    </div>
  );
}
