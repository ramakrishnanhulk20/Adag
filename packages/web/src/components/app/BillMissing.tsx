import type { CSSProperties } from "react";
import { Button } from "@/components/Button";
import { Hallmark } from "@/components/Hallmark";

const d = (n: number) => ({ "--d": n }) as CSSProperties;

type BillMissingProps =
  | { kind: "none"; id: bigint; count: bigint | null }
  | { kind: "invalid"; raw: string }
  | { kind: "unavailable"; id: bigint }
  | { kind: "refused"; message: string };

// Three different truths, never merged: no such bill, not a bill number, and Arc not answering (C19).
export function BillMissing(props: BillMissingProps) {
  let mark = "Bill";
  let title: React.ReactNode;
  let body: string;
  if (props.kind === "none") {
    mark = `Bill No. ${props.id}`;
    title = (
      <>
        No bill #{props.id.toString()} on Arc <em className="font-semibold text-gold italic">yet</em>.
      </>
    );
    body =
      props.count === null
        ? "Adag has no record of this number. Check it with whoever sent you the link."
        : props.count === 0n
          ? "No bills have been written on Arc so far. Check the number with whoever sent it."
          : `The newest bill is #${props.count}. Check the number with whoever sent you the link.`;
  } else if (props.kind === "refused") {
    title = (
      <>
        Too many <em className="font-semibold text-gold italic">bills</em>.
      </>
    );
    body = props.message;
  } else if (props.kind === "invalid") {
    title = (
      <>
        That is not a bill <em className="font-semibold text-gold italic">number</em>.
      </>
    );
    body = "Bill numbers are whole numbers from 1 up, like /bill/12.";
  } else {
    mark = `Bill No. ${props.id}`;
    title = (
      <>
        Arc did not <em className="font-semibold text-gold italic">answer</em>.
      </>
    );
    body = "This bill's status is unavailable right now. Nothing on this page means paid or unpaid. Reload in a moment to try again.";
  }

  return (
    <section className="relative px-5 pt-14 pb-24 md:px-[6vw] md:pt-[14vh] md:pb-[18vh]">
      <div className="app-rise" style={d(0)}>
        <Hallmark tone="quiet">{mark}</Hallmark>
      </div>
      <h1 className="app-title app-rise mt-6 max-w-[14ch] text-text" style={d(1)}>
        {title}
      </h1>
      <p className="type-lead app-rise mt-8 max-w-[38rem] text-text/88" style={d(2)}>
        {body}
      </p>
      <div className="app-rise mt-10 flex flex-col gap-3 md:flex-row" style={d(3)}>
        <Button href="/pay" variant="primary" className="w-full md:w-auto">
          Find another bill
        </Button>
        <Button href="/" variant="secondary" className="w-full md:w-auto">
          Back to Adag
        </Button>
      </div>
    </section>
  );
}
