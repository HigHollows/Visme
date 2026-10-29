import React from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { App } from "./App";
import { CaptureApp } from "./CaptureApp";
import "./index.css";
import { applyTheme } from "./theme";
import { rpc } from "./rpc";

applyTheme("system"); // évite un flash clair avant la lecture des réglages
// Le thème choisi est dans les réglages (base chiffrée) : on attend que la coque soit prête, et on n'y touche pas si l'application est verrouillée.
void (async () => {
  for (let i = 0; i < 100; i++) {
    try {
      const st = await invoke<{ ready: boolean; locked: boolean }>("lock_status");
      if (st.ready) {
        if (!st.locked) applyTheme((await rpc<{ general: { theme: "system" | "light" | "dark" } }>("settings.get")).general.theme);
        return;
      }
    } catch { /* pas encore prête */ }
    await new Promise((r) => setTimeout(r, 150));
  }
})();

let label = "main";
try { label = getCurrentWebviewWindow().label; } catch { /* hors Tauri (aperçu navigateur) */ }

// Changement de profil : toute l'interface (toutes les fenêtres) repart de zéro, aucun état d'un profil ne survit dans l'autre.
void listen("profile-changed", () => window.location.reload());

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{label === "capture" ? <CaptureApp /> : <App />}</React.StrictMode>,
);
