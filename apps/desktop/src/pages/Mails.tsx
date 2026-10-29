import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { CATEGORY_LABEL, rpc } from "../rpc";

interface Row { category: string | null; id: string; subject: string; fromName: string; fromAddr: string; date: number; snippet: string; attachmentCount: number }
interface Att { name: string; size: number; documentId?: string }
interface Full extends Row { summary: string | null; toAddrs: string; body: string; attachments: Att[] }

const fmtDate = (t: number) => new Date(t).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });

interface Draft { id: string; body: string; scope: string | null }
const btn = "rounded-md border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";

function DraftPanel({ mailId, to }: { mailId: string; to: string }) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const load = useCallback(() => { rpc<Draft[]>("drafts.list", { mailId }).then(setDrafts).catch(() => setDrafts([])); }, [mailId]);
  useEffect(() => { setMsg(""); load(); }, [load]);

  const run = async (params: Record<string, unknown>) => {
    setBusy(true); setMsg("");
    try { await rpc("drafts.reply", { mailId, ...params }); load(); } catch (e) { setMsg(String(e)); }
    setBusy(false);
  };
  const latest = drafts[0];
  return (
    <section className="mt-6 border-t border-neutral-200 pt-3 dark:border-neutral-800" aria-label="Brouillon de réponse">
      <h3 className="mb-2 text-sm font-medium">Brouillon de réponse <span className="font-normal text-neutral-500">(jamais envoyé sans votre confirmation)</span></h3>
      <div className="flex gap-2">
        <input aria-label="Consigne" placeholder="Consigne facultative (ex. « dis que je confirme lundi »)" className="flex-1 rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700" value={instruction} onChange={(e) => setInstruction(e.target.value)} />
        <button className={btn} disabled={busy} onClick={() => run({ instruction: instruction || undefined })}>{busy ? "Rédaction…" : latest ? "Nouveau brouillon" : "Rédiger"}</button>
      </div>
      {msg && <p role="alert" className="mt-1 text-sm text-red-600">{msg}</p>}
      {latest && (
        <div className="mt-2 space-y-2">
          {latest.scope && <p className="text-xs text-neutral-500">Style appliqué : {latest.scope}</p>}
          <textarea aria-label="Brouillon" rows={8} className="w-full rounded-md border border-neutral-300 bg-transparent p-2 text-sm dark:border-neutral-700" key={latest.id} defaultValue={latest.body}
            onBlur={(e) => { if (e.target.value !== latest.body) void rpc("drafts.update", { id: latest.id, body: e.target.value }).then(load); }} />
          <div className="flex flex-wrap gap-2">
            {([["shorter", "Plus court"], ["formal", "Plus formel"], ["direct", "Plus direct"]] as const).map(([k, l]) => <button key={k} className={btn} disabled={busy} onClick={() => run({ rewrite: k, draftId: latest.id })}>{l}</button>)}
            <button className={`${btn} font-medium`} disabled={busy} onClick={async () => {
              if (!confirm(`Envoyer ce message maintenant ?\n\nÀ : ${to}\n\n${latest.body.slice(0, 600)}${latest.body.length > 600 ? "…" : ""}`)) return;
              try { await rpc("drafts.send", { draftId: latest.id, confirm: true }); setMsg("Message envoyé."); load(); } catch (e) { setMsg(String(e)); }
            }}>Envoyer…</button>
            <button className={btn} onClick={() => navigator.clipboard.writeText(latest.body).then(() => setMsg("")).catch(() => setMsg("Copie impossible"))}>Copier</button>
            <button className={btn} onClick={() => rpc("drafts.delete", { id: latest.id }).then(load)}>Supprimer</button>
          </div>
        </div>
      )}
    </section>
  );
}

export function Mails({ selectedId, onOpenDoc }: { selectedId?: string | null; onOpenDoc?: (id: string) => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(selectedId ?? null);
  const [mail, setMail] = useState<Full | null>(null);
  const [err, setErr] = useState("");
  const [attMsg, setAttMsg] = useState("");

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
                <div className="truncate text-sm">{r.category && <span className="mr-1 rounded bg-neutral-100 px-1 text-xs dark:bg-neutral-800">{CATEGORY_LABEL[r.category]}</span>}{r.subject}{r.attachmentCount > 0 && " 📎"}</div>
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
            {(mail.summary || mail.category) && (
              <div className="mb-3 rounded-md bg-purple-50 p-3 text-sm dark:bg-purple-950/40">
                <span className="text-xs font-medium text-purple-800 dark:text-purple-300">Analyse de l'IA{mail.category ? ` · ${CATEGORY_LABEL[mail.category]}` : ""}</span>
                {mail.summary && <p>{mail.summary}</p>}
              </div>
            )}
            {/* Texte brut uniquement : pas de HTML distant, pas de pixels espions. */}
            <div className="whitespace-pre-wrap break-words text-sm">{mail.body}</div>
            <DraftPanel mailId={mail.id} to={mail.fromAddr} />
            {mail.attachments.length > 0 && (
              <div className="mt-4 border-t border-neutral-200 pt-2 text-sm dark:border-neutral-800">
                <ul>
                  {mail.attachments.map((a, i) => (
                    <li key={i}>📎 {a.name} <span className="text-xs text-neutral-500">({Math.max(1, Math.round(a.size / 1000))} Ko)</span>
                      {a.documentId && <button className="ml-2 text-xs underline" onClick={() => onOpenDoc?.(a.documentId!)}>indexée</button>}</li>
                  ))}
                </ul>
                {mail.attachments.some((a) => !a.documentId) && (
                  <button className={`${btn} mt-2`} onClick={async () => {
                    setAttMsg("Import…");
                    try {
                      const r = await rpc<{ imported: number; skipped: { name: string; reason: string }[] }>("mail.importAttachments", { id: mail.id });
                      setAttMsg(`${r.imported} importée(s)${r.skipped.length ? ` · ignorées : ${r.skipped.map((s) => `${s.name} (${s.reason})`).join(", ")}` : ""}`);
                      setMail(await rpc<Full>("mail.get", { id: mail.id }));
                    } catch (e) { setAttMsg(String(e)); }
                  }}>Importer les pièces jointes dans les documents</button>
                )}
                {attMsg && <p role="status" className="mt-1 text-xs text-neutral-500">{attMsg}</p>}
              </div>
            )}
          </>
        )}
      </article>
    </div>
  );
}
