"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getImageProps, type StaticImageData } from "next/image";
import { useTheme } from "@/components/ThemeProvider";
import type { ResolvedTheme } from "@/lib/theme";

type ThemeArt = { wide: StaticImageData; narrow: StaticImageData };

type ThemeImageProps = {
  dark: ThemeArt;
  light: ThemeArt;
  alt: string;
  sizes?: string;
  preload?: boolean;
  imgClassName?: string;
};

// "auto" is the server's <picture> for a "system" visitor: the browser picks dark or light itself, so only one downloads.
type Layer = ResolvedTheme | "auto";

const NARROW = "(max-width: 767px)";
const DARK_OS = "(prefers-color-scheme: dark)";
const QUALITY = 85;

function srcSetOf(image: StaticImageData, alt: string, sizes: string) {
  return getImageProps({ src: image, alt, sizes, fill: true, quality: QUALITY }).props.srcSet;
}

function ArtLayer({
  layer,
  shown,
  eager,
  onReady,
  dark,
  light,
  alt,
  sizes,
  imgClassName,
}: {
  layer: Layer;
  shown: boolean;
  eager: boolean;
  onReady: (layer: Layer) => void;
  dark: ThemeArt;
  light: ThemeArt;
  alt: string;
  sizes: string;
  imgClassName: string;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const art = layer === "dark" ? dark : light;
  const { props: img } = getImageProps({
    src: art.wide,
    alt,
    sizes,
    fill: true,
    quality: QUALITY,
    placeholder: "blur",
    loading: "eager",
    fetchPriority: eager ? "high" : "auto",
    className: `object-cover ${imgClassName}`,
  });

  useEffect(() => {
    if (imgRef.current?.complete) onReady(layer);
  }, [layer, onReady]);

  const sources =
    layer === "auto"
      ? [
          { media: `${NARROW} and ${DARK_OS}`, srcSet: srcSetOf(dark.narrow, alt, sizes) },
          { media: NARROW, srcSet: srcSetOf(light.narrow, alt, sizes) },
          { media: DARK_OS, srcSet: srcSetOf(dark.wide, alt, sizes) },
        ]
      : [{ media: NARROW, srcSet: srcSetOf(art.narrow, alt, sizes) }];

  return (
    <picture
      data-theme-layer={layer}
      className="absolute inset-0 block"
      style={{
        opacity: shown ? 1 : 0,
        zIndex: shown ? 2 : 1,
        // The outgoing image stays solid under the incoming one, so the cross-fade never dips to the page colour.
        transition: shown ? "opacity 400ms cubic-bezier(0, 0, 0.6, 1)" : "opacity 0ms linear 400ms",
      }}
    >
      {sources.map((s) => (
        <source key={s.media} media={s.media} srcSet={s.srcSet} sizes={sizes} />
      ))}
      <img {...img} ref={imgRef} alt={alt} onLoad={() => onReady(layer)} />
    </picture>
  );
}

export function ThemeImage({ dark, light, alt, sizes = "100vw", preload = false, imgClassName = "" }: ThemeImageProps) {
  const { choice, resolved } = useTheme();
  const [first] = useState<Layer>(() => (choice === "system" || resolved === null ? "auto" : resolved));
  const [autoTheme, setAutoTheme] = useState<ResolvedTheme | null>(null);
  const [mounted, setMounted] = useState<Layer[]>([first]);
  const [ready, setReady] = useState<Layer[]>([first]);
  const [shown, setShown] = useState<Layer>(first);

  useEffect(() => {
    if (first === "auto" && resolved && autoTheme === null) setAutoTheme(resolved);
  }, [first, resolved, autoTheme]);

  let target: Layer = first;
  if (resolved) {
    if (first === "auto") target = autoTheme === null || autoTheme === resolved ? "auto" : resolved;
    else target = resolved;
  }

  useEffect(() => {
    setMounted((current) => (current.includes(target) ? current : [...current, target]));
  }, [target]);

  useEffect(() => {
    if (ready.includes(target)) setShown(target);
  }, [target, ready]);

  const onReady = useCallback((layer: Layer) => {
    setReady((current) => (current.includes(layer) ? current : [...current, layer]));
  }, []);

  const layers = mounted.includes(target) ? mounted : [...mounted, target];

  return (
    // isolate keeps the cross-fade z-indexes inside this box, so scrims drawn after it stay on top.
    <div className="absolute inset-0 isolate">
      {layers.map((layer) => (
        <ArtLayer
          key={layer}
          layer={layer}
          shown={layer === shown}
          eager={preload && layer === first}
          onReady={onReady}
          dark={dark}
          light={light}
          alt={alt}
          sizes={sizes}
          imgClassName={imgClassName}
        />
      ))}
    </div>
  );
}
