import React from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import { App } from "./App";
import { CaptureApp } from "./CaptureApp";
import "./index.css";

let label = "main";
try { label = getCurrentWebviewWindow().label; } catch { /* hors Tauri (aperçu navigateur) */ }

// Changement de profil : toute l'interface (toutes les fenêtres) repart de zéro, aucun état d'un profil ne survit dans l'autre.
void listen("profile-changed", () => window.location.reload());

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{label === "capture" ? <CaptureApp /> : <App />}</React.StrictMode>,
);
