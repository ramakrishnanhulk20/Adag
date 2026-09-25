import heroDark from "../../public/images/hero-dark.png";
import heroDarkMobile from "../../public/images/hero-dark-mobile.png";
import heroLight from "../../public/images/hero-light.png";
import heroLightMobile from "../../public/images/hero-light-mobile.png";
import pledgeHands from "../../public/images/pledge-hands.png";
import vaultCoin from "../../public/images/vault-coin.png";

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
