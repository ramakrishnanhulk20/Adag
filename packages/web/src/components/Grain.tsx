// The page overlay is fixed over everything; "local" sits inside a positioned image frame.
export function Grain({ local = false }: { local?: boolean }) {
  return <div aria-hidden="true" className={`grain ${local ? "grain-local" : "grain-page"}`} />;
}
