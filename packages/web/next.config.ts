import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

// The end-to-end build points the browser at a local fork, so that origin must be reachable. Real builds leave it unset.
function rpcOverrideOrigin(): string {
  const raw = process.env.NEXT_PUBLIC_ARC_RPC_URL;
  if (!raw) return "";
  try {
    return new URL(raw).origin;
  } catch {
    return "";
  }
}

// Next writes a fresh inline script into every page for its streamed data, so a fixed hash cannot cover it.
// Per-request nonces would need a proxy file; until then scripts fall back to 'self' plus inline, and every
// other directive stays strict. A hash must not be added here: browsers ignore 'unsafe-inline' once one is present.
// WalletConnect's own hosts, from Reown's CSP guidance (docs.reown.com/advanced/security/content-security-policy,
// read 27 September 2026) for the AppKit modal that @walletconnect/ethereum-provider 2.25.0 opens. Only the
// WalletConnect and Reown entries are taken: the Coinbase, 1inch, Zerion and IPFS ones serve other AppKit features, and
// their "img-src *" is left out. Added only when a project id is set at build time; without one the policy is unchanged.
const WALLETCONNECT = process.env.NEXT_PUBLIC_WC_PROJECT_ID
  ? {
      connect: [
        "https://rpc.walletconnect.com",
        "https://rpc.walletconnect.org",
        "https://relay.walletconnect.com",
        "https://relay.walletconnect.org",
        "wss://relay.walletconnect.com",
        "wss://relay.walletconnect.org",
        "https://pulse.walletconnect.com",
        "https://pulse.walletconnect.org",
        "https://api.web3modal.com",
        "https://api.web3modal.org",
        "https://keys.walletconnect.com",
        "https://keys.walletconnect.org",
        "https://notify.walletconnect.com",
        "https://notify.walletconnect.org",
        "https://echo.walletconnect.com",
        "https://echo.walletconnect.org",
        "https://push.walletconnect.com",
        "https://push.walletconnect.org",
      ],
      img: ["https://walletconnect.org", "https://walletconnect.com", "https://secure.walletconnect.com", "https://secure.walletconnect.org"],
      font: ["https://fonts.reown.com"],
      frame: ["https://verify.walletconnect.com", "https://verify.walletconnect.org", "https://secure.walletconnect.com", "https://secure.walletconnect.org"],
    }
  : null;

function contentSecurityPolicy(): string {
  const connect = ["'self'", "https://rpc.mainnet.arc.io", "https://rpc.drpc.mainnet.arc.io", rpcOverrideOrigin()];
  const script = ["'self'", "'unsafe-inline'"];
  if (isDev) {
    // Hot reload evaluates modules and talks over a websocket. Neither exists in a production build.
    script.push("'unsafe-eval'");
    connect.push("ws:");
  }
  if (WALLETCONNECT) connect.push(...WALLETCONNECT.connect);
  const directives = [
    "default-src 'self'",
    `script-src ${script.join(" ")}`,
    // React style attributes and the Mermaid diagrams both write inline styles.
    "style-src 'self' 'unsafe-inline'",
    WALLETCONNECT ? `img-src 'self' data: blob: ${WALLETCONNECT.img.join(" ")}` : "img-src 'self' data: blob:",
    WALLETCONNECT ? `font-src 'self' ${WALLETCONNECT.font.join(" ")}` : "font-src 'self'",
    `connect-src ${connect.filter(Boolean).join(" ")}`,
    WALLETCONNECT ? `frame-src ${WALLETCONNECT.frame.join(" ")}` : "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ];
  // Only a site served over https can ask the browser to upgrade; locally it would break plain http checks.
  if (process.env.VERCEL) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

const nextConfig: NextConfig = {
  // A verification build must never write into the .next folder the dev server is using.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // next dev otherwise writes its own AGENTS.md and CLAUDE.md into this folder on every start.
  agentRules: false,
  reactStrictMode: true,
  poweredByHeader: false,
  images: {
    formats: ["image/avif", "image/webp"],
    qualities: [75, 85],
  },
  // Written into the bundle at build time, so a real build turns the test-only branches into dead code
  // instead of reading them from the page at runtime.
  env: {
    NEXT_PUBLIC_ADAG_E2E: process.env.NEXT_PUBLIC_ADAG_E2E ?? "",
    NEXT_PUBLIC_ARC_RPC_URL: process.env.NEXT_PUBLIC_ARC_RPC_URL ?? "",
    NEXT_PUBLIC_WC_PROJECT_ID: process.env.NEXT_PUBLIC_WC_PROJECT_ID ?? "",
    NEXT_PUBLIC_REPO_URL: process.env.NEXT_PUBLIC_REPO_URL ?? "",
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy() },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
        ],
      },
      // Both routes keep a 15 second server cache, so the edge may answer repeats for the same window.
      ...["/api/live", "/api/pledge"].map((source) => ({
        source,
        headers: [{ key: "Cache-Control", value: "public, s-maxage=15, stale-while-revalidate=30" }],
      })),
    ];
  },
};

// Fumadocs compiles content/docs into the .source folder that src/lib/source.ts reads.
const withMDX = createMDX();

export default withMDX(nextConfig);
