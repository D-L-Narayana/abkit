/**
 * Theme state shared by the whole app.
 * - The inline script in index.html applies the theme before first paint (no flash).
 * - Until the visitor picks a theme explicitly we follow `prefers-color-scheme`, live.
 * - The choice is persisted in localStorage under `abkit-theme`.
 */
import { useEffect, useSyncExternalStore } from "react";

export type Theme = "light" | "dark";
const KEY = "abkit-theme";
const listeners = new Set<() => void>();
const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "dark" || v === "light" ? v : null;
  } catch {
    return null;
  }
}
function systemTheme(): Theme {
  return media?.matches ? "dark" : "light";
}
export function currentTheme(): Theme {
  return stored() ?? systemTheme();
}
function apply(t: Theme): void {
  document.documentElement.dataset.theme = t;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = t === "dark" ? "#17171c" : "#f7f7f9";
}
function emit(): void {
  apply(currentTheme());
  listeners.forEach((l) => l());
}
media?.addEventListener("change", () => {
  if (!stored()) emit();
});
window.addEventListener("storage", (e) => {
  if (e.key === KEY) emit();
});

export function setTheme(t: Theme): void {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* private mode: keep it for this page only */
  }
  emit();
}
function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function useTheme(): { theme: Theme; toggle: () => void; set: (t: Theme) => void } {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => "light" as Theme);
  useEffect(() => apply(theme), [theme]);
  return { theme, toggle: () => setTheme(theme === "dark" ? "light" : "dark"), set: setTheme };
}

/** Sets document.title for the lifetime of a page component. */
export function useTitle(title: string): void {
  useEffect(() => {
    const prev = document.title;
    document.title = title;
    return () => {
      document.title = prev;
    };
  }, [title]);
}
