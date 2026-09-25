"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTheme } from "@/components/ThemeProvider";

type Drawn = { theme: string; svg: string } | { theme: string; error: string };

// Mermaid needs plain colour values, so the palette is read from the live tokens at draw time, never written here.
function palette() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    background: v("--bg"),
    mainBkg: v("--surface"),
    primaryColor: v("--surface"),
    primaryTextColor: v("--text"),
    primaryBorderColor: v("--rule-strong"),
    secondaryColor: v("--raised"),
    tertiaryColor: v("--bg"),
    lineColor: v("--muted"),
    textColor: v("--text"),
    clusterBkg: v("--bg"),
    clusterBorder: v("--gold"),
    titleColor: v("--gold"),
    edgeLabelBackground: v("--surface"),
    nodeBorder: v("--rule-strong"),
    actorBkg: v("--surface"),
    actorBorder: v("--gold"),
    actorTextColor: v("--text"),
    actorLineColor: v("--rule-strong"),
    signalColor: v("--muted"),
    signalTextColor: v("--text"),
    labelBoxBkgColor: v("--surface"),
    labelBoxBorderColor: v("--gold"),
    labelTextColor: v("--text"),
    loopTextColor: v("--text"),
    noteBkgColor: v("--raised"),
    noteTextColor: v("--text"),
    noteBorderColor: v("--gold"),
    activationBkgColor: v("--raised"),
    activationBorderColor: v("--gold"),
    sequenceNumberColor: v("--on-gold"),
  };
}

export function Mermaid({ chart }: { chart: string }) {
  const { resolved } = useTheme();
  const id = `mmd${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [drawn, setDrawn] = useState<Drawn | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  // The full-size copy exists only while open, so the page never holds the same SVG ids twice.
  const [full, setFull] = useState(false);

  useEffect(() => {
    if (full) dialog.current?.showModal();
  }, [full]);

  useEffect(() => {
    if (!resolved) return;
    let alive = true;
    (async () => {
      const { default: mermaid } = await import("mermaid");
      const body = getComputedStyle(document.documentElement).getPropertyValue("--font-dm-sans").trim();
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        fontFamily: `${body || "system-ui"}, system-ui, sans-serif`,
        themeVariables: { ...palette(), fontSize: "14px" },
        // Drawn at natural size: the page fits it to the column, and the full-size dialog shows it readable.
        flowchart: { useMaxWidth: false },
        sequence: { showSequenceNumbers: true, mirrorActors: false, useMaxWidth: false },
      });
      const { svg } = await mermaid.render(`${id}-${resolved}`, chart.trim());
      if (alive) setDrawn({ theme: resolved, svg });
    })().catch((error: unknown) => {
      if (alive) setDrawn({ theme: resolved, error: error instanceof Error ? error.message : "The diagram could not be drawn." });
    });
    return () => {
      alive = false;
    };
  }, [chart, resolved, id]);

  if (drawn && "error" in drawn) {
    return (
      <figure className="docs-mermaid not-prose" data-mermaid="error">
        <p className="type-micro text-danger">Diagram error: {drawn.error}</p>
        <pre className="mt-3 overflow-x-auto text-xs">{chart}</pre>
      </figure>
    );
  }
  return (
    <figure className="docs-mermaid not-prose" data-mermaid={drawn ? "drawn" : "drawing"} data-mermaid-theme={drawn?.theme}>
      {drawn ? (
        <>
          <div className="docs-mermaid-svg" dangerouslySetInnerHTML={{ __html: drawn.svg }} />
          <button type="button" className="docs-mermaid-open" onClick={() => setFull(true)}>
            Open full size
          </button>
          <dialog
            ref={dialog}
            className="docs-mermaid-dialog"
            aria-label="Diagram at full size"
            onClose={() => setFull(false)}
            onClick={(e) => e.target === e.currentTarget && dialog.current?.close()}
          >
            <button type="button" className="docs-mermaid-close" onClick={() => dialog.current?.close()}>
              Close
            </button>
            {full && <div className="docs-mermaid-svg" dangerouslySetInnerHTML={{ __html: drawn.svg }} />}
          </dialog>
        </>
      ) : (
        <div className="flex min-h-48 items-center justify-center">
          <span className="type-micro text-muted">Drawing the diagram</span>
        </div>
      )}
    </figure>
  );
}
