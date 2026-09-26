import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import "lenis/dist/lenis.css";
import "./globals.css";
import { body, display, mono } from "./fonts";
import { Grain } from "@/components/Grain";
import { MotionPreferences } from "@/components/MotionPreferences";
import { SmoothScroll } from "@/components/SmoothScroll";
import { ThemeProvider } from "@/components/ThemeProvider";
import { Providers } from "@/lib/wallet/Providers";
import { THEME_COOKIE, parseThemeChoice, serverResolvedTheme, themeHeadScript } from "@/lib/theme";

// Absolute links in shared cards need the real origin: set explicitly, else Vercel's production domain, else local dev.
function siteUrl(): URL {
  if (process.env.NEXT_PUBLIC_SITE_URL) return new URL(process.env.NEXT_PUBLIC_SITE_URL);
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return new URL(`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`);
  return new URL("http://localhost:3000");
}

const TAGLINE = "Pay your bills with your bitcoin, without selling it.";
const DESCRIPTION =
  "Pledge your bitcoin on Morpho, borrow exactly the bill, and pay your supplier in USDC or EURC in one signature on Arc. Adag refuses any payment that would push the loan past 40%.";

export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title: { default: `Adag · ${TAGLINE}`, template: "%s · Adag" },
  description: DESCRIPTION,
  applicationName: "Adag",
  openGraph: {
    type: "website",
    siteName: "Adag",
    locale: "en",
    title: `Adag · ${TAGLINE}`,
    description: DESCRIPTION,
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: `Adag · ${TAGLINE}`,
    description: DESCRIPTION,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const choice = parseThemeChoice((await cookies()).get(THEME_COOKIE)?.value);

  return (
    <html
      lang="en"
      data-theme={serverResolvedTheme(choice)}
      data-theme-choice={choice}
      className={`${display.variable} ${body.variable} ${mono.variable}`}
      // The head script may change data-theme before React hydrates, which is the whole point of it.
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeHeadScript }} />
      </head>
      <body className="bg-bg text-text type-body">
        <ThemeProvider initialChoice={choice}>
          <MotionPreferences>
            <SmoothScroll />
            <Providers>{children}</Providers>
            <Grain />
          </MotionPreferences>
        </ThemeProvider>
      </body>
    </html>
  );
}
