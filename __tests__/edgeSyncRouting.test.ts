/**
 * Every sync message type reaches handleSync (src/edgeAgents.ts). Found on the
 * Pixel (2026-10-05, P2c): GIVE and ANCHOR were handled inside handleSync but
 * the router's list still named only P2a's five types, so the phone answered
 * nothing and the computer reported "is this place on the key's list?".
 */
import {sync as syncLib} from 'node-onlykey-lib/edge';

declare const __dirname: string;
const fs = require('fs') as {readFileSync(p: string, encoding: string): string};
const path = require('path') as {join(...parts: string[]): string};

test('the router sends every sync message type to handleSync', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/edgeAgents.ts'), 'utf8');
  const route = src.split('\n').find(l => l.includes('return await handleSync(msg, seen)')) ?? '';
  const types = Object.keys(syncLib).filter(k => /_TYPE$/.test(k) && k !== 'SIBLING_TYPE');
  expect(types.length).toBeGreaterThanOrEqual(7);
  for (const t of types) expect(route).toContain(`syncLib.${t}`);
});
