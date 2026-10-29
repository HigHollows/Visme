import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { rpc } from "./rpc";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { Chat } from "./pages/Chat";
import { Deadlines } from "./pages/Deadlines";
import { Graph } from "./pages/Graph";
import { Home } from "./pages/Home";
import { Plugins } from "./pages/Plugins";
import { SettingsPresets } from "./pages/SettingsPresets";
import { SettingsStyle } from "./pages/SettingsStyle";
import { Inbox } from "./pages/Inbox";
import { SettingsAgent } from "./pages/SettingsAgent";
import { Tasks } from "./pages/Tasks";
import { CalendarPage } from "./pages/Calendar";
import { Documents } from "./pages/Documents";
import { Mails } from "./pages/Mails";
import { SettingsAccounts } from "./pages/SettingsAccounts";
import { SearchPalette } from "./SearchPalette";
import { SettingsAI } from "./pages/SettingsAI";

const SECTIONS = [
  "Accueil", "Mails", "Calendrier", "Tâches", "Documents", "Échéances",
  "Réunions", "Chat", "Graphe", "À valider", "Plugins", "Settings",
] as const;

export function App() {
  const [active, setActive] = useState<(typeof SECTIONS)[number]>("Accueil");
  const [settingsTab, setSettingsTab] = useState<"IA" | "Comptes" | "Agent" | "Style" | "Préréglages">("Comptes");
  const [pending, setPending] = useState(0);
  const [palette, setPalette] = useState(false);
  const [target, setTarget] = useState<{ chat?: string | null; doc?: string | null; mail?: string | null; cal?: number | null }>({});
  const [version, setVersion] = useState<string>("…");

  const [autonomy, setAutonomy] = useState<string>("…");

  useEffect(() => {
    const refresh = () => rpc<{ pending: number }>("proposals.count").then((r) => setPending(r.pending)).catch(() => {});
    refresh();
    const un = listen<{ method: string }>("sidecar-event", ({ payload }) => {
      if (payload.method === "proposals.event" || payload.method === "agent.event") refresh();
    });
    return () => void un.then((f) => f());
  }, []);

  useEffect(() => {
    const un = listen<{ method: string; params: { service: string; kind: "due" | "cancel"; days: number } }>("sidecar-event", async ({ payload }) => {
      if (payload.method !== "deadline.alert") return;
      const a = payload.params;
      try {
        let ok = await isPermissionGranted();
        if (!ok) ok = (await requestPermission()) === "granted";
        if (ok) sendNotification({
          title: a.kind === "cancel" ? `Résiliation : ${a.service}` : `Échéance : ${a.service}`,
          body: a.days === 0 ? "C'est aujourd'hui." : a.days === 1 ? "C'est demain." : `Dans ${a.days} jours au plus tard.`,
        });
      } catch { /* les notifications système sont facultatives */ }
    });
    return () => void un.then((f) => f());
  }, []);

  useEffect(() => { invoke("set_badge", { count: pending }).catch(() => {}); }, [pending]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((p) => !p); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    invoke<string>("app_version").then(setVersion).catch(() => setVersion("web"));
    invoke<{ agent: { autonomy: string } }>("rpc", { method: "settings.get" })
      .then((s) => setAutonomy(s.agent.autonomy))
      .catch((e) => setAutonomy(`erreur : ${e}`));
  }, []);

  return (
    <div className="flex h-screen bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <nav aria-label="Navigation principale" className="w-56 shrink-0 border-r border-neutral-200 p-3 dark:border-neutral-800">
        <div className="mb-4 rounded-md border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-800">Profil : Pro</div>
        <ul className="space-y-1">
          {SECTIONS.map((s) => (
            <li key={s}>
              <button
                onClick={() => { setTarget({}); setActive(s); }}
                aria-current={active === s ? "page" : undefined}
                className={`w-full rounded-md px-3 py-1.5 text-left text-sm ${active === s ? "bg-neutral-100 font-medium dark:bg-neutral-800" : "hover:bg-neutral-50 dark:hover:bg-neutral-900"}`}
              >
                {s}
                {s === "À valider" && pending > 0 && <span aria-label={`${pending} en attente`} className="ml-2 rounded-full bg-red-600 px-1.5 text-xs text-white">{pending}</span>}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <main className="flex-1 overflow-y-auto p-8">
        <h1 className="text-2xl font-semibold">{active}</h1>
        {active === "Settings" ? (
          <div className="mt-4">
            <div role="tablist" aria-label="Sections des réglages" className="mb-4 flex gap-2">
              {(["Comptes", "IA", "Agent", "Style", "Préréglages"] as const).map((t) => (
                <button key={t} role="tab" aria-selected={settingsTab === t} onClick={() => setSettingsTab(t)}
                  className={`rounded-md px-3 py-1 text-sm ${settingsTab === t ? "bg-neutral-100 font-medium dark:bg-neutral-800" : "hover:bg-neutral-50 dark:hover:bg-neutral-900"}`}>{t}</button>
              ))}
            </div>
            {settingsTab === "IA" ? <SettingsAI /> : settingsTab === "Agent" ? <SettingsAgent /> : settingsTab === "Style" ? <SettingsStyle /> : settingsTab === "Préréglages" ? <SettingsPresets /> : <SettingsAccounts />}
          </div>
        ) : active === "Chat" ? (
          <div className="mt-4"><Chat openId={target.chat} onOpenSource={(type, id) => {
            if (type === "document") { setTarget({ doc: id }); setActive("Documents"); }
            else if (type === "mail") { setTarget({ mail: id }); setActive("Mails"); }
            else if (type === "event") { setTarget({}); setActive("Calendrier"); }
          }} /></div>
        ) : active === "Accueil" ? (
          <div className="mt-4"><Home go={(sec) => { setTarget({}); setActive(sec as typeof active); }} onOpenMail={(id) => { setTarget({ mail: id }); setActive("Mails"); }} /></div>
        ) : active === "À valider" ? (
          <div className="mt-4"><Inbox onOpenMail={(id) => { setTarget({ mail: id }); setActive("Mails"); }} /></div>
        ) : active === "Tâches" ? (
          <div className="mt-4"><Tasks onOpenMail={(id) => { setTarget({ mail: id }); setActive("Mails"); }} /></div>
        ) : active === "Graphe" ? (
          <div className="mt-4"><Graph onOpen={(type, id) => {
            if (type === "document") { setTarget({ doc: id }); setActive("Documents"); }
            else if (type === "mail") { setTarget({ mail: id }); setActive("Mails"); }
            else { setTarget({}); setActive("Calendrier"); }
          }} /></div>
        ) : active === "Échéances" ? (
          <div className="mt-4"><Deadlines onOpenMail={(id) => { setTarget({ mail: id }); setActive("Mails"); }} /></div>
        ) : active === "Plugins" ? (
          <div className="mt-4"><Plugins /></div>
        ) : active === "Calendrier" ? (
          <div className="mt-4"><CalendarPage openAt={target.cal} /></div>
        ) : active === "Mails" ? (
          <div className="mt-4"><Mails selectedId={target.mail} /></div>
        ) : active === "Documents" ? (
          <div className="mt-4"><Documents selectedId={target.doc} /></div>
        ) : (
          <>
        <p className="mt-2 text-sm text-neutral-500">Version {version} — section en construction.</p>
        <p className="mt-1 text-sm text-neutral-500">Autonomie (via sidecar + base chiffrée) : {autonomy}</p>
          </>
        )}
      </main>
      {palette && (
        <SearchPalette
          actions={[
            ...SECTIONS.map((n) => ({ id: `go:${n}`, label: `Aller à ${n}`, run: () => setActive(n) })),
            { id: "newchat", label: "Nouvelle conversation", run: () => { setTarget({ chat: null }); setActive("Chat"); } },
          ]}
          onOpen={(type, id) => {
            if (type === "document") { setTarget({ doc: id }); setActive("Documents"); }
            else if (type === "event") { setTarget({ cal: Number(id) }); setActive("Calendrier"); }
            else if (type === "mail") { setTarget({ mail: id }); setActive("Mails"); }
            else { setTarget({ chat: id }); setActive("Chat"); }
          }}
          onClose={() => setPalette(false)}
        />
      )}
    </div>
  );
}
