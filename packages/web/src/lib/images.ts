import heroDark from "../../public/images/hero-dark.jpg";
import heroDarkMobile from "../../public/images/hero-dark-mobile.jpg";
import heroLight from "../../public/images/hero-light.jpg";
import heroLightMobile from "../../public/images/hero-light-mobile.jpg";
import pledgeHands from "../../public/images/pledge-hands.jpg";
import vaultCoin from "../../public/images/vault-coin.jpg";

export const images = {
  heroDark,
  heroLight,
  heroDarkMobile,
  heroLightMobile,
  pledgeHands,
  vaultCoin,
} as const;

// Measured by eye on the delivered file: the coin already sits in the drawer, so the falling SVG coin lands here.
export const VAULT_COIN_CENTRE = { x: 0.5, y: 0.51 } as const;
