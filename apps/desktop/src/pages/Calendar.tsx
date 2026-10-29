import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { rpc } from "../rpc";

interface Ev {
  id: string; title: string; description: string; location: string; start: number; end: number;
  allDay: boolean; source: "google" | "local" | "ai"; aiAdded: boolean; link: string | null;
  confidence: number | null; sourceRef: { type: string; id: string } | null;
  writable?: boolean; pushError?: string | null; remoteId?: string | null;
}
type View = "day" | "week" | "month" | "agenda";

const DAY = 86_400_000;
const HOUR_PX = 48;
const btn = "rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";
const input = "rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700";

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const mondayOf = (d: Date) => addDays(startOfDay(d), -((d.getDay() + 6) % 7));
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const fmtTime = (t: number) => new Date(t).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
const fmtDay = (d: Date, o: Intl.DateTimeFormatOptions) => d.toLocaleDateString("fr-FR", o);
const pad = (n: number) => String(n).padStart(2, "0");
const toDateInput = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const toTimeInput = (t: number) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

function rangeFor(view: View, anchor: Date): [Date, Date] {
  if (view === "day") return [startOfDay(anchor), addDays(startOfDay(anchor), 1)];
  if (view === "week") { const m = mondayOf(anchor); return [m, addDays(m, 7)]; }
  if (view === "month") { const m = mondayOf(new Date(anchor.getFullYear(), anchor.getMonth(), 1)); return [m, addDays(m, 42)]; }
  return [startOfDay(anchor), addDays(startOfDay(anchor), 30)];
}

/** Un événement "toute la journée" ou multi-jours couvre tous les jours entre début et fin (fin exclusive). */
function eventsOn(events: Ev[], day: Date) {
  const s = day.getTime(), e = s + DAY;
  return events.filter((ev) => ev.start < e && (ev.end > s || (ev.end === ev.start && ev.start >= s)));
}

function layout(evs: Ev[], dayStart: number) {
  const sorted = [...evs].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: { ev: Ev; col: number; cols: number }[] = [];
  let cluster: { ev: Ev; col: number; cols: number }[] = [];
  let clusterEnd = -Infinity;
  const flush = () => { const n = Math.max(0, ...cluster.map((c) => c.col + 1)); cluster.forEach((c) => (c.cols = n)); out.push(...cluster); cluster = []; };
  for (const ev of sorted) {
    const s = Math.max(ev.start, dayStart), e = Math.max(Math.min(ev.end, dayStart + DAY), s + 20 * 60_000);
    if (s >= clusterEnd && cluster.length) flush();
    const used = new Set(cluster.filter((c) => Math.max(c.ev.end, c.ev.start + 20 * 60_000) > s).map((c) => c.col));
    let col = 0; while (used.has(col)) col++;
    cluster.push({ ev, col, cols: 1 });
    clusterEnd = Math.max(clusterEnd === -Infinity ? 0 : clusterEnd, e);
  }
  if (cluster.length) flush();
  return out;
}

function Chip({ ev, onOpen, compact }: { ev: Ev; onOpen: (e: Ev) => void; compact?: boolean }) {
  return (
    <button onClick={(e) => { e.stopPropagation(); onOpen(ev); }} title={ev.title}
      className={`block w-full truncate rounded px-1.5 text-left text-xs ${ev.aiAdded ? "bg-purple-100 text-purple-900 dark:bg-purple-900/40 dark:text-purple-100" : ev.source === "local" ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100" : "bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-100"}`}>
      {!compact && !ev.allDay && <span className="opacity-70">{fmtTime(ev.start)} </span>}{ev.title}
    </button>
  );
}

function TimeGrid({ days, events, onOpen, onCreate }: { days: Date[]; events: Ev[]; onOpen: (e: Ev) => void; onCreate: (t: number) => void }) {
  const allDay = (d: Date) => eventsOn(events, d).filter((e) => e.allDay || e.end - e.start >= DAY);
  const timed = (d: Date) => eventsOn(events, d).filter((e) => !e.allDay && e.end - e.start < DAY);
  const now = new Date();
  return (
    <div className="overflow-auto" style={{ maxHeight: "calc(100vh - 14rem)" }}>
      <div className="grid sticky top-0 z-10 bg-white dark:bg-neutral-950" style={{ gridTemplateColumns: `3rem repeat(${days.length}, 1fr)` }}>
        <div />
        {days.map((d) => (
          <div key={+d} className="border-l border-neutral-200 px-1 pb-1 text-center text-xs dark:border-neutral-800">
            <div className={sameDay(d, now) ? "font-semibold text-blue-600" : ""}>{fmtDay(d, { weekday: "short", day: "numeric" })}</div>
            <div className="space-y-0.5">{allDay(d).map((e) => <Chip key={e.id} ev={e} onOpen={onOpen} compact />)}</div>
          </div>
        ))}
      </div>
      <div className="grid" style={{ gridTemplateColumns: `3rem repeat(${days.length}, 1fr)` }}>
        <div>{Array.from({ length: 24 }, (_, h) => <div key={h} style={{ height: HOUR_PX }} className="pr-1 text-right text-[10px] text-neutral-500">{h ? `${h}h` : ""}</div>)}</div>
        {days.map((d) => (
          <div key={+d} className="relative border-l border-neutral-200 dark:border-neutral-800" style={{ height: HOUR_PX * 24 }}
            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); const h = Math.floor((e.clientY - r.top) / HOUR_PX); onCreate(+d + h * 3600_000); }}>
            {Array.from({ length: 24 }, (_, h) => <div key={h} style={{ top: h * HOUR_PX, height: HOUR_PX }} className="absolute inset-x-0 border-t border-neutral-100 dark:border-neutral-900" />)}
            {sameDay(d, now) && <div className="absolute inset-x-0 z-10 border-t-2 border-red-500" style={{ top: ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX }} />}
            {layout(timed(d), +d).map(({ ev, col, cols }) => {
              const s = Math.max(ev.start, +d), e = Math.min(Math.max(ev.end, ev.start + 20 * 60_000), +d + DAY);
              return (
                <button key={ev.id} onClick={(x) => { x.stopPropagation(); onOpen(ev); }}
                  className={`absolute overflow-hidden rounded border px-1 text-left text-xs ${ev.aiAdded ? "border-purple-300 bg-purple-100 text-purple-900 dark:border-purple-700 dark:bg-purple-900/50 dark:text-purple-100" : ev.source === "local" ? "border-emerald-300 bg-emerald-100 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-100" : "border-blue-300 bg-blue-100 text-blue-900 dark:border-blue-700 dark:bg-blue-900/50 dark:text-blue-100"}`}
                  style={{ top: ((s - +d) / 3600_000) * HOUR_PX, height: Math.max(((e - s) / 3600_000) * HOUR_PX, 16), left: `${(col / cols) * 100}%`, width: `${100 / cols - 1}%` }}>
                  <div className="truncate font-medium">{ev.title}</div><div className="truncate opacity-70">{fmtTime(ev.start)}–{fmtTime(ev.end)}</div>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function Month({ anchor, events, onOpen, onCreate, onPick }: { anchor: Date; events: Ev[]; onOpen: (e: Ev) => void; onCreate: (t: number) => void; onPick: (d: Date) => void }) {
  const start = mondayOf(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  return (
    <div>
      <div className="grid grid-cols-7 text-center text-xs text-neutral-500">{days.slice(0, 7).map((d) => <div key={+d}>{fmtDay(d, { weekday: "short" })}</div>)}</div>
      <div className="grid grid-cols-7 border-l border-t border-neutral-200 dark:border-neutral-800">
        {days.map((d) => {
          const evs = eventsOn(events, d);
          return (
            <div key={+d} onClick={() => onCreate(+d + 9 * 3600_000)}
              className={`min-h-24 cursor-pointer border-b border-r border-neutral-200 p-1 dark:border-neutral-800 ${d.getMonth() !== anchor.getMonth() ? "bg-neutral-50 text-neutral-400 dark:bg-neutral-900" : ""}`}>
              <button onClick={(e) => { e.stopPropagation(); onPick(d); }} className={`mb-0.5 text-xs ${sameDay(d, new Date()) ? "rounded-full bg-blue-600 px-1.5 text-white" : ""}`}>{d.getDate()}</button>
              <div className="space-y-0.5">
                {evs.slice(0, 3).map((e) => <Chip key={e.id} ev={e} onOpen={onOpen} />)}
                {evs.length > 3 && <button onClick={(e) => { e.stopPropagation(); onPick(d); }} className="text-xs text-neutral-500">+{evs.length - 3} autres</button>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Agenda({ anchor, events, onOpen }: { anchor: Date; events: Ev[]; onOpen: (e: Ev) => void }) {
  const days = Array.from({ length: 30 }, (_, i) => addDays(startOfDay(anchor), i)).filter((d) => eventsOn(events, d).length);
  if (!days.length) return <p className="text-sm text-neutral-500">Aucun événement sur les 30 prochains jours.</p>;
  return (
    <div className="space-y-4 overflow-y-auto" style={{ maxHeight: "calc(100vh - 14rem)" }}>
      {days.map((d) => (
        <section key={+d}>
          <h3 className={`mb-1 text-sm font-medium ${sameDay(d, new Date()) ? "text-blue-600" : ""}`}>{fmtDay(d, { weekday: "long", day: "numeric", month: "long" })}</h3>
          <ul className="space-y-1">
            {eventsOn(events, d).map((e) => (
              <li key={e.id}><button onClick={() => onOpen(e)} className="flex w-full gap-3 rounded-md px-2 py-1 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800">
                <span className="w-24 shrink-0 text-neutral-500">{e.allDay ? "Journée" : `${fmtTime(e.start)}–${fmtTime(e.end)}`}</span>
                <span className="flex-1 truncate">{e.title}{e.aiAdded && <span className="ml-2 rounded bg-purple-100 px-1 text-xs text-purple-900">ajouté par l'IA</span>}</span>
                <span className="truncate text-xs text-neutral-500">{e.location}</span>
              </button></li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function EventDialog({ ev, draft, onClose, onSaved }: { ev: Ev | null; draft: number | null; onClose: () => void; onSaved: () => void }) {
  const editable = !ev || ev.writable !== false;
  const [editing, setEditing] = useState(!ev);
  const base = ev?.start ?? draft ?? Date.now();
  const [title, setTitle] = useState(ev?.title ?? "");
  const [allDay, setAllDay] = useState(ev?.allDay ?? false);
  const [date, setDate] = useState(toDateInput(base));
  const [start, setStart] = useState(toTimeInput(base));
  const [end, setEnd] = useState(toTimeInput(ev?.end ?? base + 3600_000));
  const [location, setLocation] = useState(ev?.location ?? "");
  const [description, setDescription] = useState(ev?.description ?? "");
  const [err, setErr] = useState("");

  const save = async () => {
    try {
      const [y, m, d] = date.split("-").map(Number);
      const at = (hhmm: string) => { const [h, mi] = hhmm.split(":").map(Number); return new Date(y!, m! - 1, d!, h, mi).getTime(); };
      const s = allDay ? new Date(y!, m! - 1, d!).getTime() : at(start);
      const e = allDay ? s + DAY : at(end);
      await rpc(ev ? "calendar.update" : "calendar.create", { id: ev?.id, title, start: s, end: e, allDay, location, description });
      onSaved(); onClose();
    } catch (x) { setErr(String(x)); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label={ev ? "Événement" : "Nouvel événement"} onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}
        className="w-[420px] max-w-[92vw] space-y-3 rounded-xl border border-neutral-200 bg-white p-5 shadow-2xl dark:border-neutral-700 dark:bg-neutral-900">
        {!editing && ev ? (
          <>
            <h2 className="text-lg font-medium">{ev.title}</h2>
            <p className="text-sm">{ev.allDay ? fmtDay(new Date(ev.start), { dateStyle: "full" }) : `${fmtDay(new Date(ev.start), { dateStyle: "full" })}, ${fmtTime(ev.start)}–${fmtTime(ev.end)}`}</p>
            {ev.location && <p className="text-sm">📍 {ev.location}</p>}
            {ev.description && <p className="whitespace-pre-wrap text-sm text-neutral-600 dark:text-neutral-400">{ev.description}</p>}
            {ev.pushError && <p role="alert" className="text-xs text-red-600">Écriture vers l'agenda distant impossible : {ev.pushError}</p>}
            <p className="text-xs text-neutral-500">
              {ev.aiAdded ? `✨ Ajouté par l'IA${ev.confidence != null ? ` (confiance ${Math.round(ev.confidence * 100)} %)` : ""}` : ev.source === "local" ? "Créé dans ASSISTANT" : `Agenda synchronisé (${ev.source})${ev.writable ? "" : " — lecture seule"}`}{ev.remoteId && (ev.source === "local" || ev.source === "ai") ? " · écrit dans votre agenda" : ""}
              {ev.link && ev.link.startsWith("https://") && <> · <a className="underline" href={ev.link} target="_blank" rel="noreferrer noopener">Ouvrir dans Google</a></>}
            </p>
            <div className="flex justify-end gap-2">
              {editable && <button className={btn} onClick={async () => { if (confirm("Supprimer cet événement ?")) { await rpc("calendar.delete", { id: ev.id }); onSaved(); onClose(); } }}>Supprimer</button>}
              {editable && <button className={btn} onClick={() => setEditing(true)}>Modifier</button>}
              <button className={btn} onClick={onClose}>Fermer</button>
            </div>
          </>
        ) : (
          <>
            <input autoFocus aria-label="Titre" placeholder="Titre" className={`${input} w-full text-base`} value={title} onChange={(e) => setTitle(e.target.value)} />
            <div className="flex flex-wrap items-center gap-2">
              <input type="date" aria-label="Date" className={input} value={date} onChange={(e) => setDate(e.target.value)} />
              {!allDay && <><input type="time" aria-label="Début" className={input} value={start} onChange={(e) => setStart(e.target.value)} /><span>→</span><input type="time" aria-label="Fin" className={input} value={end} onChange={(e) => setEnd(e.target.value)} /></>}
              <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> Journée entière</label>
            </div>
            <input aria-label="Lieu" placeholder="Lieu" className={`${input} w-full`} value={location} onChange={(e) => setLocation(e.target.value)} />
            <textarea aria-label="Description" placeholder="Description" rows={3} className={`${input} w-full`} value={description} onChange={(e) => setDescription(e.target.value)} />
            {err && <p role="alert" className="text-sm text-red-600">{err}</p>}
            <div className="flex justify-end gap-2"><button className={btn} onClick={onClose}>Annuler</button><button className={`${btn} font-medium`} onClick={save}>Enregistrer</button></div>
          </>
        )}
      </div>
    </div>
  );
}

export function CalendarPage({ openAt }: { openAt?: number | null }) {
  const [view, setView] = useState<View>("week");
  const [anchor, setAnchor] = useState(() => (openAt ? new Date(openAt) : new Date()));
  const [events, setEvents] = useState<Ev[]>([]);
  const [open, setOpen] = useState<Ev | null>(null);
  const [draft, setDraft] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const [syncing, setSyncing] = useState(false);

  const [from, to] = useMemo(() => rangeFor(view, anchor), [view, anchor]);
  const load = useCallback(() => {
    rpc<Ev[]>("calendar.list", { from: +from, to: +to }).then((r) => { setEvents(r); setErr(""); }).catch((e) => setErr(String(e)));
  }, [from, to]);

  useEffect(load, [load]);
  useEffect(() => { if (openAt) setAnchor(new Date(openAt)); }, [openAt]);
  useEffect(() => {
    const un = listen<{ method: string; params: { status?: string } }>("sidecar-event", ({ payload }) => {
      if (payload.method !== "calendar.event") return;
      setSyncing(payload.params.status === "syncing");
      if (payload.params.status !== "syncing") load();
    });
    return () => void un.then((f) => f());
  }, [load]);

  const step = (dir: number) => setAnchor((a) => view === "month" ? new Date(a.getFullYear(), a.getMonth() + dir, 1) : addDays(a, dir * (view === "day" ? 1 : view === "week" ? 7 : 30)));
  const title = view === "month" ? fmtDay(anchor, { month: "long", year: "numeric" })
    : view === "day" ? fmtDay(anchor, { dateStyle: "full" })
    : `${fmtDay(from, { day: "numeric", month: "short" })} – ${fmtDay(addDays(to, -1), { day: "numeric", month: "short", year: "numeric" })}`;
  const days = view === "day" ? [from] : Array.from({ length: 7 }, (_, i) => addDays(from, i));

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button className={btn} onClick={() => setAnchor(new Date())}>Aujourd'hui</button>
        <button className={btn} aria-label="Précédent" onClick={() => step(-1)}>←</button>
        <button className={btn} aria-label="Suivant" onClick={() => step(1)}>→</button>
        <h2 className="mx-2 text-base font-medium capitalize">{title}</h2>
        {syncing && <span role="status" className="text-xs text-amber-600">synchronisation…</span>}
        <div className="ml-auto flex gap-1" role="group" aria-label="Vue">
          {([["day", "Jour"], ["week", "Semaine"], ["month", "Mois"], ["agenda", "Agenda"]] as const).map(([v, l]) => (
            <button key={v} aria-pressed={view === v} onClick={() => setView(v)} className={`${btn} ${view === v ? "bg-neutral-100 font-medium dark:bg-neutral-800" : ""}`}>{l}</button>
          ))}
        </div>
        <button className={btn} onClick={() => rpc("calendar.sync", {}).then(load)}>Synchroniser</button>
        <button className={`${btn} font-medium`} onClick={() => setDraft(Date.now() - (Date.now() % 3600_000) + 3600_000)}>+ Nouvel événement</button>
      </div>
      {err && <p role="alert" className="mb-2 text-sm text-red-600">{err}</p>}
      {(view === "day" || view === "week") && <TimeGrid days={days} events={events} onOpen={setOpen} onCreate={setDraft} />}
      {view === "month" && <Month anchor={anchor} events={events} onOpen={setOpen} onCreate={setDraft} onPick={(d) => { setAnchor(d); setView("day"); }} />}
      {view === "agenda" && <Agenda anchor={anchor} events={events} onOpen={setOpen} />}
      {(open || draft !== null) && <EventDialog key={open?.id ?? `new${draft}`} ev={open} draft={draft} onClose={() => { setOpen(null); setDraft(null); }} onSaved={load} />}
    </div>
  );
}
