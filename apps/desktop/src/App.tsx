import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { rpc } from "./rpc";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { Chat } from "./pages/Chat";
import { MeetingRecorder } from "./audio";
import { Meetings } from "./pages/Meetings";
import { SettingsMeetings } from "./pages/SettingsMeetings";
import { SettingsProfiles, type Registry } from "./pages/SettingsProfiles";
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
  const [settingsTab, setSettingsTab] = useState<"IA" | "Comptes" | "Agent" | "Style" | "Préréglages" | "Profils" | "Réunions">("Comptes");
  const [pending, setPending] = useState(0);
  const [reg, setReg] = useState<Registry | null>(null);
  const [profileMenu, setProfileMenu] = useState(false);
  const [rec, setRec] = useState<{ id: string; title: string; startedAt: number } | null>(null);
  const [tick, setTick] = useState(0);
  const recorder = useRef<MeetingRecorder | null>(null);
  const [recErr, setRecErr] = useState("");
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

  useEffect(() => { invoke<Registry>("profiles_list").then(setReg).catch(() => {}); }, []);

  // Enregistrement de réunion : vit au niveau de l'application pour continuer pendant la navigation.
  useEffect(() => {
    if (!rec) return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => { clearInterval(t); window.removeEventListener("beforeunload", warn); };
  }, [rec]);

  const startRecording = async (o: { title: string; deviceId: string; language: string }) => {
    const m = await rpc<{ id: string; title: string }>("meetings.start", { title: o.title, language: o.language || undefined, consent: true });
    const r = new MeetingRecorder(m.id, (seg) => rpc("meetings.segment", { id: m.id, ...seg }));
    try { await r.start(o.deviceId || undefined); }
    catch (e) { await rpc("meetings.finish", { id: m.id, durationMs: 0 }).catch(() => {}); throw new Error(`Micro inaccessible : ${e instanceof Error ? e.message : e}. Autorisez le micro pour ASSISTANT dans les réglages système.`); }
    recorder.current = r;
    setRec({ id: m.id, title: m.title, startedAt: Date.now() });
    setRecErr("");
  };
  const stopRecording = async () => {
    const r = recorder.current;
    if (!r || !rec) return;
    try { const ms = await r.stop(); await rpc("meetings.finish", { id: rec.id, durationMs: ms }); setActive("Réunions"); }
    catch (e) { setRecErr(String(e)); }
    recorder.current = null; setRec(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "p") { e.preventDefault(); setProfileMenu((v) => !v); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
        <div className="relative mb-4">
          <button onClick={() => setProfileMenu((v) => !v)} aria-haspopup="menu" aria-expanded={profileMenu} title="Changer de profil (Ctrl/Cmd+Maj+P)"
            className="flex w-full items-center gap-2 rounded-md border border-neutral-200 px-3 py-2 text-left text-sm dark:border-neutral-800">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: reg?.profiles.find((p) => p.id === reg.current)?.color ?? "#64748b" }} />
            <span className="flex-1 truncate">{reg?.profiles.find((p) => p.id === reg.current)?.name ?? "Profil"}</span>▾
          </button>
          {profileMenu && reg && (
            <ul role="menu" className="absolute left-0 right-0 z-30 mt-1 rounded-md border border-neutral-200 bg-white py-1 text-sm shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
              {reg.profiles.map((p) => (
                <li key={p.id} role="none"><button role="menuitem" disabled={!!rec && p.id !== reg.current} title={rec ? "Arrêtez l'enregistrement avant de changer de profil" : ""}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-neutral-100 disabled:opacity-40 dark:hover:bg-neutral-800"
                  onClick={() => { setProfileMenu(false); if (p.id !== reg.current) void invoke("profile_switch", { id: p.id }).catch((e) => setRecErr(String(e))); }}>
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: p.color }} />{p.name}{p.id === reg.current && " ✓"}</button></li>
              ))}
              <li role="none"><button role="menuitem" className="w-full border-t border-neutral-200 px-3 py-1.5 text-left hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800" onClick={() => { setProfileMenu(false); setSettingsTab("Profils"); setActive("Settings"); }}>Gérer les profils…</button></li>
            </ul>
          )}
        </div>
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
        {rec && (
          <div role="alert" className="-mx-8 -mt-8 mb-6 flex items-center gap-3 bg-red-600 px-8 py-2 text-sm text-white">
            <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-white" />
            <strong>Enregistrement en cours</strong> — {rec.title} — {(() => { void tick; const s = Math.floor((Date.now() - rec.startedAt) / 1000); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; })()}
            <button className="ml-auto rounded bg-white px-3 py-1 font-medium text-red-700" onClick={stopRecording}>■ Arrêter</button>
          </div>
        )}
        {recErr && <p role="alert" className="mb-3 text-sm text-red-600">{recErr}</p>}
        <h1 className="text-2xl font-semibold">{active}</h1>
        {active === "Settings" ? (
          <div className="mt-4">
            <div role="tablist" aria-label="Sections des réglages" className="mb-4 flex gap-2">
              {(["Comptes", "IA", "Agent", "Style", "Préréglages", "Profils", "Réunions"] as const).map((t) => (
                <button key={t} role="tab" aria-selected={settingsTab === t} onClick={() => setSettingsTab(t)}
                  className={`rounded-md px-3 py-1 text-sm ${settingsTab === t ? "bg-neutral-100 font-medium dark:bg-neutral-800" : "hover:bg-neutral-50 dark:hover:bg-neutral-900"}`}>{t}</button>
              ))}
            </div>
            {settingsTab === "IA" ? <SettingsAI /> : settingsTab === "Agent" ? <SettingsAgent /> : settingsTab === "Style" ? <SettingsStyle /> : settingsTab === "Préréglages" ? <SettingsPresets /> : settingsTab === "Profils" ? <SettingsProfiles /> : settingsTab === "Réunions" ? <SettingsMeetings /> : <SettingsAccounts />}
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
        ) : active === "Réunions" ? (
          <div className="mt-4"><Meetings recorder={{ recording: rec, start: startRecording }} onOpenDoc={(id) => { setTarget({ doc: id }); setActive("Documents"); }} /></div>
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
