import { useId } from "react";

// Face-on at rest. The timeline flattens it to the photographed coin's proportions as it lands.
export function Coin({ className = "" }: { className?: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const face = `pl-face-${id}`;
  const rim = `pl-rim-${id}`;
  const sheen = `pl-sheen-${id}`;

  return (
    <svg viewBox="0 0 200 200" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={face} x1="0.18" y1="0.08" x2="0.82" y2="0.96">
          <stop offset="0" className="pl-stop-hi" />
          <stop offset="0.48" className="pl-stop-mid" />
          <stop offset="1" className="pl-stop-lo" />
        </linearGradient>
        <linearGradient id={rim} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" className="pl-stop-mid" />
          <stop offset="0.55" className="pl-stop-rim" />
          <stop offset="1" className="pl-stop-rim" />
        </linearGradient>
        <radialGradient id={sheen} cx="0.34" cy="0.28" r="0.62">
          <stop offset="0" className="pl-stop-hi" stopOpacity="0.95" />
          <stop offset="0.55" className="pl-stop-hi" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="100" cy="100" r="99" fill={`url(#${rim})`} />
      <circle cx="100" cy="100" r="95.5" fill="none" className="pl-coin-reed" strokeWidth="3" strokeDasharray="1.4 2.6" />
      <circle cx="100" cy="100" r="92" fill={`url(#${face})`} />
      <circle cx="100" cy="100" r="92" fill={`url(#${sheen})`} />
      <circle cx="100" cy="100" r="81" fill="none" className="pl-coin-ring" strokeWidth="1.5" />
      <g className="pl-coin-mark-hi" transform="translate(1.2 1.2)">
        <BitcoinMark />
      </g>
      <g className="pl-coin-mark">
        <BitcoinMark />
      </g>
    </svg>
  );
}

function BitcoinMark() {
  return (
    <>
      <text x="103" y="134" textAnchor="middle" className="pl-coin-glyph">
        B
      </text>
      <rect x="83" y="48" width="5.5" height="17" rx="1" />
      <rect x="98" y="48" width="5.5" height="17" rx="1" />
      <rect x="83" y="133" width="5.5" height="17" rx="1" />
      <rect x="98" y="133" width="5.5" height="17" rx="1" />
    </>
  );
}
