import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const alt = "Adag: pay your bills with your bitcoin, without selling it. Live on Arc mainnet.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Three set lines keep the words in the dark left half, clear of the gold coin in the photograph.
const LINE_1 = "Pay your bills";
const LINE_2_BEFORE = "with your ";
const LINE_2_GOLD = "bitcoin";
const LINE_3 = "without selling it.";
const HALLMARK = "LIVE ON ARC MAINNET";
const FACT = "40% cap · Morpho liquidates at 86%";

type Rgb = [number, number, number];

// tokens.css is the only place a colour value lives, so the card reads the dark theme from it when it renders.
async function darkTokens() {
  const css = await readFile(join(process.cwd(), "src/styles/tokens.css"), "utf8");
  const start = css.indexOf('[data-theme="dark"] {');
  const block = css.slice(start, css.indexOf("}", start));
  const hex = (name: string): Rgb => {
    const m = block.match(new RegExp(`--${name}:\\s*#([0-9a-fA-F]{6})`));
    if (!m) throw new Error(`tokens.css has no dark --${name}`);
    const v = parseInt(m[1]!, 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  };
  return { bg: hex("bg"), text: hex("text"), muted: hex("muted"), gold: hex("gold") };
}

const rgba = ([r, g, b]: Rgb, a = 1) => `rgba(${r}, ${g}, ${b}, ${a})`;

// Bodoni Moda from Google Fonts, the same source next/font uses. A plain request is answered with TrueType, which the
// renderer needs. Without the font the card still renders, in the renderer's own face, rather than failing the build.
async function bodoni(weight: number, text: string): Promise<ArrayBuffer | null> {
  try {
    const url = `https://fonts.googleapis.com/css2?family=Bodoni+Moda:wght@${weight}&text=${encodeURIComponent(text)}`;
    const css = await (await fetch(url)).text();
    const src = css.match(/src: url\((.+?)\) format\('(opentype|truetype)'\)/)?.[1];
    if (!src) return null;
    const res = await fetch(src);
    return res.ok ? await res.arrayBuffer() : null;
  } catch {
    return null;
  }
}

export default async function OpenGraphImage() {
  const [t, photo, display, small] = await Promise.all([
    darkTokens(),
    readFile(join(process.cwd(), "public/images/hero-dark.jpg")),
    bodoni(600, `ADAG${LINE_1}${LINE_2_BEFORE}${LINE_2_GOLD},${LINE_3}`),
    bodoni(500, `${HALLMARK}${FACT}`),
  ]);
  const fonts = [
    ...(display ? [{ name: "Bodoni Moda", data: display, weight: 600 as const, style: "normal" as const }] : []),
    ...(small ? [{ name: "Bodoni Moda", data: small, weight: 500 as const, style: "normal" as const }] : []),
  ];
  const photoSrc = `data:image/jpeg;base64,${photo.toString("base64")}`;

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", position: "relative", backgroundColor: rgba(t.bg), fontFamily: "Bodoni Moda" }}>
        <img src={photoSrc} alt="" width={1200} height={630} style={{ position: "absolute", inset: 0, width: 1200, height: 630, objectFit: "cover" }} />
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            backgroundImage: `linear-gradient(90deg, ${rgba(t.bg, 0.96)} 0%, ${rgba(t.bg, 0.86)} 38%, ${rgba(t.bg, 0.35)} 66%, ${rgba(t.bg, 0)} 85%)`,
          }}
        />
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            backgroundImage: `linear-gradient(0deg, ${rgba(t.bg, 0.9)} 0%, ${rgba(t.bg, 0)} 38%)`,
          }}
        />
        <div style={{ position: "relative", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "64px 72px", width: "100%" }}>
          <div
            style={{
              display: "flex",
              alignSelf: "flex-start",
              padding: "10px 18px",
              border: `2px solid ${rgba(t.gold)}`,
              color: rgba(t.gold),
              fontSize: 22,
              fontWeight: 500,
              letterSpacing: 5,
            }}
          >
            {HALLMARK}
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", color: rgba(t.text), fontSize: 132, fontWeight: 600, letterSpacing: 10, lineHeight: 1 }}>ADAG</div>
            <div style={{ display: "flex", flexDirection: "column", marginTop: 24, color: rgba(t.text), fontSize: 54, fontWeight: 600, lineHeight: 1.1 }}>
              <div style={{ display: "flex" }}>{LINE_1}</div>
              <div style={{ display: "flex" }}>
                {LINE_2_BEFORE}
                <span style={{ color: rgba(t.gold), marginLeft: 13 }}>{LINE_2_GOLD}</span>,
              </div>
              <div style={{ display: "flex" }}>{LINE_3}</div>
            </div>
            <div style={{ display: "flex", marginTop: 28, color: rgba(t.muted), fontSize: 26, fontWeight: 500, letterSpacing: 1 }}>{FACT}</div>
          </div>
        </div>
      </div>
    ),
    { ...size, fonts },
  );
}
