"use client";

import { useCallback, useState } from "react";
import { motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import type { Address } from "viem";
import { arc } from "viem/chains";
import { useReadContracts } from "wagmi";
import { Button } from "@/components/Button";
import { Hallmark } from "@/components/Hallmark";
import { erc20Abi, morphoAbi } from "@/lib/pay/abi";
import { CIRBTC, CIRBTC_DECIMALS, CURRENCIES, EURC, MORPHO, USDC } from "@/lib/pay/constants";
import { formatUnitsExact } from "@/lib/pay/format";
import { readyToSign, useWallet, type WalletState } from "@/lib/wallet/useWallet";
import { BillsPaid, BillsWritten } from "./BillLists";
import { Value, rise, type Cell } from "./cells";
import { ConnectButton } from "./ConnectButton";
import { LoanTicket } from "./LoanTicket";
import { SMART_ACCOUNT_SENTENCE } from "./WalletNotice";

type Read = { status: "success"; result: unknown } | { status: "failure"; error: Error };
type Position = readonly [bigint, bigint, bigint];

function blockedReason(wallet: WalletState): string | null {
  if (readyToSign(wallet)) return null;
  if (wallet.status !== "connected") return "Connect a wallet to continue.";
  if (!wallet.onArc) return "Your wallet is on another network. Switch it to Arc to change a loan; nothing is built until then.";
  if (wallet.kind === "smart") return SMART_ACCOUNT_SENTENCE;
  if (wallet.kind === "unavailable") return "Could not check this wallet's type on Arc. Reload to try again.";
  return "Checking your wallet on Arc.";
}

export function WalletPage() {
  const wallet = useWallet();
  if (wallet.status !== "connected") return <ConnectPoster />;
  return <Connected address={wallet.address} wallet={wallet} />;
}

function ConnectPoster() {
  return (
    <section className="relative flex min-h-[calc(100svh-3.5rem)] flex-col justify-center px-5 py-16 md:min-h-[calc(100svh-72px)] md:px-[6vw]">
      <div aria-hidden="true" className="app-watermark absolute right-[4vw] top-[10vh] -z-10 invisible text-[clamp(14rem,30vw,32rem)] md:visible">
        <span className="app-watermark-sign">№</span>
      </div>
      <div className="app-rise" style={{ "--d": 0 } as React.CSSProperties}>
        <Hallmark>Your wallet · Arc mainnet</Hallmark>
      </div>
      <h1 className="app-title app-rise mt-6 max-w-[13ch] text-text" style={{ "--d": 1 } as React.CSSProperties}>
        Your bills. Your <em className="font-semibold text-gold italic">bitcoin</em>.
      </h1>
      <p className="type-lead app-rise mt-8 max-w-[38rem] text-text/88" style={{ "--d": 2 } as React.CSSProperties}>
        Connect to see the bills you wrote, the bills you paid, and every loan against your cirBTC, straight from Arc. Add bitcoin or close a loan in one
        signature.
      </p>
      <div className="app-rise mt-10" style={{ "--d": 3 } as React.CSSProperties}>
        <ConnectButton />
      </div>
    </section>
  );
}

function Connected({ address, wallet }: { address: Address; wallet: WalletState }) {
  const queryClient = useQueryClient();
  const reads = useReadContracts({
    allowFailure: true,
    contracts: [
      { chainId: arc.id, address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] },
      { chainId: arc.id, address: EURC, abi: erc20Abi, functionName: "balanceOf", args: [address] },
      { chainId: arc.id, address: CIRBTC, abi: erc20Abi, functionName: "balanceOf", args: [address] },
      { chainId: arc.id, address: MORPHO, abi: morphoAbi, functionName: "position", args: [CURRENCIES[0]!.marketId, address] },
      { chainId: arc.id, address: MORPHO, abi: morphoAbi, functionName: "position", args: [CURRENCIES[1]!.marketId, address] },
    ],
    query: { refetchInterval: 30_000 },
  });
  function cell<T>(i: number): Cell<T> {
    if (reads.isPending) return { state: "loading" };
    const r = reads.data?.[i] as Read | undefined;
    if (reads.isError || !r || r.status !== "success") return { state: "unavailable" };
    return { state: "ok", value: r.result as T };
  }
  const balances = [cell<bigint>(0), cell<bigint>(1), cell<bigint>(2)] as const;
  const positions = CURRENCIES.map((c, i) => ({ currency: c, position: cell<Position>(3 + i) }));
  // A ticket whose loan was just closed stays up so its receipt can be read.
  const [kept, setKept] = useState<string[]>([]);
  const refetch = reads.refetch;
  const onChanged = useCallback(
    (marketId: string) => {
      setKept((k) => (k.includes(marketId) ? k : [...k, marketId]));
      void refetch();
      void queryClient.invalidateQueries();
    },
    [refetch, queryClient],
  );
  const reason = blockedReason(wallet);
  const tickets = positions.filter(
    (p) => p.position.state === "ok" && (p.position.value[1] > 0n || p.position.value[2] > 0n || kept.includes(p.currency.marketId)),
  );
  const anyPositionUnavailable = positions.some((p) => p.position.state === "unavailable");

  return (
    <div className="px-5 pt-12 pb-24 md:px-[6vw] md:pt-[9vh]">
      <div className="app-rise" style={{ "--d": 0 } as React.CSSProperties}>
        <Hallmark>Your wallet · Arc mainnet</Hallmark>
      </div>
      <h1 className="app-title app-rise mt-6 text-text" style={{ "--d": 1 } as React.CSSProperties}>
        Your <em className="font-semibold text-gold italic">wallet</em>.
      </h1>
      <p className="type-address app-rise mt-5 break-all text-muted" style={{ "--d": 2 } as React.CSSProperties}>
        {address}
      </p>

      <motion.dl {...rise(0)} className="mt-12 grid grid-cols-1 gap-8 border-y border-rule py-8 sm:grid-cols-3">
        {(["USDC", "EURC", "cirBTC"] as const).map((symbol, i) => (
          <div key={symbol}>
            <dt className="type-label text-muted">{symbol}</dt>
            <dd className="type-number mt-3 text-text" data-balance={symbol}>
              <Value cell={balances[i]!} render={(v) => formatUnitsExact(v, symbol === "cirBTC" ? CIRBTC_DECIMALS : 6)} />
            </dd>
          </div>
        ))}
      </motion.dl>

      <section className="mt-16 md:mt-24" aria-labelledby="loans-title">
        <motion.div {...rise(0)} className="flex flex-wrap items-end justify-between gap-4">
          <h2 id="loans-title" className="type-h2 text-text">
            Your loans on <em className="font-semibold italic text-gold">Morpho</em>.
          </h2>
        </motion.div>
        {/* Both markets always hold a place: a live ticket, or a quiet one saying how a loan would start. */}
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          {positions.map((p) =>
            p.position.state !== "ok" ? null : tickets.includes(p) ? (
              <motion.div key={p.currency.symbol} {...rise(1)}>
                <LoanTicket
                  address={address}
                  currency={p.currency}
                  position={p.position.value}
                  cirBtc={balances[2]}
                  loanTokenBalance={p.currency.symbol === "EURC" ? balances[1] : balances[0]}
                  usdcBalance={balances[0]}
                  canSign={reason === null}
                  blockedReason={reason}
                  onChanged={() => onChanged(p.currency.marketId)}
                />
              </motion.div>
            ) : (
              <motion.div key={p.currency.symbol} {...rise(2)} className="h-full">
                <GhostTicket symbol={p.currency.symbol} />
              </motion.div>
            ),
          )}
        </div>
        {reads.isPending ? (
          <span className="live-shimmer mt-6 block h-[2px] w-full" aria-label="Loading" />
        ) : anyPositionUnavailable ? (
          <p className="type-body mt-6 text-muted">Some loan positions are unavailable right now: Arc did not answer. Reload to try again.</p>
        ) : tickets.length === 0 ? (
          <div className="mt-6 flex flex-wrap items-center gap-4">
            <p className="type-body text-muted">No loans from this wallet yet.</p>
            <Button href="/pay" variant="secondary" size="sm">
              Pay a bill
            </Button>
          </div>
        ) : null}
      </section>

      <div className="mt-16 grid gap-16 md:mt-24 lg:grid-cols-12 lg:gap-12">
        <div className="lg:col-span-7">
          <BillsWritten address={address} />
        </div>
        <div className="lg:col-span-5">
          <BillsPaid address={address} />
        </div>
      </div>
    </div>
  );
}

function GhostTicket({ symbol }: { symbol: string }) {
  return (
    <article className="flex h-full min-h-[12rem] flex-col justify-center rounded-[8px] border border-dashed border-rule p-6 md:p-8" data-loan-ghost={symbol}>
      <p className="type-label text-muted">
        {symbol} <span className="opacity-70">against</span> cirBTC
      </p>
      <p className="type-h4 mt-4 text-text/70">No loan.</p>
      <p className="type-body mt-2 max-w-[28rem] text-muted">Paying a {symbol} bill from bitcoin opens one here.</p>
    </article>
  );
}
