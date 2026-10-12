import { Bodoni_Moda, DM_Sans, IBM_Plex_Mono, Noto_Sans_JP, Noto_Sans_KR, Noto_Sans_SC, Noto_Serif_JP, Noto_Serif_KR, Noto_Serif_SC } from "next/font/google";

// Tailwind owns the --font-display, --font-body and --font-mono names, so next/font writes to its own names.
export const display = Bodoni_Moda({
  subsets: ["latin"],
  style: ["normal", "italic"],
  axes: ["opsz"],
  display: "swap",
  variable: "--font-bodoni",
});

export const body = DM_Sans({
  subsets: ["latin"],
  axes: ["opsz"],
  display: "swap",
  variable: "--font-dm-sans",
});

export const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-plex-mono",
});

// The CJK faces sit behind the Latin ones in each stack, only under :lang(zh-CN), :lang(ko) and :lang(ja) (globals.css),
// so Latin letters and digits look the same in every language. No preload: a CJK face is served in unicode-range slices,
// and the browser fetches only the slices the page's glyphs fall in.
export const notoSerifSC = Noto_Serif_SC({ weight: "variable", display: "swap", preload: false, variable: "--font-noto-serif-sc" });
export const notoSerifKR = Noto_Serif_KR({ weight: "variable", display: "swap", preload: false, variable: "--font-noto-serif-kr" });
export const notoSerifJP = Noto_Serif_JP({ weight: "variable", display: "swap", preload: false, variable: "--font-noto-serif-jp" });
export const notoSansSC = Noto_Sans_SC({ weight: "variable", display: "swap", preload: false, variable: "--font-noto-sans-sc" });
export const notoSansKR = Noto_Sans_KR({ weight: "variable", display: "swap", preload: false, variable: "--font-noto-sans-kr" });
export const notoSansJP = Noto_Sans_JP({ weight: "variable", display: "swap", preload: false, variable: "--font-noto-sans-jp" });

export const cjkFontClass = [notoSerifSC, notoSerifKR, notoSerifJP, notoSansSC, notoSansKR, notoSansJP].map((f) => f.variable).join(" ");
