// Measured on public/images/vault-coin.jpg (2400x1792) from its pixels: the photographed coin's centre and size,
// and the velvet tray's four corners, all as fractions of the image.
export const COIN_CENTRE = { x: 0.5017, y: 0.5042 } as const;
export const COIN_SIZE = { w: 0.1433, h: 0.13 } as const;
export const TRAY = [
  [0.475, 0.204],
  [0.84, 0.376],
  [0.595, 0.736],
  [0.178, 0.503],
] as const;
