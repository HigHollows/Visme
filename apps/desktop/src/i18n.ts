import { en } from "./en";

export type Lang = "fr" | "en";

const KEY = "assistant.lang";

/** Langue de départ : celle mémorisée (lecture synchrone, nécessaire aux textes évalués au chargement), sinon celle du système. */
function initial(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "fr" || saved === "en") return saved;
  } catch { /* stockage indisponible */ }
  return typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("fr") ? "fr" : "en";
}

let lang: Lang = initial();

export const getLang = () => lang;

/** Mémorise la langue (appliquée au prochain chargement de l'interface). */
export function rememberLang(l: Lang) {
  try { localStorage.setItem(KEY, l); } catch { /* facultatif */ }
}

/**
 * Traduit un texte écrit en français (la clé EST le texte français). `{0}`, `{1}`… sont remplacés par les arguments.
 * Un texte sans traduction reste en français : jamais d'écran vide.
 */
export function tr(fr: string, ...args: unknown[]): string {
  let s = lang === "en" ? (en[fr] ?? fr) : fr;
  if (args.length) s = s.replace(/\{(\d+)\}/g, (m, i) => (args[Number(i)] === undefined ? m : String(args[Number(i)])));
  return s;
}

/** Locale pour les dates et nombres. */
export const locale = () => (lang === "en" ? "en-GB" : "fr-FR");
