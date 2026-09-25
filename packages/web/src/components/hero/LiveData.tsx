"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { parseSnapshot } from "@/lib/arc/present";
import type { LiveSnapshot } from "@/lib/arc/types";

const REFRESH_MS = 30_000;
const SLOW_MS = 2_000;
const FETCH_TIMEOUT_MS = 12_000;
// A good answer is still shown through one failed refresh; past this age the cells read "unavailable" instead.
const STALE_AFTER_MS = 75_000;
const MAX_BODY_CHARS = 64_000;

export type LiveState =
  | { status: "loading"; slow: boolean }
  | { status: "ready"; snapshot: LiveSnapshot; receivedAt: number }
  | { status: "failed" };

const LiveContext = createContext<LiveState>({ status: "loading", slow: false });

export function useLive() {
  return useContext(LiveContext);
}

async function fetchSnapshot(signal: AbortSignal): Promise<LiveSnapshot | null> {
  const res = await fetch("/api/live", { cache: "no-store", signal });
  if (!res.ok) return null;
  const text = await res.text();
  if (text.length > MAX_BODY_CHARS) return null;
  try {
    return parseSnapshot(JSON.parse(text));
  } catch {
    return null;
  }
}

export function LiveData({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<LiveState>({ status: "loading", slow: false });
  const lastGood = useRef<{ snapshot: LiveSnapshot; receivedAt: number } | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const slowTimer = window.setTimeout(() => {
      if (alive) setState((s) => (s.status === "loading" ? { status: "loading", slow: true } : s));
    }, SLOW_MS);

    const load = async () => {
      const controller = new AbortController();
      const abort = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let snapshot: LiveSnapshot | null = null;
      try {
        snapshot = await fetchSnapshot(controller.signal);
      } catch {
        snapshot = null;
      } finally {
        window.clearTimeout(abort);
      }
      if (!alive) return;
      if (snapshot) {
        lastGood.current = { snapshot, receivedAt: Date.now() };
        setState({ status: "ready", ...lastGood.current });
      } else if (!lastGood.current || Date.now() - lastGood.current.receivedAt > STALE_AFTER_MS) {
        setState({ status: "failed" });
      }
      if (document.visibilityState === "visible") timer = window.setTimeout(load, REFRESH_MS);
    };

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      window.clearTimeout(timer);
      void load();
    };

    void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      window.clearTimeout(slowTimer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return <LiveContext.Provider value={state}>{children}</LiveContext.Provider>;
}
