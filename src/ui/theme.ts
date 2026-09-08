/*
 * Design tokens, taken from the OnlyKey app rewrite so the two apps look and
 * speak alike.
 *
 * Source: ok-app-rewrite (release/5.7.0-modern-rewrite), src/index.css:1-33.
 * That app is Tailwind v4 + CSS custom properties; the VALUES port, the class
 * names do not, so these are transcribed rather than imported.
 *
 * Dark is its default (`:root`), which is the only mode here for now - the
 * rewrite's `html.light` palette is kept below so a theme toggle is a small
 * change rather than a re-derivation.
 */
const dark = {
  bg: '#1a1a1a',
  surface: '#2d2d2d',
  text: '#ffffff',
  textSecondary: '#d1d5db',
  textDim: '#a8b0bc',
  border: 'rgba(255, 255, 255, 0.1)',
  inputBg: 'rgba(0, 0, 0, 0.3)',
} as const;

/** The rewrite's light palette, transcribed but not yet wired to a toggle. */
export const lightPalette = {
  bg: '#e8eaed',
  surface: '#ffffff',
  text: '#202124',
  textSecondary: '#3c4043',
  textDim: '#5f6368',
  border: 'rgba(0, 0, 0, 0.12)',
  inputBg: 'rgba(0, 0, 0, 0.04)',
} as const;

export const theme = {
  ...dark,

  /*
   * A raised surface for pressed/secondary controls. The rewrite has no token
   * for this - it reaches for Tailwind's slate scale inline - so this is the
   * one value here that is ours.
   */
  surfaceAlt: '#3a3f47',

  /*
   * Semantics. The rewrite does not tokenise these either; they are literals
   * scattered through its CSS and JSX, collected here.
   *   primary  src/index.css:4      accent blue, hover #2563eb
   *   ok       src/index.css:459    .status-success
   *   error    src/index.css:455    .critical-text
   *   warn     Tailwind text-amber-300, e.g. WorkingDialog.tsx:49
   *   link     src/index.css:124
   */
  accent: '#0056b3',
  accentHover: '#2563eb',
  ok: '#4ade80',
  warn: '#fcd34d',
  error: '#f87171',
  link: '#7ec8ff',

  /* index.html:13 - system stack, no webfont is loaded. */
  mono: 'monospace',

  /* body 0.9375rem / 1.55 (src/index.css:46-47). */
  fontSize: 15,
  lineHeight: 23,

  /* 0.5rem is the default; 9999 for pills and dots. */
  radius: 8,
  radiusPill: 9999,
} as const;

export const levelColor = {
  info: theme.textDim,
  tx: theme.link,
  rx: theme.ok,
  error: theme.error,
} as const;

/**
 * Status colour, shared by every pill.
 *
 * Covers both vocabularies: the device's own
 * (uninitialized / locked / unlocked) and the transports'
 * (connected / advertising / error), because the same pill shows both.
 */
export function stateColor(state: string): string {
  switch (state) {
    case 'unlocked':
    case 'connected':
    case 'running':
      return theme.ok;
    case 'locked':
    case 'advertising':
    case 'connecting':
    case 'starting':
    case 'uninitialized':
      return theme.warn;
    case 'error':
    case 'halted':
    case 'unavailable':
      return theme.error;
    default:
      return theme.textDim;
  }
}
