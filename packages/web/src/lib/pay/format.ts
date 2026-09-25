import { formatUnits, getAddress, hexToBytes, isHex, type Hex } from "viem";
import { MAX_UINT256, WAD } from "./constants";

export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

// C15: always the library checksum, in full.
export const fullAddress = (address: string) => getAddress(address);

const group = (whole: string) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// C15: integers in base units go in, text comes out. No float ever touches an amount.
export function formatUnitsExact(baseUnits: bigint, decimals: number, minFraction = 2): string {
  const negative = baseUnits < 0n;
  const [whole = "0", frac = ""] = formatUnits(negative ? -baseUnits : baseUnits, decimals).split(".");
  const trimmed = frac.replace(/0+$/, "");
  const shown = trimmed.length >= minFraction ? trimmed : trimmed.padEnd(Math.min(minFraction, decimals), "0");
  return `${negative ? "-" : ""}${group(whole)}${shown ? `.${shown}` : ""}`;
}

// Bidirectional overrides and isolates can make "INV-1001" read as "1001-VNI", so they never reach the screen (C14).
const BIDI = /[؜‎‏‪-‮⁦-⁩]/g;
// Other invisible controls, except tab and newline, show as the replacement mark rather than silently vanishing.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

// C14: bytes in, plain text out. Invalid UTF-8 becomes U+FFFD; nothing here is ever HTML, markdown or a link.
export function referenceText(ref: Hex): string {
  if (!isHex(ref, { strict: true }) || ref === "0x") return "";
  const text = new TextDecoder("utf-8", { fatal: false }).decode(hexToBytes(ref));
  return text.replace(BIDI, "").replace(CONTROL, "�");
}

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

export const formatDate = (seconds: bigint) => DATE.format(new Date(Number(seconds) * 1000));
export const formatDateTime = (seconds: bigint) => DATE_TIME.format(new Date(Number(seconds) * 1000));

// Loan-to-value arrives WAD scaled, so 0.4e18 is 40%. Two decimals, cut rather than rounded.
export function formatPercentWad(wad: bigint): string {
  if (wad === MAX_UINT256) return "no collateral";
  const basisPoints = (wad * 10_000n) / WAD;
  const whole = basisPoints / 100n;
  const frac = (basisPoints % 100n).toString().padStart(2, "0");
  return `${whole}.${frac}%`;
}
