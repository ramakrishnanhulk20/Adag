// C62: no error text from a library, an RPC or a service may reach a /break response. The suite throws SuiteError
// for every message it writes itself (some quote a revert that decodeRevert has already turned into Adag's own
// words); anything else is replaced by one fixed sentence here, before it can be streamed.
export class SuiteError extends Error {}

export const UNREADABLE = "the simulation service gave an answer this page cannot read, try again";

export function publicReason(e: unknown): string {
  return e instanceof SuiteError ? e.message.slice(0, 240) : UNREADABLE;
}
