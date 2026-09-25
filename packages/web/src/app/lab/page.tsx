import type { Metadata } from "next";
import Image, { type StaticImageData } from "next/image";
import Link from "next/link";
import { ColourTokens } from "./_components/ColourTokens";
import { FiguresCheck } from "./_components/FiguresCheck";
import { HeroSentence } from "./_components/HeroSentence";
import { ParallaxLayer } from "./_components/ParallaxLayer";
import { ResolvedThemeLine } from "./_components/ResolvedThemeLine";
import { Reveal } from "./_components/Reveal";
import { SmoothScrollStatus } from "./_components/SmoothScrollStatus";
import { StampsDemo } from "./_components/StampsDemo";
import { Button } from "@/components/Button";
import { DiamondSeparator } from "@/components/DiamondSeparator";
import { Grain } from "@/components/Grain";
import { Hallmark } from "@/components/Hallmark";
import { ThemeControl } from "@/components/ThemeControl";
import { ThemeImage } from "@/components/ThemeImage";
import { images, VAULT_COIN_CENTRE } from "@/lib/images";

export const metadata: Metadata = {
  title: "Lab · Adag",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

const BLOCKS = [
  { id: "theme", title: "Theme" },
  { id: "type", title: "Type scale" },
  { id: "figures", title: "Tabular figures" },
  { id: "colour", title: "Colour tokens" },
  { id: "hallmark", title: "The hallmark" },
  { id: "stamps", title: "Bill stamps" },
  { id: "buttons", title: "Buttons" },
  { id: "images", title: "Image slots" },
  { id: "scroll", title: "Smooth scroll" },
] as const;

const BUTTON_STATES = ["Rest, live", "Hover", "Focus", "Disabled"] as const;

const CREDIT_ROW =["Arc mainnet", "USDC or EURC", "Morpho Blue", "40% cap", "One signature", "No owner"];

const TYPE_ROWS: { token: string; spec: string; sample: React.ReactNode }[] = [
  {
    token: "pinned",
    spec: "Bodoni Moda 500 · clamp(6rem, 18vw, 13.3125rem) · 0.85 · -0.03em",
    sample: <p className="type-pinned text-gold">40%</p>,
  },
  {
    token: "h2",
    spec: "Bodoni Moda 600 · clamp(2.75rem, 1.25rem + 5vw, 5.625rem) · 1.0 · -0.015em",
    sample: <p className="type-h2">Pledged, not sold.</p>,
  },
  { token: "h3", spec: "Bodoni Moda 600 · 38px · 1.05 · -0.01em", sample: <p className="type-h3">One signature.</p> },
  {
    token: "number",
    spec: "Bodoni Moda 500 · clamp(2.25rem, 1.5rem + 1.8vw, 3.125rem) · tabular-nums",
    sample: <p className="type-number">0123456789</p>,
  },
  { token: "h4", spec: "DM Sans 600 · 28px · 1.2 · -0.005em", sample: <p className="type-h4">For suppliers</p> },
  {
    token: "lead",
    spec: "DM Sans 400 · 21px, 17px under 768 · 1.45",
    sample: (
      <p className="type-lead max-w-[620px] text-text/88">
        One signature pledges your bitcoin (cirBTC) on Morpho, borrows exactly the bill, and pays your supplier in USDC or
        EURC. Adag refuses any payment that would push the loan past 40% of the bitcoin&apos;s value.
      </p>
    ),
  },
  {
    token: "body",
    spec: "DM Sans 400 · 16px · 1.6 · 66 characters a line at most",
    sample: (
      <p className="type-body max-w-[66ch]">
        Indian families pledge gold for cash instead of selling it. Adag, from the Tamil word adagu, does the same with
        bitcoin on Arc, and the supplier is paid in dollars or euros.
      </p>
    ),
  },
  { token: "ui", spec: "DM Sans 500 · 16px · 1.25 · 0.005em", sample: <p className="type-ui">Pay a bill</p> },
  { token: "label", spec: "IBM Plex Mono 500 · 13px · uppercase · 0.14em", sample: <p className="type-label">Paid through Adag</p> },
  { token: "micro", spec: "IBM Plex Mono 400 · 12px · uppercase · 0.12em", sample: <p className="type-micro">Arc mainnet · one signature</p> },
  {
    token: "address",
    spec: "IBM Plex Mono 400 · 13px · never uppercase",
    sample: <p className="type-address break-all">0x6F2199e0A04e5e8ba67c89C467b6DF168b01137E</p>,
  },
];

function Block({ index, children, note }: { index: number; children: React.ReactNode; note: React.ReactNode }) {
  const block = BLOCKS[index]!;
  const number = String(index + 1).padStart(2, "0");
  return (
    <section id={block.id} className="scroll-mt-24 border-t border-rule px-5 py-20 md:px-[6vw] md:py-28">
      <Reveal className="mb-12 flex flex-col items-start gap-5 md:mb-16 md:flex-row md:items-end md:justify-between md:gap-12">
        <Hallmark as="h2">
          {number} · {block.title}
        </Hallmark>
        <div className="type-body max-w-[52ch] text-muted md:text-right">{note}</div>
      </Reveal>
      {children}
    </section>
  );
}

function SlotCaption({ slot, detail }: { slot: string; detail: string }) {
  return (
    <figcaption className="mt-4 flex flex-col gap-1.5">
      <span className="type-label text-gold">{slot}</span>
      <span className="type-micro text-muted">{detail}</span>
    </figcaption>
  );
}

function HeroTile({
  slot,
  image,
  tone,
  tall,
  detail,
  sizes,
}: {
  slot: string;
  image: StaticImageData;
  tone: "ink" | "linen";
  tall: boolean;
  detail: string;
  sizes: string;
}) {
  return (
    <figure>
      <div className={`still tone-${tone}`} style={{ aspectRatio: `${image.width} / ${image.height}` }}>
        <Image src={image} alt="" fill sizes={sizes} quality={85} placeholder="blur" className={`object-cover ${tone === "linen" ? "daylight" : ""}`} />
        {tone === "linen" && <div className="still-layer wash-linen" />}
        {tall ? (
          <div className="still-layer scrim-bottom-tall" />
        ) : (
          <>
            <div className="still-layer scrim-left" />
            <div className="still-layer scrim-bottom" />
          </>
        )}
        <div className="still-layer scrim-top" />
        {tone === "ink" && !tall && <div className="still-layer vignette" />}
        <Grain local />
      </div>
      <SlotCaption slot={slot} detail={detail} />
    </figure>
  );
}

export default function LabPage() {
  return (
    <>
      <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-rule bg-bg/92 px-5 backdrop-blur-md md:h-[72px] md:px-[6vw]">
        <div className="flex items-center gap-4">
          <span className="font-display text-[22px] font-semibold tracking-[0.08em]">ADAG</span>
          <Hallmark tone="quiet" className="hidden sm:inline-flex">
            Lab
          </Hallmark>
        </div>
        <div className="flex items-center gap-5">
          <Link href="/lab/hero" className="link-draw type-micro text-muted hover:text-gold">
            Hero
          </Link>
          <ThemeControl variant="cycle" />
        </div>
      </header>

      <main>
        <div className="relative overflow-hidden px-5 pt-16 pb-20 md:px-[6vw] md:pt-28 md:pb-28">
          <Reveal on="load">
            <Hallmark className="md:text-base">Design system · not indexed</Hallmark>
          </Reveal>
          <Reveal on="load" delay={0.08} className="mt-8 md:mt-10">
            <h1 className="type-h2 max-w-[14ch] md:text-[clamp(4rem,1rem+6vw,7.5rem)]">
              The hallmark, the gold, <em className="text-gold italic">the grain.</em>
            </h1>
          </Reveal>
          <Reveal on="load" delay={0.16} className="mt-8 md:mt-10">
            <p className="type-lead max-w-[56ch] text-muted">
              Every piece of Adag&apos;s design system, rendered live in whichever theme you pick. Nothing links here, and search
              engines are told to stay out.
            </p>
          </Reveal>
          <Reveal on="load" delay={0.24} className="mt-12">
            <nav aria-label="Lab blocks" className="flex flex-wrap items-center gap-x-4 gap-y-3">
              {BLOCKS.map((block, i) => (
                <span key={block.id} className="flex items-center gap-4">
                  {i > 0 && <DiamondSeparator />}
                  <a
                    href={`#${block.id}`}
                    className="type-micro bg-[linear-gradient(currentColor,currentColor)] bg-[length:0%_1px] bg-left-bottom bg-no-repeat pb-1 text-muted transition-[background-size,color] duration-200 hover:bg-[length:100%_1px] hover:text-gold"
                  >
                    {String(i + 1).padStart(2, "0")} {block.title}
                  </a>
                </span>
              ))}
            </nav>
          </Reveal>
        </div>

        <Block index={0} note="The nav button cycles System, Light and Dark. The footer control sets one directly. The choice lives in the adag-theme cookie, so the server paints the right theme and image first time.">
          <div className="grid gap-12 md:grid-cols-12 md:gap-8">
            <Reveal className="flex flex-col gap-8 md:col-span-5">
              <div className="flex items-center gap-5">
                <ThemeControl variant="cycle" tipAlign="start" />
                <span className="type-micro text-muted">Nav button, hover for its tooltip</span>
              </div>
              <div className="flex flex-col items-start gap-3">
                <ThemeControl variant="segmented" />
                <span className="type-micro text-muted">Footer control</span>
              </div>
            </Reveal>
            <Reveal delay={0.08} className="md:col-span-6 md:col-start-7">
              <ResolvedThemeLine />
            </Reveal>
          </div>
        </Block>

        <Block index={1} note="Ratio 1.333 from a 16px base. Every token at its real size. Resize the window to watch the fluid ones move.">
          <Reveal className="border-b border-rule pb-14">
            <p className="type-label mb-2 text-gold">hero</p>
            <p className="type-micro mb-8 text-muted">Bodoni Moda 600 · clamp(3rem, 8.5vw, 7.5rem) · 0.92 · -0.02em · bitcoin in 600 italic gold</p>
            <HeroSentence />
          </Reveal>
          <ul>
            {TYPE_ROWS.map((row) => (
              <li key={row.token} className="border-b border-rule py-10 md:grid md:grid-cols-[16rem_1fr] md:gap-10">
                <Reveal className="mb-5 md:mb-0">
                  <p className="type-label mb-2 text-gold">{row.token}</p>
                  <p className="type-micro text-muted">{row.spec}</p>
                </Reveal>
                <Reveal delay={0.06} className="min-w-0 overflow-hidden">
                  {row.sample}
                </Reveal>
              </li>
            ))}
          </ul>
        </Block>

        <Block index={2} note="SPEC open item 1. The widest and narrowest digits stacked with tabular-nums on. If a face's two widths differ, its columns will not line up in the live numbers.">
          <Reveal>
            <FiguresCheck />
          </Reveal>
        </Block>

        <Block index={3} note="Read from the live CSS variables for the theme on screen. Every ratio is worked out in this browser from what is rendered, not copied from the spec.">
          <Reveal>
            <ColourTokens />
          </Reveal>
        </Block>

        <Block index={4} note="A rectangle with 45 degree corners cut at 0.35em, drawn as two stacked clip-path layers because clip-path would cut a plain border.">
          <div className="grid gap-14 md:grid-cols-12 md:gap-8">
            <Reveal className="flex flex-col gap-10 md:col-span-5">
              <div className="flex flex-col items-start gap-3">
                <Hallmark size="lg">Live on Arc mainnet</Hallmark>
                <span className="type-micro text-muted">Eyebrow</span>
              </div>
              <div className="flex flex-col items-start gap-3">
                <Hallmark>01 · Pledged, not sold</Hallmark>
                <span className="type-micro text-muted">Section label</span>
              </div>
              <div className="flex flex-col items-start gap-3 bg-surface p-5">
                <Hallmark ground="var(--surface)">Sits on --surface</Hallmark>
                <span className="type-micro text-muted">Inner layer matched to its ground</span>
              </div>
            </Reveal>
            <Reveal delay={0.08} className="flex flex-col gap-10 md:col-span-7">
              <div className="flex items-end gap-10">
                <Hallmark className="text-[2.25rem]">Cut</Hallmark>
                <div className="flex flex-col items-center gap-3">
                  <DiamondSeparator className="h-12 w-12" />
                  <span className="type-micro text-muted">Diamond at 8x</span>
                </div>
              </div>
              <div className="flex flex-col gap-3">
                <p className="type-micro flex flex-wrap items-center gap-x-3 gap-y-2 text-muted">
                  {CREDIT_ROW.map((item, i) => (
                    <span key={item} className="flex items-center gap-3">
                      {i > 0 && <DiamondSeparator />}
                      {item}
                    </span>
                  ))}
                </p>
                <span className="type-micro text-muted/70">Credit row, 6px gold diamond between items</span>
              </div>
            </Reveal>
          </div>
        </Block>

        <Block index={5} note="Double rule, tilted, with a faint ink roughness. Spring at stiffness 700 and damping 24, and a 2px jolt of the card. Reduced motion drops both.">
          <StampsDemo />
        </Block>

        <Block index={6} note="8px radius, never pills. Hover and focus are forced on here so both themes can be judged without a pointer. The rest column is live.">
          <div className="flex flex-col gap-12">
            {(["primary", "secondary"] as const).map((variant, row) => {
              const label = variant === "primary" ? "Pay a bill" : "Write a bill";
              return (
                <Reveal key={variant} delay={row * 0.08} className="border-t border-rule pt-6">
                  <p className="type-label mb-6 text-gold">{variant}</p>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-8 md:grid-cols-4">
                    {BUTTON_STATES.map((state) => (
                      <div key={state} className="flex flex-col items-start gap-4">
                        <span className="type-micro text-muted">{state}</span>
                        <Button
                          variant={variant}
                          forceState={state === "Hover" ? "hover" : state === "Focus" ? "focus" : undefined}
                          disabled={state === "Disabled"}
                          tabIndex={state === "Hover" || state === "Focus" ? -1 : undefined}
                        >
                          {label}
                        </Button>
                      </div>
                    ))}
                  </div>
                </Reveal>
              );
            })}
          </div>
        </Block>

        <Block index={7} note="Each slot with its SPEC section 7 treatment. The first frame follows the theme: the server picks its image from the cookie and a switch cross-fades over 400ms.">
          <Reveal className="-mx-5 md:-mx-[6vw]">
            <figure>
              <div className="still tone-theme relative h-[88svh] md:h-auto md:aspect-[16/9]">
                <ThemeImage
                  dark={{ wide: images.heroDark, narrow: images.heroDarkMobile }}
                  light={{ wide: images.heroLight, narrow: images.heroLightMobile }}
                  alt=""
                  sizes="100vw"
                  imgClassName="light:[filter:saturate(0.92)]"
                />
                <div className="still-layer wash-linen hidden light:block" />
                <div className="still-layer scrim-left hidden md:block" />
                <div className="still-layer scrim-bottom hidden md:block" />
                <div className="still-layer scrim-bottom-tall md:hidden" />
                <div className="still-layer scrim-top" />
                <div className="still-layer vignette hidden md:dark:block" />
                <Grain local />
                <div className="absolute inset-x-5 bottom-10 z-10 md:inset-x-[6vw] md:bottom-[14%]">
                  <p className="type-hero text-text [text-shadow:var(--hero-text-shadow)]">
                    <span className="block">Pay the bill.</span>
                    <span className="block">
                      Keep the <em className="text-gold italic">bitcoin</em>.
                    </span>
                  </p>
                </div>
              </div>
              <div className="px-5 md:px-[6vw]">
                <SlotCaption slot="hero · follows the theme" detail="hero-dark or hero-light at 768 and up, the mobile crops below. Text over the photo is here to judge the scrim." />
              </div>
            </figure>
          </Reveal>

          <div className="mt-20 grid gap-14 md:grid-cols-12 md:items-end md:gap-8">
            <Reveal className="md:col-span-8">
              <HeroTile slot="hero-dark" image={images.heroDark} tone="ink" tall={false} sizes="(min-width: 768px) 60vw, 100vw" detail="2752x1536 · left, bottom and top scrims in ink, vignette, grain" />
            </Reveal>
            <Reveal delay={0.08} className="md:col-span-4">
              <HeroTile slot="hero-dark-mobile" image={images.heroDarkMobile} tone="ink" tall sizes="(min-width: 768px) 30vw, 100vw" detail="1536x2552, cropped file · tall bottom scrim, top scrim, grain" />
            </Reveal>
            <Reveal className="md:col-span-4">
              <HeroTile slot="hero-light-mobile" image={images.heroLightMobile} tone="linen" tall sizes="(min-width: 768px) 30vw, 100vw" detail="1536x2752 · linen scrims, multiply wash, saturate 0.92, grain" />
            </Reveal>
            <Reveal delay={0.08} className="md:col-span-8">
              <HeroTile slot="hero-light" image={images.heroLight} tone="linen" tall={false} sizes="(min-width: 768px) 60vw, 100vw" detail="2752x1536 · linen scrims, no vignette, multiply wash, saturate 0.92, grain" />
            </Reveal>
          </div>

          <div className="mt-24 grid gap-14 md:grid-cols-12 md:gap-8">
            <Reveal className="md:col-span-5">
              <figure>
                <div className="still tone-ink border border-rule" style={{ aspectRatio: `${images.pledgeHands.width} / ${images.pledgeHands.height}` }}>
                  <ParallaxLayer range={6}>
                    <Image src={images.pledgeHands} alt="Hands laying gold jewellery on a brass tray beside a handwritten pledge slip" fill sizes="(min-width: 768px) 40vw, 100vw" quality={85} placeholder="blur" className="object-cover" />
                  </ParallaxLayer>
                  <div className="still-layer scrim-caption" />
                  <Grain local />
                  <p className="type-micro on-ink absolute bottom-5 left-5 z-10">Gold pledged, not sold.</p>
                </div>
                <SlotCaption slot="pledge-hands" detail="1792x2400, delivered portrait 3:4, not the 3:2 in the spec · square frame, 1px rule, caption scrim, parallax 6%, grain" />
              </figure>
            </Reveal>
            <Reveal delay={0.08} className="md:col-span-7 md:mt-40">
              <figure>
                <div className="fade-edges relative" style={{ aspectRatio: `${images.vaultCoin.width} / ${images.vaultCoin.height}` }}>
                  <Image src={images.vaultCoin} alt="A gold bitcoin resting on blue velvet in an open safe deposit drawer" fill sizes="(min-width: 768px) 55vw, 100vw" quality={85} placeholder="blur" className="object-cover" />
                  <Grain local />
                </div>
                <SlotCaption
                  slot="vault-coin"
                  detail={`2400x1792, delivered landscape 4:3, not the 4:5 in the spec · edges fade into --bg, grain · coin already in the photo, centre at ${Math.round(VAULT_COIN_CENTRE.x * 100)}% across, ${Math.round(VAULT_COIN_CENTRE.y * 100)}% down`}
                />
              </figure>
            </Reveal>
          </div>
        </Block>

        <Block index={8} note="Lenis at lerp 0.1 on the GSAP ticker. Wheel scrolling glides; touch and reduced motion keep native scroll.">
          <div className="relative h-[120vh]">
            <div className="sticky top-1/3 flex flex-col gap-6">
              <p className="type-h2 max-w-[12ch]">
                Feel the <em className="text-gold italic">glide.</em>
              </p>
              <SmoothScrollStatus />
            </div>
          </div>
        </Block>
      </main>

      <footer className="flex flex-col gap-6 border-t border-rule px-5 py-12 md:flex-row md:items-center md:justify-between md:px-[6vw]">
        <p className="type-micro text-muted">Adag lab · not linked, not indexed</p>
        <ThemeControl variant="segmented" />
      </footer>
    </>
  );
}
