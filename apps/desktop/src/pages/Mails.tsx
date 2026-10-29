import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { rpc } from "../rpc";

interface Row { id: string; subject: string; fromName: string; fromAddr: string; date: number; snippet: string; attachmentCount: number }
interface Full extends Row { toAddrs: string; body: string; attachments: { name: string; size: number }[] }

const fmtDate = (t: number) => new Date(t).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });

export function Mails({ selectedId }: { selectedId?: string | null }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(selectedId ?? null);
  const [mail, setMail] = useState<Full | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(() => {
    rpc<Row[]>("mail.list", { q: q.trim() || undefined, limit: 100 }).then((r) => { setRows(r); setErr(""); }).catch((e) => setErr(String(e)));
  }, [q]);

  useEffect(() => { const t = setTimeout(load, q ? 200 : 0); return () => clearTimeout(t); }, [load, q]);
  useEffect(() => { if (selectedId) setSel(selectedId); }, [selectedId]);
  useEffect(() => {
    const un = listen<{ method: string }>("sidecar-event", ({ payload }) => { if (payload.method === "mail.event") load(); });
    return () => void un.then((f) => f());
  }, [load]);
  useEffect(() => {
    if (!sel) { setMail(null); return; }
    rpc<Full>("mail.get", { id: sel }).then(setMail).catch((e) => setErr(String(e)));
  }, [sel]);

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-4">
      <section className="flex w-96 shrink-0 flex-col">
        <input
          aria-label="Rechercher dans les mails" placeholder="Rechercher dans les mails…" value={q} onChange={(e) => setQ(e.target.value)}
          className="mb-2 rounded-md border border-neutral-300 bg-transparent px-3 py-1.5 text-sm dark:border-neutral-700"
        />
        {err && <p role="alert" className="mb-2 text-sm text-red-600">{err}</p>}
        <ul className="flex-1 overflow-y-auto">
          {rows.length === 0 && <li className="p-2 text-sm text-neutral-500">{q ? "Aucun résultat." : "Aucun mail. Connectez un compte dans Settings → Comptes."}</li>}
          {rows.map((r) => (
            <li key={r.id}>
              <button onClick={() => setSel(r.id)} className={`block w-full rounded-md px-3 py-2 text-left ${sel === r.id ? "bg-neutral-100 dark:bg-neutral-800" : "hover:bg-neutral-50 dark:hover:bg-neutral-900"}`}>
                <div className="flex justify-between gap-2 text-sm"><span className="truncate font-medium">{r.fromName || r.fromAddr}</span><span className="shrink-0 text-xs text-neutral-500">{fmtDate(r.date)}</span></div>
                <div className="truncate text-sm">{r.subject}{r.attachmentCount > 0 && " 📎"}</div>
                <div className="truncate text-xs text-neutral-500">{r.snippet}</div>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <article className="min-w-0 flex-1 overflow-y-auto border-l border-neutral-200 pl-4 dark:border-neutral-800" aria-label="Mail">
        {!mail ? <p className="text-sm text-neutral-500">Sélectionnez un mail.</p> : (
          <>
            <h2 className="text-lg font-medium">{mail.subject}</h2>
            <p className="text-sm text-neutral-500">De {mail.fromName ? `${mail.fromName} <${mail.fromAddr}>` : mail.fromAddr} · {fmtDate(mail.date)}</p>
            <p className="mb-3 text-sm text-neutral-500">À {mail.toAddrs}</p>
            {/* Texte brut uniquement : pas de HTML distant, pas de pixels espions. */}
            <div className="whitespace-pre-wrap break-words text-sm">{mail.body}</div>
            {mail.attachments.length > 0 && (
              <ul className="mt-4 border-t border-neutral-200 pt-2 text-sm dark:border-neutral-800">
                {mail.attachments.map((a, i) => <li key={i}>📎 {a.name} <span className="text-xs text-neutral-500">({Math.max(1, Math.round(a.size / 1000))} Ko)</span></li>)}
              </ul>
            )}
          </>
        )}
      </article>
    </div>
  );
}
