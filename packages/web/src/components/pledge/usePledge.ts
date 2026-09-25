"use client";

import { useEffect, useState } from "react";
import type { PledgeSnapshot } from "@/lib/arc/pledge";
import { parsePledge } from "./parse";

const REFRESH_MS = 60_000;
const SLOW_MS = 2_000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_BODY_CHARS = 64_000;

export type PledgeState = { status: "loading"; slow: boolean } | { status: "ready"; snapshot: PledgeSnapshot } | { status: "failed" };

async function fetchPledge(signal: AbortSignal): Promise<PledgeSnapshot | null> {
  const res = await fetch("/api/pledge", { cache: "no-store", signal });
  if (!res.ok) return null;
  const text = await res.text();
  if (text.length > MAX_BODY_CHARS) return null;
  try {
    return parsePledge(JSON.parse(text));
  } catch {
    return null;
  }
}

export function usePledge(): PledgeState {
  const [state, setState] = useState<PledgeState>({ status: "loading", slow: false });

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    let hadGood = false;
    const slowTimer = window.setTimeout(() => {
      if (alive) setState((s) => (s.status === "loading" ? { status: "loading", slow: true } : s));
    }, SLOW_MS);

    const load = async () => {
      const controller = new AbortController();
      const abort = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let snapshot: PledgeSnapshot | null = null;
      try {
        snapshot = await fetchPledge(controller.signal);
      } catch {
        snapshot = null;
      } finally {
        window.clearTimeout(abort);
      }
      if (!alive) return;
      if (snapshot) {
        hadGood = true;
        setState({ status: "ready", snapshot });
      } else if (!hadGood) {
        setState({ status: "failed" });
      }
      if (document.visibilityState === "visible") timer = window.setTimeout(load, REFRESH_MS);
    };

    void load();
    return () => {
      alive = false;
      window.clearTimeout(timer);
      window.clearTimeout(slowTimer);
    };
  }, []);

  return state;
}
