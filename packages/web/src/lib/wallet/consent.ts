const KEY = "adag-morpho-disclaimer:";

// Storage can be blocked or full. Either way the answer is "not yet", so the disclaimer is simply asked again.
export function hasAcceptedMorphoDisclaimer(address: string): boolean {
  try {
    return window.localStorage.getItem(KEY + address.toLowerCase()) === "accepted";
  } catch {
    return false;
  }
}

export function rememberMorphoDisclaimer(address: string): void {
  try {
    window.localStorage.setItem(KEY + address.toLowerCase(), "accepted");
  } catch {
    // Not remembered: the next bitcoin-backed payment from this wallet asks again.
  }
}
