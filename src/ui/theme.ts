export const theme = {
  bg: '#0b0d10',
  surface: '#14181d',
  surfaceAlt: '#1c222a',
  border: '#2a323c',
  text: '#e6edf3',
  textDim: '#8b98a5',
  accent: '#4c9aff',
  ok: '#3fb950',
  warn: '#d29922',
  error: '#f85149',
  mono: 'monospace',
} as const;

export const levelColor = {
  info: theme.textDim,
  tx: theme.accent,
  rx: theme.ok,
  error: theme.error,
} as const;

/** Connection/advertising state -> colour, shared by both screens' status pill. */
export function stateColor(state: string): string {
  switch (state) {
    case 'connected':
      return theme.ok;
    case 'advertising':
    case 'connecting':
      return theme.warn;
    case 'error':
      return theme.error;
    default:
      return theme.textDim;
  }
}
