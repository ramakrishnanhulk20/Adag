// C3: from whatever the payer pastes, the app takes exactly one thing, a bill number. Nothing else in a link is read.
const LINK = /\/bill\/(\d{1,78})(?:[/?#]|$)/;
const BARE = /^(?:#|no\.?\s*|bill\s*#?\s*)?(\d{1,78})$/i;

export function parseBillInput(input: string): bigint | null {
  const text = input.trim();
  if (!text) return null;
  const digits = BARE.exec(text)?.[1] ?? LINK.exec(text)?.[1];
  if (!digits) return null;
  const id = BigInt(digits);
  return id >= 1n ? id : null;
}

// Only the canonical form is accepted in the page address, so /bill/01 and /bill/1 never both exist.
export function parseBillParam(param: string): bigint | null {
  if (!/^[1-9]\d{0,77}$/.test(param)) return null;
  return BigInt(param);
}

export const MAX_BASKET = 10;

// A basket link carries only ids (C3). Pasting one back in is read the same way as typed numbers.
const BASKET_LINK = /\S*\/pay\/basket\?\S*?\bbills=((?:[0-9]+(?:,|%2C)?)+)\S*/gi;

// A basket link is attacker-writable text shown on a genuine Adag page, so only a sample of what was rejected is
// kept, short enough that it cannot carry a sentence: at most 3 entries of 24 characters, plus a count.
export const MAX_DROPPED_SHOWN = 3;
export const MAX_DROPPED_CHARS = 24;

// Numbers or bill links, separated by commas, spaces or new lines. Duplicates collapse to the first one. A sample of
// anything that is not a bill number comes back in `dropped`, and `droppedCount` counts them all. More than
// MAX_BASKET ids throws.
export function parseBillList(input: string): { ids: bigint[]; dropped: string[]; droppedCount: number } {
  const expanded = input.replace(BASKET_LINK, (_match, ids: string) => ` ${ids.replace(/%2C/gi, ",")} `);
  const ids: bigint[] = [];
  const dropped: string[] = [];
  let droppedCount = 0;
  for (const token of expanded.split(/[\s,]+/)) {
    if (!token) continue;
    const id = parseBillInput(token);
    if (id === null) {
      droppedCount++;
      if (dropped.length < MAX_DROPPED_SHOWN) dropped.push(token.length > MAX_DROPPED_CHARS ? `${token.slice(0, MAX_DROPPED_CHARS)}…` : token);
    } else if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > MAX_BASKET) {
    throw new Error(`That is ${ids.length} bills. One signature pays at most ${MAX_BASKET}; split them into two baskets.`);
  }
  return { ids, dropped, droppedCount };
}
