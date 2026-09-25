"use client";

import type { Address, Hex } from "viem";
import { arc } from "viem/chains";
import { useBytecode, useConnection } from "wagmi";

// "delegated" is an EIP-7702 wallet: code that is only a pointer. Arc's batching has not been tested with it.
export type WalletKind = "checking" | "plain" | "delegated" | "smart" | "unavailable";

export type WalletState =
  | { status: "disconnected" }
  | { status: "connecting" }
  | { status: "connected"; address: Address; chainId: number; onArc: boolean; kind: WalletKind };

const DELEGATION_PREFIX = "0xef0100";

export function classifyCode(code: string | undefined): Exclude<WalletKind, "checking" | "unavailable"> {
  if (!code || code === "0x") return "plain";
  // A 7702 delegation is exactly the 3-byte prefix plus a 20-byte address, 23 bytes in all.
  if (code.toLowerCase().startsWith(DELEGATION_PREFIX) && code.length === 2 + 46) return "delegated";
  return "smart";
}

export function useWallet(): WalletState {
  const connection = useConnection();
  const address = connection.address;
  // Read from Arc itself, not through the wallet, so a wallet on another chain still gets the right answer.
  const code = useBytecode({ address, chainId: arc.id, query: { enabled: Boolean(address), staleTime: 60_000 } });

  if (connection.status === "connecting" || connection.status === "reconnecting") {
    return address ? withKind(address, connection.chainId, code) : { status: "connecting" };
  }
  if (connection.status !== "connected" || !address) return { status: "disconnected" };
  return withKind(address, connection.chainId, code);
}

type CodeRead = { isError: boolean; isSuccess: boolean; data?: Hex | undefined };

function withKind(address: Address, chainId: number | undefined, code: CodeRead): WalletState {
  let kind: WalletKind = "checking";
  if (code.isError) kind = "unavailable";
  else if (code.isSuccess) kind = classifyCode(code.data);
  return { status: "connected", address, chainId: chainId ?? 0, onArc: chainId === arc.id, kind };
}

// C4: nothing may be built for signing unless this holds, and F5b calls it again right before each signature.
export function readyToSign(wallet: WalletState): wallet is Extract<WalletState, { status: "connected" }> {
  return wallet.status === "connected" && wallet.onArc && wallet.kind === "plain";
}
