import { decodeErrorResult, isHex, type Hex } from "viem";
import { adagAbi, erc20Abi, memoAbi } from "./abi";
import { BILL_STATUS } from "./constants";
import { currencyOf } from "./market";

export type PlainError = {
  // The contract's own name for the error, for logs and tests. Never shown on its own.
  name: string;
  message: string;
  next: string;
  // message and next together: the sentence the app shows.
  text: string;
};

const errorAbi = [...adagAbi, ...memoAbi, ...erc20Abi];

const plain = (name: string, message: string, next: string): PlainError => ({ name, message, next, text: `${message} ${next}`.trim() });

// Morpho and the tokens revert with plain strings. Matched loosely, because issuers word the same refusal differently.
const STRING_REASONS: { match: RegExp; name: string; message: string; next: string }[] = [
  { match: /insufficient collateral/i, name: "insufficient collateral", message: "Morpho refused the loan because it would pass Morpho's own 86% line.", next: "Pledge more cirBTC or pay less from bitcoin." },
  { match: /insufficient liquidity/i, name: "insufficient liquidity", message: "Morpho's market does not have enough cash to lend this amount right now.", next: "Pay from your balance, or try again later." },
  { match: /zero assets/i, name: "zero assets", message: "Morpho refused an amount of zero.", next: "Reload the page and build the payment again." },
  { match: /unauthorized/i, name: "unauthorized", message: "Morpho refused to act for this wallet.", next: "Use an ordinary wallet such as MetaMask or Rabby, sending its own transaction." },
  { match: /blacklist|blocked address|blocklist/i, name: "blocked", message: "The token's issuer has blocked one of the wallets in this payment.", next: "Nothing moved. The blocked wallet has to contact the issuer." },
  { match: /paused/i, name: "paused", message: "The token is paused by its issuer.", next: "Nothing moved. Try again later." },
  { match: /exceeds balance|insufficient balance/i, name: "insufficient balance", message: "Your wallet does not hold enough of this token.", next: "Add funds, or pay from bitcoin instead." },
  { match: /insufficient allowance|exceeds allowance/i, name: "insufficient allowance", message: "The approval in this payment was smaller than the amount.", next: "Reload the page and build the payment again." },
  { match: /transfer(from)? (reverted|returned false)/i, name: "token transfer failed", message: "A token transfer inside Morpho failed: your wallet held or approved less than Morpho needed to move.", next: "Nothing moved. Reload so the amounts are read fresh, then try again." },
  { match: /call failed/i, name: "batch step failed", message: "One step of the payment failed, so nothing happened.", next: "Reload the page and try again." },
];

const UNKNOWN = plain("unknown", "The payment was refused for a reason Adag could not read.", "Nothing moved. Check the transaction on the Arc explorer, or try again.");

function fromName(name: string, args: readonly unknown[]): PlainError {
  switch (name) {
    case "LtvAboveLimit":
      return plain(name, "This would take your loan past 40% of your bitcoin's value.", "Pledge more cirBTC or pay less from bitcoin.");
    case "BillNotOpen": {
      const status = Number(args[1]);
      if (status === BILL_STATUS.Paid) return plain(name, "This bill is already paid.", "Nothing was charged. The bill page shows who paid it.");
      if (status === BILL_STATUS.Void) return plain(name, "The supplier cancelled this bill.", "Ask them for a new one if you still owe it.");
      return plain(name, "There is no bill with this number.", "Check the number with the supplier.");
    }
    case "StalePrice":
      return plain(name, "New loans are paused until the bitcoin price updates.", "Paying from your balance still works.");
    case "ZeroPrice":
      return plain(name, "The bitcoin price reads zero, so new loans are off.", "Paying from your balance still works.");
    case "BadFeed":
      return plain(name, "The bitcoin price oracle names no price feed, so new loans are off.", "Paying from your balance still works.");
    case "BadMarket":
      return plain(name, "Morpho reports this market differently from what Adag expects, so paying from bitcoin is off.", "Paying from your balance still works.");
    case "UnknownBill":
      return plain(name, `There is no bill #${String(args[0])} on Arc.`, "Check the number with the supplier.");
    case "SelfPayment":
      return plain(name, "You cannot pay a bill you wrote yourself.", "Pay it from a different wallet.");
    case "NotPayee":
      return plain(name, "Only the supplier who wrote this bill can cancel it.", "Connect the wallet that wrote it.");
    case "PayeeNotCredited":
      return plain(name, "The supplier's balance did not rise by the bill amount, so Adag undid the payment.", "Nothing moved. The token may be blocking this supplier; ask them to check.");
    case "ZeroAmount":
      return plain(name, "This bill's amount is zero, so it cannot be paid.", "Ask the supplier for a corrected bill.");
    case "ReferenceTooLong":
      return plain(name, `The reference is ${String(args[0])} bytes, over the 140-byte limit.`, "Shorten it. Some characters take more than one byte.");
    case "UnsupportedCurrency":
      return plain(name, "Adag bills are in USDC or EURC only.", "Choose one of those.");
    case "PageTooLarge":
      return plain(name, "The app asked Arc for too many bills at once.", "Reload the page.");
    case "ReentrancyGuardReentrantCall":
      return plain(name, "The payment tried to call back into Adag, so it was refused.", "Nothing moved. Reload the page and try again.");
    case "SafeERC20FailedOperation": {
      const symbol = currencyOf(String(args[0]))?.symbol ?? "token";
      return plain(name, `The ${symbol} contract refused the transfer.`, `Nothing moved. Check that your wallet holds enough ${symbol} and is not blocked by its issuer.`);
    }
    case "ERC20InsufficientBalance":
      return plain(name, "Your wallet does not hold enough of this token.", "Add funds, or pay from bitcoin instead.");
    case "ERC20InsufficientAllowance":
      return plain(name, "The approval in this payment was smaller than the amount.", "Reload the page and build the payment again.");
    case "ERC20InvalidReceiver":
    case "ERC20InvalidSender":
      return plain(name, "The token refused one of the addresses in this payment.", "Nothing moved. Reload the page and try again.");
    default:
      return { ...UNKNOWN, name };
  }
}

function fromString(reason: string): PlainError {
  for (const r of STRING_REASONS) if (r.match.test(reason)) return plain(r.name, r.message, r.next);
  return { ...UNKNOWN, name: reason.slice(0, 80) };
}

// Viem wraps revert data a few levels deep, and wallets differ in where they put it.
function revertBytes(input: unknown, depth = 0): Hex | null {
  if (depth > 6 || input == null) return null;
  if (typeof input === "string") return isHex(input) && input.length >= 10 ? input : null;
  if (typeof input !== "object") return null;
  const o = input as { data?: unknown; cause?: unknown; error?: unknown };
  return revertBytes(o.data, depth + 1) ?? revertBytes(o.error, depth + 1) ?? revertBytes(o.cause, depth + 1);
}

// Through a batch, Adag's error arrives wrapped in Memo's MemoFailed(bytes); this unwraps it before choosing words.
export function decodeAdagError(revert: unknown): PlainError {
  let data = revertBytes(revert);
  for (let depth = 0; data && depth < 4; depth++) {
    let decoded: { errorName: string; args?: readonly unknown[] };
    try {
      decoded = decodeErrorResult({ abi: errorAbi, data }) as { errorName: string; args?: readonly unknown[] };
    } catch {
      return UNKNOWN;
    }
    const args = decoded.args ?? [];
    if (decoded.errorName === "MemoFailed") {
      data = revertBytes(args[0]);
      if (!data) return plain("MemoFailed", "The payment step failed without giving a reason.", "Nothing moved. Reload the page and try again.");
      continue;
    }
    if (decoded.errorName === "Error") return fromString(String(args[0] ?? ""));
    if (decoded.errorName === "Panic") return plain("Panic", "The payment hit an arithmetic error and was refused.", "Nothing moved. Reload the page and try again.");
    return fromName(decoded.errorName, args);
  }
  if (typeof revert === "string") return isHex(revert) ? UNKNOWN : fromString(revert);
  const text = (revert as { shortMessage?: string; message?: string } | null)?.shortMessage ?? (revert as { message?: string } | null)?.message;
  return typeof text === "string" ? fromString(text) : UNKNOWN;
}
