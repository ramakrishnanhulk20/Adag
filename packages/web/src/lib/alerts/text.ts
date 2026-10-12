// Plain TypeScript with relative imports only, so the unit tests can load it under bare Node.
// Every alert is fixed words, numbers computed here and the site's own origin (C48). Nothing written by anyone else,
// no bill reference, no name from Telegram, ever lands in one, and they are sent with no parse mode. The words come
// in the language the wallet's owner was reading Adag in when they linked (I4); anything else means English.
import { MARKET_CURRENCY, type GuardMarket } from "../guard/constants";
import type { Address } from "viem";
import { localeOf, type Locale } from "../../i18n/locales";
import { normaliseAddress, normaliseMarket } from "../store/keys";
import { percentOfWad } from "./message";
import { ALERT_WORDS } from "./textCatalog";

export class TextError extends Error {}

function wad(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 0n || value > 10n ** 30n) throw new TextError("Not a loan-to-value.");
  return value;
}

function amount(value: unknown, decimals: number): string {
  if (typeof value !== "bigint" || value < 0n) throw new TextError("Not an amount.");
  const unit = 10n ** BigInt(decimals);
  const cents = (value * 100n + unit / 2n) / unit;
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${whole}.${(cents % 100n).toString().padStart(2, "0")}`;
}

function origin(site: string): string {
  const url = new URL(site);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") throw new TextError("The site must be https.");
  return url.origin;
}

function currency(market: unknown): { symbol: "USDC" | "EURC"; decimals: number } {
  const found = MARKET_CURRENCY[normaliseMarket(market) as GuardMarket];
  if (!found) throw new TextError("Not one of Adag's markets.");
  return found;
}

// I1 and I4 at the store boundary: a language read back from a record is only used when it is one of the five.
const words = (lang: unknown) => ALERT_WORDS[localeOf(lang)];

export function levelCrossedText(input: { market: unknown; ltvWad: unknown; levelWad: unknown }, site: string, lang: Locale | string | null = "en"): string {
  const { symbol } = currency(input.market);
  return words(lang).levelCrossed(symbol, percentOfWad(wad(input.ltvWad)), percentOfWad(wad(input.levelWad)), `${origin(site)}/app`);
}

export function protectedText(input: { market: unknown; repaid: unknown; ltvBeforeWad: unknown; ltvAfterWad: unknown }, site: string, lang: Locale | string | null = "en"): string {
  const { symbol, decimals } = currency(input.market);
  return words(lang).protected(amount(input.repaid, decimals), symbol, percentOfWad(wad(input.ltvBeforeWad)), percentOfWad(wad(input.ltvAfterWad)), `${origin(site)}/app`);
}

// Wallets are named in full and checksummed, never shortened: a shortened address is what a lookalike imitates.
const full = (wallet: Address) => normaliseAddress(wallet);

export const linkedText = (site: string, wallet: Address, lang: Locale | string | null = "en") => words(lang).linked(full(wallet), `${origin(site)}/app`);
export const refusedText = (wallet: Address, lang: Locale | string | null = "en") => words(lang).refused(full(wallet));
export const movedText = (wallet: Address, lang: Locale | string | null = "en") => words(lang).moved(full(wallet));
export const stoppedText = (lang: Locale | string | null = "en") => words(lang).stopped();
export const pendingText = (lang: Locale | string | null = "en") => words(lang).pending();
export const expiredText = (lang: Locale | string | null = "en") => words(lang).expired();
export const helloText = (lang: Locale | string | null = "en") => words(lang).hello();
