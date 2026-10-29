import { useCallback, useEffect, useState } from "react";
import { rpc } from "../rpc";

interface Task {
  id: string; title: string; notes: string; due: number | null; priority: number; status: "open" | "done";
  aiAdded: boolean; sourceRef: { type: string; id: string } | null;
}
const btn = "rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";
const input = "rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700";
const sod = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export function Tasks({ onOpenMail }: { onOpenMail: (id: string) => void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [high, setHigh] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(() => { rpc<Task[]>("tasks.list").then(setTasks).catch((e) => setErr(String(e))); }, []);
  useEffect(load, [load]);

  const add = async () => {
    if (!title.trim()) return;
    try {
      await rpc("tasks.create", { title, due: due ? new Date(`${due}T00:00`).getTime() : null, priority: high ? 1 : 0 });
      setTitle(""); setDue(""); setHigh(false); load();
    } catch (e) { setErr(String(e)); }
  };

  const today = sod(new Date());
  const open = tasks.filter((t) => t.status === "open");
  const groups: [string, Task[]][] = [
    ["En retard", open.filter((t) => t.due !== null && t.due < today)],
    ["Aujourd'hui", open.filter((t) => t.due !== null && t.due >= today && t.due < today + 86_400_000)],
    ["À venir", open.filter((t) => t.due !== null && t.due >= today + 86_400_000)],
    ["Sans date", open.filter((t) => t.due === null)],
    ["Terminées", tasks.filter((t) => t.status === "done").slice(0, 30)],
  ];

  return (
    <div className="max-w-3xl">
      <form className="mb-4 flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <input aria-label="Nouvelle tâche" placeholder="Nouvelle tâche…" className={`${input} min-w-64 flex-1`} value={title} onChange={(e) => setTitle(e.target.value)} />
        <input type="date" aria-label="Échéance" className={input} value={due} onChange={(e) => setDue(e.target.value)} />
        <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={high} onChange={(e) => setHigh(e.target.checked)} /> Prioritaire</label>
        <button type="submit" className={btn} disabled={!title.trim()}>Ajouter</button>
      </form>
      {err && <p role="alert" className="mb-2 text-sm text-red-600">{err}</p>}
      {tasks.length === 0 && <p className="text-sm text-neutral-500">Aucune tâche.</p>}
      {groups.filter(([, l]) => l.length).map(([name, list]) => (
        <section key={name} className="mb-4">
          <h2 className={`mb-1 text-sm font-medium ${name === "En retard" ? "text-red-600" : ""}`}>{name} <span className="text-neutral-500">({list.length})</span></h2>
          <ul>
            {list.map((t) => (
              <li key={t.id} className="group flex items-center gap-2 rounded-md px-2 py-1 hover:bg-neutral-50 dark:hover:bg-neutral-900">
                <input type="checkbox" aria-label={`Terminer ${t.title}`} checked={t.status === "done"} onChange={(e) => rpc("tasks.setDone", { id: t.id, done: e.target.checked }).then(load)} />
                <span className={`flex-1 text-sm ${t.status === "done" ? "text-neutral-400 line-through" : ""}`}>
                  {t.priority === 1 && <span title="Prioritaire">❗ </span>}{t.title}
                  {t.aiAdded && <span className="ml-2 rounded bg-purple-100 px-1 text-xs text-purple-900 dark:bg-purple-900/40 dark:text-purple-100">IA</span>}
                  {t.sourceRef?.type === "mail" && <button className="ml-2 text-xs underline text-neutral-500" onClick={() => onOpenMail(t.sourceRef!.id)}>mail</button>}
                </span>
                {t.due && <span className="text-xs text-neutral-500">{new Date(t.due).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}</span>}
                <button aria-label={`Supprimer ${t.title}`} className="px-1 text-neutral-400 opacity-0 hover:text-red-600 focus:opacity-100 group-hover:opacity-100" onClick={() => rpc("tasks.delete", { id: t.id }).then(load)}>×</button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
