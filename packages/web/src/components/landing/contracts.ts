import type { Address } from "viem";
import { ADAG_GUARD } from "@/lib/guard/constants";
import { ADAG_BILLS, ADAG_BILLS_FIRST, EXPLORER } from "@/lib/pay/constants";

export type ContractLink = { name: string; address: Address; explorer: string; sourcify: string };

const link = (name: string, address: Address): ContractLink => ({
  name,
  address,
  explorer: `${EXPLORER}/address/${address}`,
  sourcify: `https://repo.sourcify.dev/5042/${address}`,
});

// Every contract the site names, in the order a reader should meet them. The addresses come from their one home
// in lib/pay and lib/guard; nothing here restates them.
export const CONTRACTS: readonly ContractLink[] = [
  link("AdagBills", ADAG_BILLS),
  ...(ADAG_GUARD ? [link("AdagGuard", ADAG_GUARD)] : []),
  link("AdagBills, first deployment", ADAG_BILLS_FIRST),
];

export const CURRENT_BILLS = CONTRACTS[0]!;
