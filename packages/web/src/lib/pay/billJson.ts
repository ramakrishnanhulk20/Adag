import { getAddress, type Hex } from "viem";
import type { Bill } from "./build";
import { requireDeployment } from "./constants";

// What crosses from the server render to the browser: every integer as a decimal string, never a float (C15).
export type BillJson = {
  contract: string;
  id: string;
  payee: string;
  status: number;
  due: string;
  currency: string;
  createdAt: string;
  amount: string;
  payer: string;
  paidAt: string;
  ref: Hex;
};

export function billToJson(b: Bill): BillJson {
  return {
    contract: b.contract,
    id: b.id.toString(),
    payee: b.payee,
    status: b.status,
    due: b.due.toString(),
    currency: b.currency,
    createdAt: b.createdAt.toString(),
    amount: b.amount.toString(),
    payer: b.payer,
    paidAt: b.paidAt.toString(),
    ref: b.ref,
  };
}

export function billFromJson(j: BillJson): Bill {
  return {
    contract: requireDeployment(j.contract).address,
    id: BigInt(j.id),
    payee: getAddress(j.payee),
    status: j.status,
    due: BigInt(j.due),
    currency: getAddress(j.currency),
    createdAt: BigInt(j.createdAt),
    amount: BigInt(j.amount),
    payer: getAddress(j.payer),
    paidAt: BigInt(j.paidAt),
    ref: j.ref,
  };
}
