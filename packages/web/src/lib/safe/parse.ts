import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import type { SafeTxFields } from "./multisend";

// The one parser every Safe route uses. Anything that does not match exactly is refused with a plain reason; nothing
// is coerced, trimmed into shape or passed through unread.
export class InputError extends Error {}

export const MAX_BODY_BYTES = 64 * 1024;
const MAX_DATA_BYTES = 32 * 1024;

export function address(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) throw new InputError(`${label} is not an address.`);
  return getAddress(value);
}

export function hash32(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new InputError(`${label} is not a 32-byte hash.`);
  return value.toLowerCase() as Hex;
}

function uint(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,77})$/.test(value)) throw new InputError(`${label} is not a whole number.`);
  return BigInt(value);
}

function data(value: unknown): Hex {
  if (typeof value !== "string" || !isHex(value, { strict: true }) || (value.length - 2) % 2 !== 0) throw new InputError("The transaction data is not hex.");
  if ((value.length - 2) / 2 > MAX_DATA_BYTES) throw new InputError("The transaction data is too large.");
  return value as Hex;
}

export function safeTxFields(value: unknown): SafeTxFields {
  if (!value || typeof value !== "object") throw new InputError("The Safe transaction is missing.");
  const v = value as Record<string, unknown>;
  if (v.operation !== 0 && v.operation !== 1) throw new InputError("The operation is not 0 or 1.");
  return {
    to: address(v.to, "The transaction target"),
    value: uint(v.value, "The value"),
    data: data(v.data),
    operation: v.operation,
    safeTxGas: uint(v.safeTxGas, "safeTxGas"),
    baseGas: uint(v.baseGas, "baseGas"),
    gasPrice: uint(v.gasPrice, "gasPrice"),
    gasToken: address(v.gasToken, "The gas token"),
    refundReceiver: address(v.refundReceiver, "The refund receiver"),
    nonce: uint(v.nonce, "The nonce"),
  };
}

export function signature65(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(value)) throw new InputError("The signature is not 65 bytes.");
  return value as Hex;
}

export type ProposeBody = { safe: Address; owner: Address; safeTxHash: Hex; signature: Hex; tx: SafeTxFields };

export function proposeBody(json: unknown): ProposeBody {
  if (!json || typeof json !== "object") throw new InputError("The request body is not an object.");
  const b = json as Record<string, unknown>;
  return {
    safe: address(b.safe, "The Safe"),
    owner: address(b.owner, "The owner"),
    safeTxHash: hash32(b.safeTxHash, "The Safe transaction hash"),
    signature: signature65(b.signature),
    tx: safeTxFields(b.tx),
  };
}

// Reads a request body without ever holding more than the cap in memory.
export async function readCappedJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new InputError("The request is too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new InputError("The request has no body.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new InputError("The request is too large.");
    }
    chunks.push(value);
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  try {
    return JSON.parse(text);
  } catch {
    throw new InputError("The request body is not JSON.");
  }
}
