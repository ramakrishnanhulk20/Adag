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
