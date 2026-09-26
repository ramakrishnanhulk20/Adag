"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { parseUnits, type Address, type Hex } from "viem";
import { signMessage } from "wagmi/actions";
import { Button } from "@/components/Button";
import { codeStatus, issueCode, linkChat, linkedHere, rememberLevels, rememberLinked, savedLevels, setLevels, unlink, type SavedLevels } from "@/lib/alerts/client";
import { checkLevels } from "@/lib/alerts/message";
import { wagmiConfig } from "@/lib/wallet/config";
import { siteUrl } from "@/lib/wallet/site";

type Stage =
  | { kind: "idle" }
  | { kind: "issuing" }
  | { kind: "waiting"; code: string; link: string; expiresAt: number }
  | { kind: "pressed"; code: string; chatId: string; chatHandle: string | null }
  | { kind: "linking"; code: string; chatId: string; chatHandle: string | null }
  | { kind: "linked" };

const POLL_MS = 3_000;
const levelText = (wad: bigint) => (Number(wad / 10n ** 14n) / 100).toString();

// Telegram alerts for this wallet. Every write is signed by the wallet (C46, C47), and the page never asks the server
// whether a wallet is linked: the only memory of it is this browser's own, after its signer linked it (C49).
export function AlertsPanel({ address, canSign, blockedReason }: { address: Address; canSign: boolean; blockedReason: string | null }) {
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [levels, setLevelsText] = useState(["60", "75", ""]);
  const [busy, setBusy] = useState<null | "levels" | "unlink">(null);
  const [linkedAt, setLinkedAt] = useState<number | null>(null);
  const [saved, setSaved] = useState<SavedLevels | null>(null);
  const site = siteUrl();
  const sign = (message: string): Promise<Hex> => signMessage(wagmiConfig, { account: address, message });

  useEffect(() => {
    setLinkedAt(linkedHere(address));
    const remembered = savedLevels(address);
    setSaved(remembered);
    setLevelsText(remembered ? [0, 1, 2].map((i) => (remembered.levelsWad[i] !== undefined ? levelText(remembered.levelsWad[i]!) : "")) : ["60", "75", ""]);
  }, [address]);

  useEffect(() => {
    if (stage.kind !== "waiting") return;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      if (Date.now() > stage.expiresAt) {
        setStage({ kind: "idle" });
        setError("The code expired before Start was pressed. Get a new one.");
        return;
      }
      const answer = await codeStatus(stage.code);
      if (!stopped && answer.ok && answer.value.state === "pressed") {
        setStage({ kind: "pressed", code: stage.code, chatId: answer.value.chatId, chatHandle: answer.value.chatHandle });
      }
    };
    const t = window.setInterval(() => void tick(), POLL_MS);
    void tick();
    return () => {
      stopped = true;
      window.clearInterval(t);
    };
  }, [stage]);

  const start = async () => {
    setError(null);
    setNote(null);
    setStage({ kind: "issuing" });
    const answer = await issueCode();
    if (!answer.ok) {
      setStage({ kind: "idle" });
      return setError(answer.message);
    }
    setStage({ kind: "waiting", ...answer.value });
  };

  const link = async () => {
    if (stage.kind !== "pressed") return;
    setError(null);
    setStage({ ...stage, kind: "linking" });
    const answer = await linkChat(site, address, stage.code, { chatId: stage.chatId, chatHandle: stage.chatHandle }, sign);
    if (!answer.ok) {
      setStage({ ...stage, kind: "pressed" });
      return setError(answer.message);
    }
    rememberLinked(address, true);
    setLinkedAt(Date.now());
    setStage({ kind: "linked" });
  };

  const parsedLevels = (() => {
    try {
      const wads = levels.filter((t) => t.trim() !== "").map((t) => {
        if (!/^\d{1,2}(\.\d{1,2})?$/.test(t.trim())) throw new Error("Use percentages like 60 or 72.5.");
        return parseUnits(t.trim(), 16).toString();
      });
      return { ok: true as const, wads: checkLevels(wads) };
    } catch (e) {
      return { ok: false as const, message: (e as Error).message };
    }
  })();

  const saveLevels = async () => {
    if (!parsedLevels.ok) return;
    setBusy("levels");
    setError(null);
    setNote(null);
    const answer = await setLevels(site, address, parsedLevels.wads, sign);
    setBusy(null);
    if (!answer.ok) return setError(answer.message);
    rememberLevels(address, parsedLevels.wads);
    setSaved(savedLevels(address));
    setNote(`Alert levels saved: ${parsedLevels.wads.map((w) => `${levelText(w)}%`).join(", ")}.`);
  };

  const stopAlerts = async () => {
    setBusy("unlink");
    setError(null);
    setNote(null);
    const answer = await unlink(site, address, sign);
    setBusy(null);
    if (!answer.ok) return setError(answer.message);
    rememberLinked(address, false);
    setLinkedAt(null);
    setStage({ kind: "idle" });
    setNote("Alerts are off for this wallet. Any chat it was linked to gets nothing more.");
  };

  return (
    <div className="grid gap-6 lg:grid-cols-12">
      <article className="app-panel p-6 md:p-8 lg:col-span-7" data-alerts-link>
        <p className="type-label text-gold">Telegram alerts</p>
        <h2 className="type-h3 mt-4 text-text">A message when a loan gets close, and one whenever the guard repays.</h2>
        <p className="type-body mt-3 text-muted">
          Plain text, numbers only: never a link to click except Adag&apos;s own address. Alerts are best effort; the guard does not depend on them.
        </p>
        {linkedAt !== null && stage.kind !== "linked" && (
          <p className="type-body mt-4 text-text" data-alerts-linked-here>
            This browser linked alerts for this wallet on {new Date(linkedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}.
          </p>
        )}

        {!canSign ? (
          <p className="type-body mt-6 text-muted">{blockedReason}</p>
        ) : (
          <AnimatePresence mode="wait">
            <motion.div key={stage.kind} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.25 }} className="mt-6">
              {stage.kind === "idle" || stage.kind === "issuing" ? (
                <Button variant="primary" disabled={stage.kind === "issuing"} onClick={() => void start()} data-action="alerts-start">
                  {stage.kind === "issuing" ? "Getting a code" : linkedAt ? "Link another chat" : "Get Telegram alerts"}
                </Button>
              ) : stage.kind === "waiting" ? (
                <div data-alerts-waiting data-link-code={stage.code}>
                  <p className="type-body text-text">Open the bot and press Start. The code in the link is yours alone and works for ten minutes.</p>
                  <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-center">
                    <Button href={stage.link} external variant="primary">
                      Open Telegram
                    </Button>
                    <p className="type-address break-all text-muted">{stage.link}</p>
                  </div>
                  <p className="type-body mt-4 flex items-center gap-3 text-muted">
                    <span aria-hidden="true" className="live-shimmer inline-block h-[2px] w-10" />
                    Waiting for Start in Telegram
                  </p>
                </div>
              ) : stage.kind === "pressed" || stage.kind === "linking" ? (
                <div data-alerts-pressed>
                  <p className="type-body text-text">
                    Chat {stage.chatHandle ? <span className="font-semibold">@{stage.chatHandle}</span> : "without a username"} (id {stage.chatId}) pressed Start. Sign a message in your wallet to link it to{" "}
                    this wallet. Signing costs nothing and sends no transaction.
                  </p>
                  <Button variant="primary" className="mt-4" disabled={stage.kind === "linking"} onClick={() => void link()} data-action="alerts-link">
                    {stage.kind === "linking" ? "Confirm in your wallet" : "Sign and link"}
                  </Button>
                </div>
              ) : (
                <p className="type-body text-success" data-alerts-result="linked">
                  Linked. Alerts for this wallet go to that chat. Send /stop there, or stop them here, at any time.
                </p>
              )}
            </motion.div>
          </AnimatePresence>
        )}
        {error && (
          <p className="type-body mt-4 text-danger" data-alerts-error>
            {error}
          </p>
        )}
      </article>

      <article className="app-panel p-6 md:p-8 lg:col-span-5" data-alerts-levels>
        <p className="type-label text-gold">Alert levels</p>
        <p className="type-body mt-4 text-muted">A message when a loan&apos;s loan-to-value rises past each level, once, until it falls back below. Until you set your own, the levels are 60% and 75%.</p>
        {saved && (
          <p className="type-body mt-3 text-text" data-alerts-saved>
            Saved {new Date(saved.at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}: {saved.levelsWad.map((w) => `${levelText(w)}%`).join(", ")}
          </p>
        )}
        <div className="mt-5 flex gap-3">
          {levels.map((v, i) => (
            <label key={i} className="block flex-1">
              <span className="type-micro text-muted">Level {i + 1}</span>
              <span className="mt-1 flex items-end gap-1">
                <input
                  inputMode="decimal"
                  autoComplete="off"
                  value={v}
                  placeholder={i === 2 ? "none" : ""}
                  onChange={(e) => setLevelsText(levels.map((x, j) => (j === i ? e.target.value : x)))}
                  className="app-input !text-[1.4rem]"
                  data-field={`alert-level-${i + 1}`}
                />
                <span className="type-body mb-2 text-muted">%</span>
              </span>
            </label>
          ))}
        </div>
        {!parsedLevels.ok && <p className="type-body mt-3 text-danger">{parsedLevels.message}</p>}
        <div className="mt-5 flex flex-col gap-3">
          <Button variant="secondary" disabled={!canSign || !parsedLevels.ok || busy !== null} onClick={() => void saveLevels()} data-action="alerts-levels">
            {busy === "levels" ? "Confirm in your wallet" : "Sign and save levels"}
          </Button>
          <Button variant="secondary" disabled={!canSign || busy !== null} onClick={() => void stopAlerts()} data-action="alerts-unlink">
            {busy === "unlink" ? "Confirm in your wallet" : "Stop alerts for this wallet"}
          </Button>
        </div>
        {note && (
          <p className="type-body mt-4 text-success" data-alerts-note>
            {note}
          </p>
        )}
        <p className="type-micro mt-5 normal-case tracking-[0.04em] text-muted">Each change is a message your wallet signs. Adag never tells anyone else whether a wallet has alerts.</p>
      </article>
    </div>
  );
}
