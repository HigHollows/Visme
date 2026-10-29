export type Theme = "system" | "light" | "dark";

let media: MediaQueryList | null = null;
let listener: (() => void) | null = null;

/** Applique le thème (classe `dark` sur <html>) ; « système » suit les préférences de l'OS en direct. */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (media && listener) media.removeEventListener("change", listener);
  media = null; listener = null;
  const set = (dark: boolean) => { root.classList.toggle("dark", dark); root.style.colorScheme = dark ? "dark" : "light"; };
  if (theme === "system") {
    media = window.matchMedia("(prefers-color-scheme: dark)");
    listener = () => set(media!.matches);
    media.addEventListener("change", listener);
    set(media.matches);
  } else set(theme === "dark");
}
