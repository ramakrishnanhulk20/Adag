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

export const metadata: Metadata = {
  title: "Adag",
  description: "Pay the bill. Keep the bitcoin. Adag pays suppliers in USDC or EURC against bitcoin pledged on Morpho, on Arc.",
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
