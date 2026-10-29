import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { CATEGORY_LABEL, rpc } from "../rpc";

interface Ev { id: string; title: string; start: number; allDay: boolean; aiAdded: boolean }
interface Task { id: string; title: string; due: number | null; status: string }
interface MailRow { id: string; subject: string; fromName: string; fromAddr: string; category: string | null }
interface Run { id: number; startedAt: number; finishedAt: number | null; summary: string | null; error: string | null }
interface Action { id: number; at: number; actor: string; action: string; detail: { title?: string } | null }
interface Status { enabled: boolean; running: boolean; nextRunAt: number | null; pendingMails: number; pendingProposals: number }

const btn = "rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";
const card = "rounded-lg border border-neutral-200 p-4 dark:border-neutral-800";
const hm = (t: number) => new Date(t).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
const ACTION_LABEL: Record<string, string> = { "event.create": "Événement ajouté", "task.create": "Tâche créée" };

export function Home({ go, onOpenMail }: { go: (section: string) => void; onOpenMail: (id: string) => void }) {
  const [events, setEvents] = useState<Ev[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [mails, setMails] = useState<MailRow[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [actions, setActions] = useState<Action[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [digest, setDigest] = useState<string | null>(null);
  const [digestMsg, setDigestMsg] = useState("");
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const d = new Date();
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    try {
      const [e, t, m, r, a, s, dg] = await Promise.all([
        rpc<Ev[]>("calendar.list", { from: start, to: start + 86_400_000 }),
        rpc<Task[]>("tasks.list", { status: "open" }),
        rpc<MailRow[]>("mail.list", { limit: 60 }),
        rpc<Run[]>("agent.journal", { limit: 5 }),
        rpc<Action[]>("actions.list", { limit: 30 }),
        rpc<Status>("agent.status"),
        rpc<{ text: string } | null>("digest.get", {}).catch(() => null),
      ]);
      setEvents(e);
      setTasks(t.filter((x) => x.due !== null && x.due < start + 86_400_000));
      setMails(m.filter((x) => x.category === "important" || x.category === "to_reply").slice(0, 6));
      setRuns(r); setActions(a.filter((x) => x.actor === "ai").slice(0, 5)); setStatus(s); setDigest(dg?.text ?? null); setErr("");
    } catch (x) { setErr(String(x)); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const un = listen<{ method: string }>("sidecar-event", ({ payload }) => {
      if (["agent.event", "proposals.event", "mail.event", "calendar.event"].includes(payload.method)) void load();
    });
    return () => void un.then((f) => f());
  }, [load]);

  const genDigest = async () => {
    setDigestMsg("Génération…");
    try {
      const r = await rpc<{ text: string } | null>("digest.get", { force: true });
      setDigest(r?.text ?? null);
      setDigestMsg(r ? "" : "Configurez une route « Résumés » dans Settings → IA.");
    } catch (e) { setDigestMsg(String(e)); }
  };

  return (
    <div className="grid max-w-5xl gap-4 md:grid-cols-2">
      {err && <p role="alert" className="text-sm text-red-600 md:col-span-2">{err}</p>}

      <section className={`${card} md:col-span-2`} aria-labelledby="h-digest">
        <div className="flex items-center gap-2"><h2 id="h-digest" className="font-medium">Résumé du jour</h2>
          <button className={`${btn} ml-auto`} onClick={genDigest}>{digest ? "Régénérer" : "Générer"}</button></div>
        <p className="mt-2 whitespace-pre-wrap text-sm">{digest ?? <span className="text-neutral-500">Pas encore de résumé aujourd'hui.</span>}</p>
        {digestMsg && <p role="status" className="mt-1 text-xs text-neutral-500">{digestMsg}</p>}
      </section>

      {status && status.pendingProposals > 0 && (
        <button onClick={() => go("À valider")} className={`${card} text-left hover:bg-neutral-50 dark:hover:bg-neutral-900 md:col-span-2`}>
          <strong>{status.pendingProposals}</strong> suggestion{status.pendingProposals > 1 ? "s" : ""} de l'IA à valider →
        </button>
      )}

      <section className={card} aria-labelledby="h-ev">
        <h2 id="h-ev" className="mb-2 font-medium">Aujourd'hui <button className="ml-2 text-xs text-neutral-500 underline" onClick={() => go("Calendrier")}>agenda</button></h2>
        <ul className="space-y-1 text-sm">
          {events.length === 0 && <li className="text-neutral-500">Aucun événement.</li>}
          {events.map((e) => <li key={e.id}><span className="mr-2 text-neutral-500">{e.allDay ? "journée" : hm(e.start)}</span>{e.title}{e.aiAdded && <span className="ml-2 rounded bg-purple-100 px-1 text-xs text-purple-900 dark:bg-purple-900/40 dark:text-purple-100">IA</span>}</li>)}
        </ul>
      </section>

      <section className={card} aria-labelledby="h-tasks">
        <h2 id="h-tasks" className="mb-2 font-medium">Tâches du jour <button className="ml-2 text-xs text-neutral-500 underline" onClick={() => go("Tâches")}>toutes</button></h2>
        <ul className="space-y-1 text-sm">
          {tasks.length === 0 && <li className="text-neutral-500">Rien d'urgent.</li>}
          {tasks.slice(0, 6).map((t) => <li key={t.id}>☐ {t.title}{t.due! < Date.now() - 86_400_000 && <span className="ml-2 text-xs text-red-600">en retard</span>}</li>)}
        </ul>
      </section>

      <section className={card} aria-labelledby="h-mail">
        <h2 id="h-mail" className="mb-2 font-medium">Mails importants <button className="ml-2 text-xs text-neutral-500 underline" onClick={() => go("Mails")}>boîte</button></h2>
        <ul className="space-y-1 text-sm">
          {mails.length === 0 && <li className="text-neutral-500">Aucun mail important repéré.</li>}
          {mails.map((m) => <li key={m.id}><button className="text-left hover:underline" onClick={() => onOpenMail(m.id)}><span className="mr-2 rounded bg-neutral-100 px-1 text-xs dark:bg-neutral-800">{CATEGORY_LABEL[m.category ?? ""]}</span>{m.fromName || m.fromAddr} — {m.subject}</button></li>)}
        </ul>
      </section>

      <section className={card} aria-labelledby="h-agent">
        <div className="mb-2 flex items-center gap-2"><h2 id="h-agent" className="font-medium">Activité de l'IA</h2>
          <button className={`${btn} ml-auto`} disabled={status?.running} onClick={() => rpc("agent.runNow").then(load)}>{status?.running ? "En cours…" : "Analyser maintenant"}</button></div>
        {status && !status.enabled && <p className="mb-2 text-xs text-amber-700 dark:text-amber-400">L'agent automatique est désactivé (Settings → Agent). L'analyse manuelle reste possible.</p>}
        {status && status.pendingMails > 0 && <p className="mb-2 text-xs text-neutral-500">{status.pendingMails} mail(s) en attente d'analyse.</p>}
        <ul className="space-y-1 text-sm">
          {runs.length === 0 && <li className="text-neutral-500">Aucune activité pour l'instant.</li>}
          {runs.map((r) => <li key={r.id}><span className="mr-2 text-xs text-neutral-500">{new Date(r.startedAt).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>{r.finishedAt === null ? "en cours…" : r.error ? `Erreur : ${r.error}` : r.summary}</li>)}
        </ul>
        {actions.length > 0 && (
          <div className="mt-3 border-t border-neutral-200 pt-2 dark:border-neutral-800">
            <h3 className="mb-1 text-xs font-medium text-neutral-500">Ajouts automatiques récents</h3>
            <ul className="space-y-1 text-sm">
              {actions.map((a) => <li key={a.id} className="flex items-center gap-2"><span className="flex-1 truncate">{ACTION_LABEL[a.action] ?? a.action} : {a.detail?.title}</span>
                <button className={btn} onClick={() => rpc("actions.undo", { id: a.id }).then(load)}>Annuler</button></li>)}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
