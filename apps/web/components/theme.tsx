"use client";

import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";
const KEY = "dipbuyer:theme";

/**
 * Runs in <head> before first paint: the saved choice, else the system setting. Without it the
 * page would render light and flash to dark on hydration. Storage can throw (private mode,
 * blocked site data), so it falls back to the system setting.
 */
export const THEME_SCRIPT = `(function(){var t;try{t=localStorage.getItem('${KEY}')}catch(e){}if(t!=='light'&&t!=='dark'){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.setAttribute('data-theme',t)})();`;

const current = (): Theme => (typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");

/** Current theme, kept in sync with <html data-theme> (so embeds can follow it). */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>("light");
  useEffect(() => {
    setThemeState(current());
    const observer = new MutationObserver(() => setThemeState(current()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    // Follow the system while the user has not chosen explicitly.
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onSystem = (e: MediaQueryListEvent) => {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(KEY);
      } catch {
        saved = null;
      }
      if (saved !== "light" && saved !== "dark") document.documentElement.setAttribute("data-theme", e.matches ? "dark" : "light");
    };
    mq?.addEventListener?.("change", onSystem);
    return () => {
      observer.disconnect();
      mq?.removeEventListener?.("change", onSystem);
    };
  }, []);
  const setTheme = useCallback((t: Theme) => {
    document.documentElement.setAttribute("data-theme", t);
    try {
      localStorage.setItem(KEY, t);
    } catch {
      // storage unavailable: the choice lasts for this page view only
    }
  }, []);
  return { theme, setTheme };
}

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const dark = theme === "dark";
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => setTheme(dark ? "light" : "dark")}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Light mode" : "Dark mode"}
    >
      {dark ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
        </svg>
      )}
    </button>
  );
}
