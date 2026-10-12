"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AnimatePresence, motion } from "motion/react";
import { parseUnits, type Address, type Hex } from "viem";
import { signMessage } from "wagmi/actions";
import { Button } from "@/components/Button";
import { localDateIn, localDayMonthIn } from "@/i18n/dates";
import { localeOf } from "@/i18n/locales";
import { useLibText } from "@/i18n/useLibText";
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
// The message the wallet signs is the fixed English text buildMessage writes (I3); the panel says in the visitor's
// language what that message does.
export function AlertsPanel({ address, canSign, blockedReason }: { address: Address; canSign: boolean; blockedReason: string | null }) {
  const t = useTranslations("alerts");
  const tc = useTranslations("common");
  const tl = useLibText();
  const locale = localeOf(useLocale());
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
        setError(t("codeExpired"));
        return;
      }
      const answer = await codeStatus(stage.code);
      if (!stopped && answer.ok && answer.value.state === "pressed") {
        setStage({ kind: "pressed", code: stage.code, chatId: answer.value.chatId, chatHandle: answer.value.chatHandle });
      }
    };
    const timer = window.setInterval(() => void tick(), POLL_MS);
    void tick();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [stage, t]);

  const start = async () => {
    setError(null);
    setNote(null);
    setStage({ kind: "issuing" });
    // The code carries the language the owner is reading in, so the bot's replies and the alerts use it (I4).
    const answer = await issueCode(locale);
    if (!answer.ok) {
      setStage({ kind: "idle" });
      return setError(tl(answer.message));
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
      return setError(tl(answer.message));
    }
    rememberLinked(address, true);
    setLinkedAt(Date.now());
    setStage({ kind: "linked" });
  };

  const parsedLevels = (() => {
    try {
      const wads = levels.filter((x) => x.trim() !== "").map((x) => {
        if (!/^\d{1,2}(\.\d{1,2})?$/.test(x.trim())) throw new Error(t("usePercentagesLike"));
        return parseUnits(x.trim(), 16).toString();
      });
      return { ok: true as const, wads: checkLevels(wads) };
    } catch (e) {
      return { ok: false as const, message: tl((e as Error).message) };
    }
  })();

  const saveLevels = async () => {
    if (!parsedLevels.ok) return;
    setBusy("levels");
    setError(null);
    setNote(null);
    const answer = await setLevels(site, address, parsedLevels.wads, sign);
    setBusy(null);
    if (!answer.ok) return setError(tl(answer.message));
    rememberLevels(address, parsedLevels.wads);
    setSaved(savedLevels(address));
    setNote(t("levelsSaved", { levels: parsedLevels.wads.map((w) => `${levelText(w)}%`).join(", ") }));
  };

  const stopAlerts = async () => {
    setBusy("unlink");
    setError(null);
    setNote(null);
    const answer = await unlink(site, address, sign);
    setBusy(null);
    if (!answer.ok) return setError(tl(answer.message));
    rememberLinked(address, false);
    setLinkedAt(null);
    setStage({ kind: "idle" });
    setNote(t("alertsOff"));
  };

  return (
    <div className="grid gap-6 lg:grid-cols-12">
      <article className="app-panel p-6 md:p-8 lg:col-span-7" data-alerts-link>
        <p className="type-label text-gold">{tc("telegramAlerts")}</p>
        <h2 className="type-h3 mt-4 text-text">{t("title")}</h2>
        <p className="type-body mt-3 text-muted">{t("plainText")}</p>
        {linkedAt !== null && stage.kind !== "linked" && (
          <p className="type-body mt-4 text-text" data-alerts-linked-here>
            {t("linkedHereOn", { date: localDateIn(locale, linkedAt) })}
          </p>
        )}

        {!canSign ? (
          <p className="type-body mt-6 text-muted">{blockedReason}</p>
        ) : (
          <AnimatePresence mode="wait">
            <motion.div key={stage.kind} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.25 }} className="mt-6">
              {stage.kind === "idle" || stage.kind === "issuing" ? (
                <Button variant="primary" disabled={stage.kind === "issuing"} onClick={() => void start()} data-action="alerts-start">
                  {stage.kind === "issuing" ? t("gettingCode") : linkedAt ? t("linkAnotherChat") : t("getAlerts")}
                </Button>
              ) : stage.kind === "waiting" ? (
                <div data-alerts-waiting data-link-code={stage.code}>
                  <p className="type-body text-text">{t("openBotPressStart")}</p>
                  <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-center">
                    <Button href={stage.link} external variant="primary">
                      {t("openTelegram")}
                    </Button>
                    <p className="type-address break-all text-muted">{stage.link}</p>
                  </div>
                  <p className="type-body mt-4 flex items-center gap-3 text-muted">
                    <span aria-hidden="true" className="live-shimmer inline-block h-[2px] w-10" />
                    {t("waitingForStart")}
                  </p>
                </div>
              ) : stage.kind === "pressed" || stage.kind === "linking" ? (
                <div data-alerts-pressed>
                  <p className="type-body text-text">
                    {t.rich("chatPressedStart", {
                      id: stage.chatId,
                      chat: () => (stage.chatHandle ? <span className="font-semibold">@{stage.chatHandle}</span> : <>{t("withoutUsername")}</>),
                    })}
                  </p>
                  <p className="type-body mt-2 text-muted" data-signed-message-note>
                    {t("whatYouSign.link")}
                  </p>
                  <Button variant="primary" className="mt-4" disabled={stage.kind === "linking"} onClick={() => void link()} data-action="alerts-link">
                    {stage.kind === "linking" ? tc("confirmInWallet") : t("signAndLink")}
                  </Button>
                </div>
              ) : (
                <p className="type-body text-success" data-alerts-result="linked">
                  {t("linked")}
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
        <p className="type-label text-gold">{t("levels.title")}</p>
        <p className="type-body mt-4 text-muted">{t("levels.body")}</p>
        {saved && (
          <p className="type-body mt-3 text-text" data-alerts-saved>
            {t("levels.saved", { date: localDayMonthIn(locale, saved.at), levels: saved.levelsWad.map((w) => `${levelText(w)}%`).join(", ") })}
          </p>
        )}
        <div className="mt-5 flex gap-3">
          {levels.map((v, i) => (
            <label key={i} className="block flex-1">
              <span className="type-micro text-muted">{t("levels.level", { n: String(i + 1) })}</span>
              <span className="mt-1 flex items-end gap-1">
                <input
                  inputMode="decimal"
                  autoComplete="off"
                  value={v}
                  placeholder={i === 2 ? t("levels.none") : ""}
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
        <p className="type-body mt-3 text-muted" data-signed-message-note>
          {t("whatYouSign.levelsAndStop")}
        </p>
        <div className="mt-5 flex flex-col gap-3">
          <Button variant="secondary" disabled={!canSign || !parsedLevels.ok || busy !== null} onClick={() => void saveLevels()} data-action="alerts-levels">
            {busy === "levels" ? tc("confirmInWallet") : t("levels.signAndSave")}
          </Button>
          <Button variant="secondary" disabled={!canSign || busy !== null} onClick={() => void stopAlerts()} data-action="alerts-unlink">
            {busy === "unlink" ? tc("confirmInWallet") : t("levels.stopAlerts")}
          </Button>
        </div>
        {note && (
          <p className="type-body mt-4 text-success" data-alerts-note>
            {note}
          </p>
        )}
        <p className="type-micro mt-5 normal-case tracking-[0.04em] text-muted">{t("levels.eachChange")}</p>
      </article>
    </div>
  );
}
