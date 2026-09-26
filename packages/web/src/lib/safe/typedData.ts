import { hashTypedData, type Address, type Hex } from "viem";
import { CHAIN_ID } from "../pay/constants";
import { ZERO_ADDRESS } from "./constants";
import type { SafeTxFields } from "./multisend";

// Safe 1.3.0 and later sign this EIP-712 structure; the domain names the chain and the Safe (C52), so a signature is
// good for one Safe on Arc only.
export const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export function safeTxTypedData(safe: Address, tx: SafeTxFields) {
  return {
    domain: { chainId: CHAIN_ID, verifyingContract: safe },
    types: SAFE_TX_TYPES,
    primaryType: "SafeTx" as const,
    message: {
      to: tx.to,
      value: tx.value,
      data: tx.data,
      operation: tx.operation,
      safeTxGas: tx.safeTxGas,
      baseGas: tx.baseGas,
      gasPrice: tx.gasPrice,
      gasToken: tx.gasToken,
      refundReceiver: tx.refundReceiver,
      nonce: tx.nonce,
    },
  };
}

export function safeTxHash(safe: Address, tx: SafeTxFields): Hex {
  return hashTypedData(safeTxTypedData(safe, tx));
}

// The only transaction shape Adag ever asks a Safe owner to sign (C51): every gas and refund field zero.
export function safeTxFor(batch: { to: Address; data: Hex }, nonce: bigint): SafeTxFields {
  return {
    to: batch.to,
    value: 0n,
    data: batch.data,
    operation: 1,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS,
    nonce,
  };
}

// The fields as strings, for the wire and the service. The server re-parses them, never trusting this shape.
export function safeTxToJson(tx: SafeTxFields) {
  return {
    to: tx.to,
    value: tx.value.toString(),
    data: tx.data,
    operation: tx.operation,
    safeTxGas: tx.safeTxGas.toString(),
    baseGas: tx.baseGas.toString(),
    gasPrice: tx.gasPrice.toString(),
    gasToken: tx.gasToken,
    refundReceiver: tx.refundReceiver,
    nonce: tx.nonce.toString(),
  };
}
