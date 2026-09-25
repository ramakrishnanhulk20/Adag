"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  THEME_STORAGE_KEY,
  THEME_SWITCH_MS,
  parseThemeChoice,
  serverResolvedTheme,
  themeCookieString,
  type ResolvedTheme,
  type ThemeChoice,
} from "@/lib/theme";

type ThemeContextValue = {
  choice: ThemeChoice;
  // null only while hydrating a "system" page, when the server could not know the OS setting.
  resolved: ResolvedTheme | null;
  setChoice: (next: ThemeChoice) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

const LIGHT_QUERY = "(prefers-color-scheme: light)";

function subscribeToRoot(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-theme-choice"],
  });
  return () => observer.disconnect();
}

function readChoice(): ThemeChoice {
  return parseThemeChoice(document.documentElement.getAttribute("data-theme-choice"));
}

function readResolved(): ResolvedTheme {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia(LIGHT_QUERY).matches ? "light" : "dark";
}

export function ThemeProvider({ initialChoice, children }: { initialChoice: ThemeChoice; children: React.ReactNode }) {
  const choice = useSyncExternalStore(subscribeToRoot, readChoice, () => initialChoice);
  const resolved = useSyncExternalStore<ResolvedTheme | null>(subscribeToRoot, readResolved, () =>
    initialChoice === "system" ? null : serverResolvedTheme(initialChoice),
  );
  const switchTimer = useRef<number | undefined>(undefined);

  const apply = useCallback((nextChoice: ThemeChoice, nextResolved: ResolvedTheme) => {
    const root = document.documentElement;
    const changesColour = root.getAttribute("data-theme") !== nextResolved;
    if (changesColour) {
      root.classList.add("theme-switching");
      window.clearTimeout(switchTimer.current);
      switchTimer.current = window.setTimeout(() => root.classList.remove("theme-switching"), THEME_SWITCH_MS);
    }
    root.setAttribute("data-theme", nextResolved);
    root.setAttribute("data-theme-choice", nextChoice);
  }, []);

  const setChoice = useCallback(
    (next: ThemeChoice) => {
      document.cookie = themeCookieString(next);
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // Private browsing can block storage; the cookie alone still carries the choice.
      }
      apply(next, next === "system" ? systemTheme() : next);
    },
    [apply],
  );

  useEffect(() => {
    if (choice !== "system") return;
    const query = window.matchMedia(LIGHT_QUERY);
    const onSystemChange = () => apply("system", query.matches ? "light" : "dark");
    query.addEventListener("change", onSystemChange);
    return () => query.removeEventListener("change", onSystemChange);
  }, [choice, apply]);

  useEffect(() => () => window.clearTimeout(switchTimer.current), []);

  const value = useMemo(() => ({ choice, resolved, setChoice }), [choice, resolved, setChoice]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
}
