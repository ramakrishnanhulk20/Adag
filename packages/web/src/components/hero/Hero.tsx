import "./hero.css";
import Link from "next/link";
import { Hallmark } from "@/components/Hallmark";
import { ThemeImage } from "@/components/ThemeImage";
import { images } from "@/lib/images";
import { CreditRow } from "./CreditRow";
import { HeroAction } from "./HeroAction";
import { HeroNav } from "./HeroNav";
import { HeroScroll } from "./HeroScroll";
import { LiveCells } from "./LiveCells";
import { LiveData } from "./LiveData";
import { LiveTicker } from "./LiveTicker";

const HERO_ID = "top";

export function Hero() {
  return (
    <LiveData>
      <section id={HERO_ID} className="relative isolate overflow-hidden bg-bg md:flex md:min-h-svh md:flex-col" aria-labelledby="hero-title">
        <div aria-hidden="true" className="hero-frame absolute inset-x-0 top-0 h-svh overflow-hidden md:inset-0 md:h-auto">
          <div data-hero-parallax className="absolute inset-0 will-change-transform">
            <div className="hero-media-in absolute inset-0">
              <ThemeImage
                dark={{ wide: images.heroDark, narrow: images.heroDarkMobile }}
                light={{ wide: images.heroLight, narrow: images.heroLightMobile }}
                alt=""
                sizes="100vw"
                preload
                imgClassName="hero-img"
              />
            </div>
          </div>
          <div className="hero-scrim hero-scrim-left hidden md:block" />
          <div className="hero-scrim hero-scrim-bottom hidden md:block" />
          <div className="hero-scrim hero-scrim-rows hidden md:block" />
          <div className="hero-scrim hero-scrim-top hidden md:block" />
          <div className="hero-scrim hero-vignette hidden md:block" />
          <div className="hero-scrim hero-scrim-down md:hidden" />
          <div className="hero-scrim hero-scrim-foot md:hidden" />
          <div data-hero-handover className="hero-scrim hero-handover" />
        </div>

        <HeroNav />

        <div
          data-hero-copy
          // The spec's 21.8% top (196px at 900 tall) gives way on shorter screens so the live numbers stay above the fold.
          className="relative z-10 flex min-h-svh flex-col px-5 pt-[68px] md:min-h-0 md:flex-1 md:px-[6vw] md:pt-[max(96px,min(21.8svh,calc(100svh-662px)))]"
        >
          <div className="hero-in-1 hidden md:block">
            <Hallmark>Live on Arc mainnet</Hallmark>
          </div>
          <div className="hero-in-1 md:hidden">
            <LiveTicker className="tracking-[0.1em] sm:tracking-[0.14em]" />
          </div>
          <h1 id="hero-title" className="hero-headline type-hero mt-4 text-text md:mt-3">
            <span className="hero-line-1 block">Pay the bill.</span>
            <span className="hero-line-2 block">
              Keep the{" "}
              <span className="hero-tail">
                <em className="font-semibold text-gold italic">bitcoin</em>.
              </span>
            </span>
          </h1>
          <p className="hero-in-2 type-lead hero-lead mt-4 max-w-[620px] text-text/88 md:mt-8">
            One signature pledges your bitcoin (cirBTC) on Morpho, borrows exactly the bill, and pays your supplier in USDC or EURC. Adag
            refuses any payment that would push the loan past 40% of the bitcoin&apos;s value.
          </p>
          <div className="hero-in-3 mt-5 flex gap-3 md:mt-8">
            <HeroAction href="/pay" variant="primary" className="flex w-full md:inline-flex md:w-auto">
              Pay a bill
            </HeroAction>
            <HeroAction href="/bill/new" variant="secondary" className="hidden md:inline-flex">
              Write a bill
            </HeroAction>
          </div>
          {/* Phones have room for one button, so suppliers get a quiet line instead of losing the way in. */}
          <p className="hero-in-3 type-micro mt-3 text-text/88 [text-shadow:0_0_10px_var(--bg),0_0_3px_var(--bg)] md:hidden">
            Sending a bill?{" "}
            <Link href="/bill/new" className="link-draw text-gold">
              Write one
            </Link>
          </p>
        </div>

        <div className="hero-in-late relative z-10 px-5 pt-6 pb-14 md:px-[6vw] md:pt-4 md:pb-6">
          <CreditRow className="mb-5 md:mb-4" />
          <LiveCells />
        </div>

        <HeroScroll rootId={HERO_ID} />
      </section>
    </LiveData>
  );
}
