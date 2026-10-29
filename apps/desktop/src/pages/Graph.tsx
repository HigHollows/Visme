import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { rpc } from "../rpc";

interface GNode { id: string; type: string; label: string; degree: number; props: Record<string, any> }
interface GEdge { src: string; dst: string; rel: string; manual: boolean }
interface Pos { x: number; y: number; vx: number; vy: number }

const TYPES: Record<string, { label: string; color: string }> = {
  person: { label: "Personnes", color: "#2563eb" }, org: { label: "Organisations", color: "#16a34a" }, mail: { label: "Mails", color: "#ea580c" },
  document: { label: "Documents", color: "#9333ea" }, event: { label: "Événements", color: "#0891b2" }, task: { label: "Tâches", color: "#ca8a04" },
  project: { label: "Projets", color: "#dc2626" }, topic: { label: "Sujets", color: "#64748b" },
};
const btn = "rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";
const input = "rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700";
const W = 900, H = 600, MAX_SHOWN = 160;

export function Graph({ onOpen }: { onOpen: (type: string, ref: string) => void }) {
  const [data, setData] = useState<{ nodes: GNode[]; edges: GEdge[] }>({ nodes: [], edges: [] });
  const [hidden, setHidden] = useState<Set<string>>(new Set(["mail", "task", "event"]));
  const [sel, setSel] = useState<string | null>(null);
  const [, tick] = useState(0);
  const [msg, setMsg] = useState("");
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [newNode, setNewNode] = useState({ type: "topic", label: "" });
  const [link, setLink] = useState({ dst: "", rel: "" });
  const [rename, setRename] = useState("");
  const pos = useRef(new Map<string, Pos>());
  const drag = useRef<{ id: string | null; pan: boolean; sx: number; sy: number; ox: number; oy: number } | null>(null);
  const raf = useRef(0);
  const alpha = useRef(1);

  const load = useCallback(() => {
    rpc<{ nodes: GNode[]; edges: GEdge[] }>("memory.graph", {}).then((g) => { setData(g); alpha.current = 1; setMsg(""); }).catch((e) => setMsg(String(e)));
  }, []);
  useEffect(load, [load]);

  const shown = useMemo(() => {
    const nodes = data.nodes.filter((n) => !hidden.has(n.type)).slice(0, MAX_SHOWN);
    const ids = new Set(nodes.map((n) => n.id));
    return { nodes, edges: data.edges.filter((e) => ids.has(e.src) && ids.has(e.dst)) };
  }, [data, hidden]);

  // Simulation de forces : répulsion entre nœuds, ressort sur les liens, attraction vers le centre.
  useEffect(() => {
    for (const n of shown.nodes) if (!pos.current.has(n.id)) pos.current.set(n.id, { x: W / 2 + (Math.random() - 0.5) * 300, y: H / 2 + (Math.random() - 0.5) * 300, vx: 0, vy: 0 });
    alpha.current = Math.max(alpha.current, 0.6);
    const step = () => {
      const ns = shown.nodes.map((n) => ({ id: n.id, p: pos.current.get(n.id)! }));
      const a = alpha.current;
      for (let i = 0; i < ns.length; i++) {
        for (let j = i + 1; j < ns.length; j++) {
          const p = ns[i]!.p, q = ns[j]!.p;
          let dx = p.x - q.x, dy = p.y - q.y;
          const d2 = Math.max(dx * dx + dy * dy, 25);
          const f = (1800 * a) / d2, d = Math.sqrt(d2);
          dx = (dx / d) * f; dy = (dy / d) * f;
          p.vx += dx; p.vy += dy; q.vx -= dx; q.vy -= dy;
        }
      }
      for (const e of shown.edges) {
        const p = pos.current.get(e.src)!, q = pos.current.get(e.dst)!;
        const dx = q.x - p.x, dy = q.y - p.y, d = Math.max(Math.hypot(dx, dy), 1);
        const f = (d - 90) * 0.02 * a;
        p.vx += (dx / d) * f; p.vy += (dy / d) * f; q.vx -= (dx / d) * f; q.vy -= (dy / d) * f;
      }
      for (const { id, p } of ns) {
        if (drag.current?.id === id) continue;
        p.vx += (W / 2 - p.x) * 0.003 * a; p.vy += (H / 2 - p.y) * 0.003 * a;
        p.x += p.vx; p.y += p.vy; p.vx *= 0.8; p.vy *= 0.8;
      }
      alpha.current *= 0.985;
      tick((t) => t + 1);
      if (alpha.current > 0.02) raf.current = requestAnimationFrame(step);
    };
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [shown]);

  const restart = () => { alpha.current = Math.max(alpha.current, 0.4); cancelAnimationFrame(raf.current); tick((t) => t + 1); raf.current = requestAnimationFrame(function s() { alpha.current *= 0.985; tick((t) => t + 1); if (alpha.current > 0.02) raf.current = requestAnimationFrame(s); }); };

  const toGraph = (e: React.PointerEvent) => {
    const r = (e.currentTarget as SVGElement).closest("svg")!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W / view.k - view.x, y: ((e.clientY - r.top) / r.height) * H / view.k - view.y };
  };

  const node = data.nodes.find((n) => n.id === sel) ?? null;
  const [neighbors, setNeighbors] = useState<{ id: string; type: string; label: string; rel: string }[]>([]);
  useEffect(() => { setRename(node?.label ?? ""); if (sel) rpc<typeof neighbors>("memory.neighbors", { id: sel }).then(setNeighbors).catch(() => setNeighbors([])); else setNeighbors([]); }, [sel, node?.label]);

  const act = async (fn: () => Promise<unknown>) => { try { await fn(); load(); } catch (e) { setMsg(String(e)); } };
  const openable = node && (node.id.startsWith("doc:") ? ["document", node.id.slice(4)] : node.type === "mail" ? ["mail", node.props.mailId] : node.type === "event" ? ["event", node.props.refId] : null);

  return (
    <div className="flex gap-4">
      <div className="min-w-0 flex-1">
        <div className="mb-2 flex flex-wrap items-center gap-3 text-sm">
          {Object.entries(TYPES).map(([t, v]) => (
            <label key={t} className="flex items-center gap-1">
              <input type="checkbox" checked={!hidden.has(t)} onChange={() => setHidden((h) => { const n = new Set(h); n.has(t) ? n.delete(t) : n.add(t); return n; })} />
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: v.color }} />{v.label}
            </label>
          ))}
          <button className={btn} onClick={load}>Actualiser</button>
        </div>
        {msg && <p role="alert" className="mb-2 text-sm text-red-600">{msg}</p>}
        <svg viewBox={`0 0 ${W} ${H}`} className="h-[calc(100vh-14rem)] w-full cursor-grab rounded-md border border-neutral-200 dark:border-neutral-800" role="img" aria-label="Graphe de mémoire"
          onWheel={(e) => setView((v) => ({ ...v, k: Math.min(3, Math.max(0.4, v.k * (e.deltaY < 0 ? 1.1 : 0.9))) }))}
          onPointerDown={(e) => { if ((e.target as Element).tagName === "svg") { drag.current = { id: null, pan: true, sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y }; (e.currentTarget as Element).setPointerCapture(e.pointerId); } }}
          onPointerMove={(e) => {
            const d = drag.current; if (!d) return;
            if (d.pan) { const r = e.currentTarget.getBoundingClientRect(); setView((v) => ({ ...v, x: d.ox + ((e.clientX - d.sx) / r.width) * W / v.k, y: d.oy + ((e.clientY - d.sy) / r.height) * H / v.k })); }
            else if (d.id) { const p = pos.current.get(d.id)!; const g = toGraph(e); p.x = g.x; p.y = g.y; p.vx = p.vy = 0; restart(); }
          }}
          onPointerUp={() => { drag.current = null; }}>
          <g transform={`scale(${view.k}) translate(${view.x} ${view.y})`}>
            {shown.edges.map((e, i) => {
              const p = pos.current.get(e.src), q = pos.current.get(e.dst);
              if (!p || !q) return null;
              const hot = sel && (e.src === sel || e.dst === sel);
              return <g key={i}><line x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke={hot ? "#2563eb" : "#94a3b8"} strokeWidth={hot ? 2 : e.manual ? 1.6 : 1} strokeDasharray={e.manual ? "4 2" : undefined} opacity={0.7} />
                {hot && <text x={(p.x + q.x) / 2} y={(p.y + q.y) / 2} fontSize={9} fill="currentColor" textAnchor="middle">{e.rel}</text>}</g>;
            })}
            {shown.nodes.map((n) => {
              const p = pos.current.get(n.id); if (!p) return null;
              const r = 6 + Math.min(n.degree, 12);
              return (
                <g key={n.id} transform={`translate(${p.x} ${p.y})`} className="cursor-pointer" tabIndex={0} role="button" aria-label={`${TYPES[n.type]?.label ?? n.type} : ${n.label}`}
                  onPointerDown={(e) => { e.stopPropagation(); drag.current = { id: n.id, pan: false, sx: 0, sy: 0, ox: 0, oy: 0 }; (e.currentTarget.closest("svg") as Element).setPointerCapture(e.pointerId); setSel(n.id); }}
                  onKeyDown={(e) => e.key === "Enter" && setSel(n.id)}>
                  <circle r={r} fill={TYPES[n.type]?.color ?? "#64748b"} stroke={sel === n.id ? "#000" : "white"} strokeWidth={sel === n.id ? 3 : 1.5} />
                  <text y={r + 11} fontSize={10} textAnchor="middle" fill="currentColor">{n.label.length > 26 ? n.label.slice(0, 25) + "…" : n.label}</text>
                </g>
              );
            })}
          </g>
        </svg>
        <p className="mt-1 text-xs text-neutral-500">{shown.nodes.length} nœuds affichés sur {data.nodes.length} (les plus connectés) · traits pointillés = liens ajoutés à la main ou par un plugin · molette pour zoomer</p>
      </div>

      <aside className="w-72 shrink-0 space-y-4 overflow-y-auto text-sm" style={{ maxHeight: "calc(100vh - 10rem)" }} aria-label="Détail du nœud">
        {node ? (
          <section className="space-y-2">
            <div><span className="rounded px-1 text-xs text-white" style={{ background: TYPES[node.type]?.color }}>{TYPES[node.type]?.label ?? node.type}</span></div>
            <div className="flex gap-1"><input aria-label="Libellé" className={`${input} min-w-0 flex-1`} value={rename} onChange={(e) => setRename(e.target.value)} />
              <button className={btn} disabled={!rename.trim() || rename === node.label} onClick={() => act(() => rpc("memory.renameNode", { id: node.id, label: rename }))}>Renommer</button></div>
            {openable && openable[1] && <button className={btn} onClick={() => onOpen(openable[0]!, openable[1]!)}>Ouvrir</button>}
            <h3 className="font-medium">Liens ({neighbors.length})</h3>
            <ul className="space-y-1">
              {neighbors.map((n) => (
                <li key={n.id + n.rel} className="flex items-center gap-1"><button className="flex-1 truncate text-left hover:underline" onClick={() => setSel(n.id)}>{n.rel} → {n.label}</button>
                  <button aria-label="Supprimer le lien" className="px-1 text-neutral-400 hover:text-red-600" onClick={() => { const e = data.edges.find((x) => (x.src === node.id && x.dst === n.id) || (x.dst === node.id && x.src === n.id)); if (e) void act(() => rpc("memory.deleteEdge", e)); }}>×</button></li>
              ))}
            </ul>
            <div className="space-y-1 border-t border-neutral-200 pt-2 dark:border-neutral-800">
              <h3 className="font-medium">Ajouter un lien</h3>
              <select aria-label="Vers" className={`${input} w-full`} value={link.dst} onChange={(e) => setLink({ ...link, dst: e.target.value })}>
                <option value="">Vers…</option>{data.nodes.filter((n) => n.id !== node.id).map((n) => <option key={n.id} value={n.id}>{n.label} ({TYPES[n.type]?.label})</option>)}
              </select>
              <input aria-label="Relation" placeholder="Relation (ex. client de)" className={`${input} w-full`} value={link.rel} onChange={(e) => setLink({ ...link, rel: e.target.value })} />
              <button className={btn} disabled={!link.dst} onClick={() => act(() => rpc("memory.addEdge", { src: node.id, dst: link.dst, rel: link.rel }).then(() => setLink({ dst: "", rel: "" })))}>Relier</button>
            </div>
            <button className={`${btn} text-red-700`} onClick={() => { if (confirm(`Oublier « ${node.label} » ? Il ne sera pas recréé automatiquement.`)) void act(() => rpc("memory.forget", { id: node.id }).then(() => setSel(null))); }}>Oublier ce nœud</button>
          </section>
        ) : <p className="text-neutral-500">Cliquez sur un nœud pour le voir, le renommer ou le relier.</p>}
        <section className="space-y-1 border-t border-neutral-200 pt-3 dark:border-neutral-800">
          <h3 className="font-medium">Nouveau nœud</h3>
          <select aria-label="Type" className={`${input} w-full`} value={newNode.type} onChange={(e) => setNewNode({ ...newNode, type: e.target.value })}>
            {Object.entries(TYPES).filter(([t]) => ["person", "org", "project", "topic"].includes(t)).map(([t, v]) => <option key={t} value={t}>{v.label}</option>)}
          </select>
          <input aria-label="Nom" placeholder="Nom" className={`${input} w-full`} value={newNode.label} onChange={(e) => setNewNode({ ...newNode, label: e.target.value })} />
          <button className={btn} disabled={!newNode.label.trim()} onClick={() => act(() => rpc("memory.addNode", newNode).then(() => setNewNode({ ...newNode, label: "" })))}>Ajouter</button>
        </section>
        <section className="border-t border-neutral-200 pt-3 dark:border-neutral-800">
          <button className={`${btn} text-red-700`} onClick={() => { if (confirm("Effacer toute la mémoire en graphe (les liens ajoutés à la main aussi) ? Les mails et documents ne sont pas touchés.")) void act(() => rpc("memory.clear")); }}>Effacer la mémoire…</button>
        </section>
      </aside>
    </div>
  );
}
