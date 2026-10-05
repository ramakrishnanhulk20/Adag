import { useId } from "react";

type MarkProps = { size: number; gold: string; title?: string };

// The site's hallmark frame, a square with its four corners cut at 45 degrees.
const FRAME = "M6.4 2.9h19.2l3.5 3.5v19.2l-3.5 3.5H6.4l-3.5-3.5V6.4z";

// Letter outlines cut from Noto Serif Tamil 700 and Bodoni Moda 700, already scaled and centred in the 32 box.
// The Tamil letter is fitted 20 wide: at the briefed 17 high it was 26.8 wide and cut through the frame edges.
const SEAL_LETTER = "M26 22.34L23.45 22.34L23.45 17.05L7.66 17.05Q7.34 17.05 7.21 17.17Q7.08 17.29 7.08 17.51L7.08 17.51Q7.08 17.97 7.47 18.44Q7.86 18.9 8.6 19.28Q9.34 19.66 10.38 19.89Q11.41 20.12 12.7 20.12L12.7 20.12Q13.64 20.12 14.56 19.93Q15.47 19.73 16.28 19.3Q17.08 18.88 17.7 18.22Q18.32 17.56 18.68 16.62Q19.03 15.68 19.03 14.46L19.03 14.46Q19.03 13.4 18.71 12.68Q18.4 11.96 17.89 11.51Q17.39 11.06 16.78 10.86Q16.18 10.65 15.57 10.65L15.57 10.65Q14.69 10.65 14.11 10.93Q13.52 11.21 13.23 11.64Q12.94 12.07 12.94 12.53L12.94 12.53Q12.94 13.21 13.33 13.53Q13.72 13.85 14.17 13.85L14.17 13.85Q14.77 13.85 15.11 13.48Q15.44 13.1 15.44 12.56L15.44 12.56Q15.44 12.02 15.16 11.61Q14.87 11.19 14.45 10.92Q14.03 10.65 13.58 10.55L13.58 10.55L14.52 10.47Q15.39 10.47 16.02 10.84Q16.64 11.21 16.97 11.76Q17.31 12.32 17.31 12.91L17.31 12.91Q17.31 13.48 17.01 14.02Q16.72 14.55 16.1 14.89Q15.49 15.22 14.54 15.22L14.54 15.22Q13.69 15.22 13.07 14.89Q12.45 14.55 12.11 13.98Q11.78 13.4 11.78 12.7L11.78 12.7Q11.78 11.86 12.25 11.17Q12.72 10.47 13.63 10.07Q14.54 9.66 15.84 9.66L15.84 9.66Q17.15 9.66 18.21 10.07Q19.26 10.47 20.02 11.21Q20.78 11.94 21.18 12.89Q21.59 13.85 21.59 14.95L21.59 14.95Q21.59 16.06 21.22 17.02Q20.86 17.97 20.14 18.73Q19.42 19.49 18.38 20.02Q17.34 20.55 15.99 20.83Q14.65 21.11 13.01 21.11L13.01 21.11Q11.37 21.11 10.07 20.79Q8.77 20.46 7.86 19.93Q6.96 19.39 6.48 18.75Q6 18.1 6 17.46L6 17.46Q6 16.86 6.39 16.47Q6.78 16.08 7.58 16.08L7.58 16.08L23.45 16.08L23.45 9.74L26 9.74L26 22.34";
const BITCOIN_B = "M16.52 20.8L11.9 20.8L11.9 20.55L16.13 20.55Q16.65 20.55 17.06 20.26Q17.46 19.97 17.69 19.42Q17.92 18.87 17.92 18.11L17.92 18.11Q17.92 17.35 17.69 16.89Q17.46 16.42 17.06 16.21Q16.65 16 16.13 16L16.13 16L14.72 16L14.72 15.83L16.52 15.83Q17.52 15.83 18.33 16.06Q19.14 16.29 19.62 16.82Q20.1 17.34 20.1 18.24L20.1 18.24Q20.1 19.64 19.16 20.22Q18.21 20.8 16.52 20.8L16.52 20.8M15.05 20.68L13.06 20.68L13.06 11.32L15.05 11.32L15.05 20.68M16.27 15.91L14.72 15.91L14.72 15.74L16 15.74Q16.46 15.74 16.84 15.55Q17.22 15.36 17.45 14.91Q17.67 14.46 17.67 13.7L17.67 13.7Q17.67 12.94 17.45 12.44Q17.22 11.94 16.84 11.7Q16.46 11.45 16 11.45L16 11.45L11.9 11.45L11.9 11.2L16.27 11.2Q17.86 11.2 18.79 11.76Q19.72 12.32 19.72 13.57L19.72 13.57Q19.72 14.76 18.84 15.34Q17.96 15.91 16.27 15.91L16.27 15.91";
const COIN_A = "M18.11 19.24L12.28 19.24L12.28 18.87L18.11 18.87L18.11 19.24M15.57 9.15L16.8 9.15L21.7 23.28L23.16 23.28L23.16 23.65L16.63 23.65L16.63 23.28L18.29 23.28L14.79 12.48L11.01 23.28L13.02 23.28L13.02 23.65L8.84 23.65L8.84 23.28L10.58 23.28L15.57 9.15";

// Two bars through the B, 1.25 wide, reaching 1.7 above and below it.
const BITCOIN_BARS = [
  { x: 13.9, y: 9.5, w: 1.25, h: 13 },
  { x: 16.36, y: 9.5, w: 1.25, h: 13 },
];

// The tab cut for 16 to 32 pixels: a heavier frame, a larger coin, and a B from Bodoni Moda at its smallest optical
// size and heaviest weight (opsz 6, wght 900), so the hairlines and the counters survive a 16 pixel tab.
// The B is 12 high and the bars are 1.5 wide, reaching 1.4 above and below it.
const TAB_FRAME_STROKE = 2.6;
const TAB_COIN_R = 9.5;
const BITCOIN_B_TAB = "M16.89 22L10.31 22L10.31 21.42L16.09 21.42Q16.7 21.42 17.12 21.12Q17.55 20.82 17.78 20.21Q18.01 19.59 18.01 18.64L18.01 18.64Q18.01 17.69 17.78 17.14Q17.55 16.6 17.12 16.37Q16.7 16.14 16.09 16.14L16.09 16.14L14.49 16.14L14.49 15.76L16.89 15.76Q18.26 15.76 19.34 16.06Q20.42 16.36 21.06 17.06Q21.69 17.76 21.69 18.96L21.69 18.96Q21.69 20.64 20.44 21.32Q19.18 22 16.89 22L16.89 22M15.21 21.68L11.77 21.68L11.77 10.32L15.21 10.32L15.21 21.68M16.58 15.92L14.49 15.92L14.49 15.54L15.93 15.54Q16.46 15.54 16.85 15.33Q17.25 15.13 17.47 14.61Q17.69 14.09 17.69 13.14L17.69 13.14Q17.69 12.18 17.47 11.62Q17.25 11.06 16.85 10.82Q16.46 10.58 15.93 10.58L15.93 10.58L10.31 10.58L10.31 10L16.58 10Q18.74 10 19.98 10.7Q21.22 11.4 21.22 12.96L21.22 12.96Q21.22 14.4 20.05 15.16Q18.88 15.92 16.58 15.92L16.58 15.92";
const BITCOIN_BARS_TAB = [
  { x: 13.2, y: 8.6, w: 1.5, h: 14.8 },
  { x: 16.62, y: 8.6, w: 1.5, h: 14.8 },
];

const BAR_FIELDS = (bar: { x: number; y: number; w: number; h: number }) =>
  `x="${bar.x}" y="${bar.y}" width="${bar.w}" height="${bar.h}"`;

// The mask is white where the metal shows and black where the letter is cut out, so any background shows through.
function MaskedMetal({ id, gold, children }: { id: string; gold: string; children: React.ReactNode }) {
  return (
    <>
      <defs>
        <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32">
          {children}
        </mask>
      </defs>
      <rect width="32" height="32" fill={gold} mask={`url(#${id})`} />
    </>
  );
}

function Frame({ size, title, children }: { size: number; title?: string; children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      style={{ display: "block", flexShrink: 0 }}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

// useId can return colons or other characters that do not belong in a url(#...) reference.
function useMaskId(): string {
  return `mask${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
}

export function MarkToday({ size, gold, title }: MarkProps) {
  return (
    <Frame size={size} title={title}>
      <path d={FRAME} fill="none" stroke={gold} strokeWidth={1.75} strokeLinejoin="miter" />
      <circle cx={16} cy={16} r={7.25} fill={gold} />
    </Frame>
  );
}

export function MarkSeal({ size, gold, title }: MarkProps) {
  const id = useMaskId();
  return (
    <Frame size={size} title={title}>
      <MaskedMetal id={id} gold={gold}>
        <path d={FRAME} fill="#fff" />
        <path d={SEAL_LETTER} fill="#000" />
      </MaskedMetal>
    </Frame>
  );
}

export function MarkHallmarkBtc({ size, gold, title }: MarkProps) {
  const id = useMaskId();
  return (
    <Frame size={size} title={title}>
      <path d={FRAME} fill="none" stroke={gold} strokeWidth={2.4} strokeLinejoin="miter" />
      <MaskedMetal id={id} gold={gold}>
        <circle cx={16} cy={16} r={8.5} fill="#fff" />
        <path d={BITCOIN_B} fill="#000" />
        {BITCOIN_BARS.map((bar) => (
          <rect key={bar.x} x={bar.x} y={bar.y} width={bar.w} height={bar.h} fill="#000" />
        ))}
      </MaskedMetal>
    </Frame>
  );
}

export function MarkHallmarkBtcTab({ size, gold, title }: MarkProps) {
  const id = useMaskId();
  return (
    <Frame size={size} title={title}>
      <path d={FRAME} fill="none" stroke={gold} strokeWidth={TAB_FRAME_STROKE} strokeLinejoin="miter" />
      <MaskedMetal id={id} gold={gold}>
        <circle cx={16} cy={16} r={TAB_COIN_R} fill="#fff" />
        <path d={BITCOIN_B_TAB} fill="#000" />
        {BITCOIN_BARS_TAB.map((bar) => (
          <rect key={bar.x} x={bar.x} y={bar.y} width={bar.w} height={bar.h} fill="#000" />
        ))}
      </MaskedMetal>
    </Frame>
  );
}

export function MarkStampedCoin({ size, gold, title }: MarkProps) {
  const id = useMaskId();
  return (
    <Frame size={size} title={title}>
      <MaskedMetal id={id} gold={gold}>
        <circle cx={16} cy={16} r={14.5} fill="#fff" />
        <circle cx={16} cy={16} r={12.6} fill="none" stroke="#000" strokeWidth={0.9} />
        <path d={COIN_A} fill="#000" />
      </MaskedMetal>
    </Frame>
  );
}

function standalone(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${inner}</svg>`;
}

function standaloneMask(id: string, gold: string, cutouts: string): string {
  return (
    `<defs><mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32">${cutouts}</mask></defs>` +
    `<rect width="32" height="32" fill="${gold}" mask="url(#${id})"/>`
  );
}

// The same marks as plain SVG text, for the favicon and the README once one is chosen. The mask ids are fixed
// because each string is its own file and never shares a page with another copy.
export const MARK_SVG: Record<"seal" | "hallmarkBtc" | "hallmarkBtcTab" | "stampedCoin", (gold: string) => string> = {
  seal: (gold) =>
    standalone(standaloneMask("adag-seal", gold, `<path d="${FRAME}" fill="#fff"/><path d="${SEAL_LETTER}" fill="#000"/>`)),
  hallmarkBtc: (gold) =>
    standalone(
      `<path d="${FRAME}" fill="none" stroke="${gold}" stroke-width="2.4" stroke-linejoin="miter"/>` +
        standaloneMask(
          "adag-hallmark",
          gold,
          `<circle cx="16" cy="16" r="8.5" fill="#fff"/><path d="${BITCOIN_B}" fill="#000"/>` +
            BITCOIN_BARS.map((bar) => `<rect ${BAR_FIELDS(bar)} fill="#000"/>`).join(""),
        ),
    ),
  hallmarkBtcTab: (gold) =>
    standalone(
      `<path d="${FRAME}" fill="none" stroke="${gold}" stroke-width="${TAB_FRAME_STROKE}" stroke-linejoin="miter"/>` +
        standaloneMask(
          "adag-hallmark-tab",
          gold,
          `<circle cx="16" cy="16" r="${TAB_COIN_R}" fill="#fff"/><path d="${BITCOIN_B_TAB}" fill="#000"/>` +
            BITCOIN_BARS_TAB.map((bar) => `<rect ${BAR_FIELDS(bar)} fill="#000"/>`).join(""),
        ),
    ),
  stampedCoin: (gold) =>
    standalone(
      standaloneMask(
        "adag-stamped-coin",
        gold,
        `<circle cx="16" cy="16" r="14.5" fill="#fff"/>` +
          `<circle cx="16" cy="16" r="12.6" fill="none" stroke="#000" stroke-width="0.9"/>` +
          `<path d="${COIN_A}" fill="#000"/>`,
      ),
    ),
};
