// Plain TypeScript with relative imports only, so the unit tests can load it under bare Node.
// Every alert is fixed words, numbers computed here and the site's own origin (C48). Nothing written by anyone else,
// no bill reference, no name from Telegram, ever lands in one, and they are sent with no parse mode.
import { MARKET_CURRENCY, type GuardMarket } from "../guard/constants";
import { normaliseMarket } from "../store/keys";
import { percentOfWad } from "./message";

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

export function levelCrossedText(input: { market: unknown; ltvWad: unknown; levelWad: unknown }, site: string): string {
  const { symbol } = currency(input.market);
  return [
    `Adag: your ${symbol} loan is at ${percentOfWad(wad(input.ltvWad))} of your bitcoin's value, past your ${percentOfWad(wad(input.levelWad))} alert.`,
    `Add cirBTC or repay to bring it down: ${origin(site)}/app`,
  ].join("\n");
}

export function protectedText(input: { market: unknown; repaid: unknown; ltvBeforeWad: unknown; ltvAfterWad: unknown }, site: string): string {
  const { symbol, decimals } = currency(input.market);
  return [
    `Adag's loan guard repaid ${amount(input.repaid, decimals)} ${symbol} of your loan from your wallet.`,
    `It went from ${percentOfWad(wad(input.ltvBeforeWad))} to ${percentOfWad(wad(input.ltvAfterWad))} of your bitcoin's value.`,
    `Details: ${origin(site)}/app`,
  ].join("\n");
}

export const linkedText = (site: string) => `Adag alerts are on for your wallet. Send /stop here at any time to turn them off. ${origin(site)}/app`;
export const stoppedText = () => "Adag alerts are off for this chat.";
export const pendingText = () => "Almost done. Go back to Adag and sign the message in your wallet to finish linking.";
export const expiredText = () => "That link has expired or was already used. Start again from Adag.";
export const helloText = () => "Open the link on Adag's alerts page to connect a wallet.";
