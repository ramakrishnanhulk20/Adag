"use client";

import { createAppKit } from "@reown/appkit/react";
import { arc } from "viem/chains";
import type { ResolvedTheme } from "@/lib/theme";
import { customRpcUrls, projectId, wagmiAdapter } from "./config";
import { siteUrl } from "./site";

// The gold is a shade deeper on the light page so it keeps its contrast there.
const ACCENT: Record<ResolvedTheme, string> = { dark: "#D9A94A", light: "#B07A22" };

function themeVariables(theme: ResolvedTheme) {
  return { "--apkt-accent": ACCENT[theme], "--apkt-font-family": "var(--font-dm-sans), system-ui, sans-serif" };
}

// The head script has already set data-theme before any module runs, so the modal opens in the page's own theme.
const startTheme: ResolvedTheme = typeof document !== "undefined" && document.documentElement.dataset.theme === "light" ? "light" : "dark";

// createAppKit may only run once, so it lives at module level. It runs in the browser only: on the server it would
// call Reown's API for every cold start and every test build, and there is no modal to draw there anyway. Without a
// project id there is no modal and the connect button falls back to the injected wallet (lib/wallet/config.ts).
export const appKit =
  typeof window !== "undefined" && projectId && wagmiAdapter
    ? createAppKit({
        adapters: [wagmiAdapter],
        projectId,
        networks: [arc],
        defaultNetwork: arc,
        metadata: { name: "Adag", description: "Pay the bill. Keep the bitcoin.", url: siteUrl(), icons: [`${siteUrl()}/apple-icon.png`] },
        customRpcUrls,
        // Everything Reown offers beyond connecting a wallet either does not work on Arc or signs outside Adag's checks.
        features: { email: false, socials: false, swaps: false, onramp: false, history: false, send: false, analytics: false },
        enableCoinbase: false,
        enableBaseAccount: false,
        enableWalletGuide: false,
        // Adag's own Switch to Arc is the one switch flow, and send.ts refuses to sign on any chain but 5042.
        allowUnsupportedChain: true,
        themeMode: startTheme,
        themeVariables: themeVariables(startTheme),
      })
    : null;

export function followSiteTheme(theme: ResolvedTheme) {
  appKit?.setThemeMode(theme);
  appKit?.setThemeVariables(themeVariables(theme));
}
