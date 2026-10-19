// Tether brand icons: one mark, written as the SVG and PNG files under public/.
// Run with `node scripts/generate-icons.mjs` after changing the mark.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// The app's primary blue (hsl 221.2 83.2% 53.3%).
const BRAND = '#2563eb';

// The mark on a 32 grid: a filled dot (you) tied by a line to a ring (the
// running job). Shared with src/shared/ui/TetherMark.tsx.
const MARK = `
  <path d="M10.5 21.5C10.5 16.2 15.8 16.4 19.2 12.9" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>
  <circle cx="10.5" cy="21.5" r="3" fill="#fff"/>
  <circle cx="21.5" cy="10.5" r="3.2" fill="none" stroke="#fff" stroke-width="2.4"/>`;

/** Rounded tile, for favicons and the in-app logo. */
const roundedSvg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="8" fill="${BRAND}"/>${MARK}
</svg>
`;

/** Full-bleed tile for PWA icons ("maskable"): the OS cuts the shape, so the mark stays in the safe zone. */
const maskableSvg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
  <rect width="32" height="32" fill="${BRAND}"/>
  <g transform="translate(16 16) scale(0.82) translate(-16 -16)">${MARK}</g>
</svg>
`;

const png = (svg, size, file) => sharp(Buffer.from(svg), { density: 72 * Math.max(1, size / 32) })
  .resize(size, size)
  .png()
  .toFile(path.join(PUBLIC_DIR, file));

await writeFile(path.join(PUBLIC_DIR, 'logo.svg'), roundedSvg(32));
await writeFile(path.join(PUBLIC_DIR, 'favicon.svg'), roundedSvg(64));
await png(roundedSvg(32), 32, 'favicon.png');
for (const size of [32, 64, 128, 256, 512]) {
  await png(roundedSvg(size), size, `logo-${size}.png`);
}

await writeFile(path.join(PUBLIC_DIR, 'icons', 'icon-template.svg'), maskableSvg(512));
for (const size of [72, 96, 128, 144, 152, 192, 384, 512]) {
  await writeFile(path.join(PUBLIC_DIR, 'icons', `icon-${size}x${size}.svg`), maskableSvg(size));
  await png(maskableSvg(size), size, path.join('icons', `icon-${size}x${size}.png`));
}

console.log('Tether icons written to', PUBLIC_DIR);
