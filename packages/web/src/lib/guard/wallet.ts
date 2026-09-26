import { createWalletClient, http, isAddressEqual, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arc } from "../arc/client";
import { RPC_PRIMARY, RPC_TIMEOUT_MS } from "../arc/constants";
import { assertProtectCall } from "./call";
import type { Sender } from "./keeper";

export type KeeperSetup = { sender: Sender } | { error: string };

// Server only (C56). The key never leaves this module: callers get a sender whose one method takes a ProtectCall,
// which is checked again from its bytes before anything is signed (C39).
export function keeperFromEnv(): KeeperSetup {
  const key = process.env.KEEPER_PRIVATE_KEY;
  if (!key) return { error: "The keeper wallet is not configured on this server yet." };
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) return { error: "The keeper wallet's key is not in the expected form." };
  const account = privateKeyToAccount(key as `0x${string}`);
  const expected = process.env.KEEPER_ADDRESS;
  if (expected && !(/^0x[0-9a-fA-F]{40}$/.test(expected) && isAddressEqual(expected as Address, account.address))) {
    return { error: "KEEPER_ADDRESS does not match the keeper wallet's key." };
  }
  const wallet = createWalletClient({ account, chain: arc, transport: http(RPC_PRIMARY, { timeout: RPC_TIMEOUT_MS * 2, retryCount: 0 }) });
  return {
    sender: {
      address: account.address,
      async send(call, fees) {
        assertProtectCall(call);
        return wallet.sendTransaction({
          to: call.to,
          data: call.data,
          value: 0n,
          gas: fees.gas,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          chain: arc,
        });
      },
    },
  };
}
