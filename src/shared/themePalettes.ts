/**
 * CloudCLI live: colour variants for each appearance. The light/dark mode
 * picks which set applies; a variant only redefines the surface tokens
 * (background, cards, borders) under `html[data-palette="…"]` in index.css,
 * so every component follows without change. The first entry of each list is
 * the original look and needs no CSS of its own.
 */
export type ThemePalette = {
  id: string;
  label: string;
  /** Page background as hex, for the browser/OS status bar colour. */
  statusBar: string;
};

export const DARK_PALETTES: ThemePalette[] = [
  { id: 'midnight', label: 'Midnight (original, darkest)', statusBar: '#141414' },
  { id: 'graphite', label: 'Graphite (softer grey)', statusBar: '#262626' },
  { id: 'slate', label: 'Slate (blue grey)', statusBar: '#1f2430' },
];

export const LIGHT_PALETTES: ThemePalette[] = [
  { id: 'cream', label: 'Cream (original, warm)', statusBar: '#f6f4ef' },
  { id: 'paper', label: 'Paper (neutral white)', statusBar: '#f7f7f8' },
  { id: 'cool', label: 'Cool grey (more contrast)', statusBar: '#e9ecf1' },
];

export const DEFAULT_DARK_PALETTE = DARK_PALETTES[0].id;
export const DEFAULT_LIGHT_PALETTE = LIGHT_PALETTES[0].id;

/** A stored id, or the original variant when the id is missing or unknown. */
export const resolvePalette = (palettes: ThemePalette[], id: unknown): ThemePalette => (
  palettes.find((palette) => palette.id === id) ?? palettes[0]
);
