/*
 * Log audit (2026-10-04): a RELEASE build (__DEV__ false) prints no error text,
 * stacks, MAC addresses or hidden details; a debug build prints them unchanged.
 */
const load = (dev: boolean) => {
  const was = (globalThis as any).__DEV__;
  (globalThis as any).__DEV__ = dev;
  try {
    let m: any;
    jest.isolateModules(() => { m = require('../src/logSafe'); });
    return m;
  } finally {
    (globalThis as any).__DEV__ = was;
  }
};

test('release: only the error kind, no message, no stack; MACs and details hidden', () => {
  const m = load(false);
  const prev = (globalThis as any).__DEV__;
  (globalThis as any).__DEV__ = false;
  try {
    const e = new TypeError('secret 0011223344 for ssh://brad@host');
    expect(m.errText(e)).toBe('TypeError');
    expect(m.errStack(e)).toBeNull();
    expect(m.scrub('central AA:BB:CC:DD:EE:FF connected')).toBe('central <device> connected');
    expect(m.detail('267, 270', '2 budget(s)')).toBe('2 budget(s)');
    expect(m.errText('plain string with a secret')).toBe('error');
  } finally {
    (globalThis as any).__DEV__ = prev;
  }
});

test('debug: everything as it was', () => {
  const m = load(true);
  const e = new Error('detail kept');
  expect(m.errText(e)).toBe('detail kept');
  expect(m.errStack(e)).toContain('Error: detail kept');
  expect(m.scrub('AA:BB:CC:DD:EE:FF')).toBe('AA:BB:CC:DD:EE:FF');
  expect(m.detail('267', 'x')).toBe('267');
});
