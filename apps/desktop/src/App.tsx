import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Chat } from "./pages/Chat";
import { SettingsAI } from "./pages/SettingsAI";

const SECTIONS = [
  "Accueil", "Mails", "Calendrier", "Tâches", "Documents", "Échéances",
  "Réunions", "Chat", "Graphe", "À valider", "Plugins", "Settings",
] as const;

export function App() {
  const [active, setActive] = useState<(typeof SECTIONS)[number]>("Accueil");
  const [version, setVersion] = useState<string>("…");

  const [autonomy, setAutonomy] = useState<string>("…");

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
                onClick={() => setActive(s)}
                aria-current={active === s ? "page" : undefined}
                className={`w-full rounded-md px-3 py-1.5 text-left text-sm ${active === s ? "bg-neutral-100 font-medium dark:bg-neutral-800" : "hover:bg-neutral-50 dark:hover:bg-neutral-900"}`}
              >
                {s}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <main className="flex-1 overflow-y-auto p-8">
        <h1 className="text-2xl font-semibold">{active}</h1>
        {active === "Settings" ? (
          <div className="mt-4">
            <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-neutral-500">IA</h2>
            <SettingsAI />
          </div>
        ) : active === "Chat" ? (
          <div className="mt-4"><Chat /></div>
        ) : (
          <>
        <p className="mt-2 text-sm text-neutral-500">Version {version} — section en construction.</p>
        <p className="mt-1 text-sm text-neutral-500">Autonomie (via sidecar + base chiffrée) : {autonomy}</p>
          </>
        )}
      </main>
    </div>
  );
}
