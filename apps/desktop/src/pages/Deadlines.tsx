import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { KIND_LABEL, PERIOD_LABEL, rpc } from "../rpc";

interface Deadline {
  id: string; service: string; kind: string; amount: number | null; currency: string; periodicity: string;
  nextDate: number | null; cancelBy: number | null; status: "active" | "cancelled" | "paid"; notes: string;
  sourceRef: { type: string; id: string } | null; duplicate: boolean; priceIncrease: { from: number; to: number } | null;
}
interface Summary { recurringCount: number; totals: { currency: string; monthly: number; yearly: number }[]; upcoming: { deadlineId: string; service: string; kind: "due" | "cancel"; date: number; amount: number | null }[] }

const btn = "rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";
const input = "rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700";
const day = (t: number | null) => (t ? new Date(t).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" }) : "—");
const toInput = (t: number | null) => (t ? new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 10) : "");
const fromInput = (s: string) => (s ? new Date(`${s}T00:00`).getTime() : null);
const daysLeft = (t: number) => Math.ceil((t - Date.now()) / 86_400_000);
const money = (n: number | null, c: string) => (n == null ? "—" : n.toLocaleString("fr-FR", { style: "currency", currency: c }));

function Form({ d, onClose, onSaved }: { d: Deadline | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ service: d?.service ?? "", kind: d?.kind ?? "subscription", amount: d?.amount?.toString() ?? "", currency: d?.currency ?? "EUR", periodicity: d?.periodicity ?? "monthly", nextDate: toInput(d?.nextDate ?? null), cancelBy: toInput(d?.cancelBy ?? null), notes: d?.notes ?? "" });
  const [err, setErr] = useState("");
  const save = async () => {
    try {
      const body = { id: d?.id, service: f.service, kind: f.kind, amount: f.amount === "" ? null : Number(f.amount.replace(",", ".")), currency: f.currency, periodicity: f.periodicity, nextDate: fromInput(f.nextDate), cancelBy: fromInput(f.cancelBy), notes: f.notes };
      await rpc(d ? "deadlines.update" : "deadlines.create", body);
      onSaved(); onClose();
    } catch (e) { setErr(String(e)); }
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Échéance" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}
        className="w-[460px] max-w-[92vw] space-y-3 rounded-xl border border-neutral-200 bg-white p-5 shadow-2xl dark:border-neutral-700 dark:bg-neutral-900">
        <input autoFocus aria-label="Service" placeholder="Service (ex. Netflix)" className={`${input} w-full`} value={f.service} onChange={set("service")} />
        <div className="flex gap-2">
          <select aria-label="Type" className={input} value={f.kind} onChange={set("kind")}>{Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <select aria-label="Périodicité" className={input} value={f.periodicity} onChange={set("periodicity")}>{Object.entries(PERIOD_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </div>
        <div className="flex gap-2"><input aria-label="Montant" placeholder="Montant" inputMode="decimal" className={`${input} w-28`} value={f.amount} onChange={set("amount")} /><input aria-label="Devise" className={`${input} w-16`} value={f.currency} maxLength={3} onChange={set("currency")} /></div>
        <div className="flex flex-wrap gap-3 text-sm">
          <label>Prochaine échéance<br /><input type="date" className={input} value={f.nextDate} onChange={set("nextDate")} /></label>
          <label>Résilier avant le<br /><input type="date" className={input} value={f.cancelBy} onChange={set("cancelBy")} /></label>
        </div>
        <textarea aria-label="Notes" placeholder="Notes" rows={2} className={`${input} w-full`} value={f.notes} onChange={set("notes")} />
        <p className="text-xs text-neutral-500">Un événement (échéance) et une tâche (résiliation) sont créés et tenus à jour automatiquement.</p>
        {err && <p role="alert" className="text-sm text-red-600">{err}</p>}
        <div className="flex justify-end gap-2"><button className={btn} onClick={onClose}>Annuler</button><button className={`${btn} font-medium`} onClick={save}>Enregistrer</button></div>
      </div>
    </div>
  );
}

export function Deadlines({ onOpenMail }: { onOpenMail: (id: string) => void }) {
  const [rows, setRows] = useState<Deadline[]>([]);
  const [sum, setSum] = useState<Summary | null>(null);
  const [filter, setFilter] = useState<"active" | "all">("active");
  const [edit, setEdit] = useState<Deadline | "new" | null>(null);
  const [alertDays, setAlertDays] = useState("30, 7, 1");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    try {
      const [r, s, st] = await Promise.all([rpc<Deadline[]>("deadlines.list", {}), rpc<Summary>("deadlines.summary"), rpc<{ deadlines: { alertDays: number[] } }>("settings.get")]);
      setRows(r); setSum(s); setAlertDays(st.deadlines.alertDays.join(", "));
    } catch (e) { setMsg(String(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const un = listen<{ method: string }>("sidecar-event", ({ payload }) => { if (["proposals.event", "agent.event", "deadline.alert"].includes(payload.method)) void load(); });
    return () => void un.then((f) => f());
  }, [load]);

  const saveAlerts = async () => {
    try {
      const days = [...new Set(alertDays.split(/[,\s]+/).filter(Boolean).map(Number))].filter((n) => Number.isInteger(n) && n >= 0 && n <= 365).sort((a, b) => b - a);
      const cur = await rpc<Record<string, any>>("settings.get");
      await rpc("settings.set", { settings: { ...cur, deadlines: { alertDays: days } } });
      setMsg(`Alertes : ${days.join(", ")} jours avant.`); void load();
    } catch (e) { setMsg(String(e)); }
  };

  const shown = rows.filter((r) => filter === "all" || r.status === "active");
  return (
    <div>
      <div className="mb-4 grid gap-3 md:grid-cols-3">
        <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
          <div className="text-xs text-neutral-500">Abonnements actifs ({sum?.recurringCount ?? 0})</div>
          {sum?.totals.length ? sum.totals.map((t) => <div key={t.currency}><strong>{money(t.monthly, t.currency)}</strong> / mois · {money(t.yearly, t.currency)} / an</div>) : <div className="text-sm text-neutral-500">—</div>}
        </div>
        <div className="rounded-lg border border-neutral-200 p-3 text-sm dark:border-neutral-800 md:col-span-2">
          <div className="mb-1 text-xs text-neutral-500">À venir</div>
          {sum?.upcoming.length ? <ul className="space-y-0.5">{sum.upcoming.slice(0, 5).map((u, i) => (
            <li key={i}><span className={daysLeft(u.date) <= 7 ? "font-medium text-red-600" : ""}>{daysLeft(u.date) < 0 ? "dépassé" : daysLeft(u.date) === 0 ? "aujourd'hui" : `dans ${daysLeft(u.date)} j`}</span> — {u.kind === "cancel" ? "⚠ dernier jour pour résilier" : "échéance"} <strong>{u.service}</strong> ({day(u.date)})</li>
          ))}</ul> : <span className="text-neutral-500">Rien dans les prochaines semaines.</span>}
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button className={`${btn} font-medium`} onClick={() => setEdit("new")}>+ Ajouter</button>
        <select aria-label="Filtre" className={input} value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}><option value="active">Actives</option><option value="all">Toutes</option></select>
        <label className="ml-auto flex items-center gap-1 text-sm">Alertes (jours avant) <input aria-label="Jours d'alerte" className={`${input} w-28`} value={alertDays} onChange={(e) => setAlertDays(e.target.value)} /></label>
        <button className={btn} onClick={saveAlerts}>Enregistrer</button>
      </div>
      {msg && <p role="status" className="mb-2 text-sm text-neutral-600">{msg}</p>}

      <table className="w-full text-sm">
        <thead className="text-left text-xs text-neutral-500"><tr><th className="py-1">Service</th><th>Montant</th><th>Périodicité</th><th>Prochaine échéance</th><th>Résilier avant</th><th>Source</th><th /></tr></thead>
        <tbody>
          {shown.length === 0 && <tr><td colSpan={7} className="py-3 text-neutral-500">Aucune échéance. L'IA en repère dans vos mails et documents (à valider dans « À valider »), ou ajoutez-en une.</td></tr>}
          {shown.map((d) => (
            <tr key={d.id} className={`border-t border-neutral-200 dark:border-neutral-800 ${d.status !== "active" ? "opacity-50" : ""}`}>
              <td className="py-2"><button className="font-medium hover:underline" onClick={() => setEdit(d)}>{d.service}</button> <span className="text-xs text-neutral-500">{KIND_LABEL[d.kind]}</span>
                {d.duplicate && <span title="Plusieurs abonnements actifs pour ce service" className="ml-2 rounded bg-amber-100 px-1 text-xs text-amber-900">doublon ?</span>}
                {d.priceIncrease && <span className="ml-2 rounded bg-red-100 px-1 text-xs text-red-900">hausse {money(d.priceIncrease.from, d.currency)} → {money(d.priceIncrease.to, d.currency)}</span>}
                {d.status !== "active" && <span className="ml-2 text-xs">({d.status === "cancelled" ? "résilié" : "payé"})</span>}</td>
              <td>{money(d.amount, d.currency)}</td><td>{PERIOD_LABEL[d.periodicity]}</td>
              <td className={d.nextDate && daysLeft(d.nextDate) <= 7 && d.status === "active" ? "font-medium text-red-600" : ""}>{day(d.nextDate)}</td>
              <td className={d.cancelBy && daysLeft(d.cancelBy) <= 7 && d.status === "active" ? "font-medium text-red-600" : ""}>{day(d.cancelBy)}</td>
              <td>{d.sourceRef?.type === "mail" ? <button className="underline" onClick={() => onOpenMail(d.sourceRef!.id)}>mail</button> : d.sourceRef?.type === "document" ? "document" : "—"}</td>
              <td className="whitespace-nowrap text-right">
                {d.status === "active" ? <>
                  <button className={btn} onClick={() => rpc("deadlines.setStatus", { id: d.id, status: "cancelled" }).then(load)}>Résilié</button>{" "}
                  {d.periodicity === "one_off" && <button className={btn} onClick={() => rpc("deadlines.setStatus", { id: d.id, status: "paid" }).then(load)}>Payé</button>}
                </> : <button className={btn} onClick={() => rpc("deadlines.setStatus", { id: d.id, status: "active" }).then(load)}>Réactiver</button>}{" "}
                <button aria-label={`Supprimer ${d.service}`} className="px-1 text-neutral-400 hover:text-red-600" onClick={() => { if (confirm(`Supprimer « ${d.service} » ?`)) void rpc("deadlines.delete", { id: d.id }).then(load); }}>×</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && <Form d={edit === "new" ? null : edit} onClose={() => setEdit(null)} onSaved={load} />}
    </div>
  );
}
