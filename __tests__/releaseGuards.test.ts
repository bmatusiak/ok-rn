/**
 * What a release build refuses (tools/release-guards.js, run by Gradle before
 * every release build): DEBUG firmware, and the debugging lock off unless this
 * build asked for a TEST build (Brad, 2026-10-05).
 */
declare const __dirname: string;
const {releaseRefusals, stagedLockOff} = require('../tools/release-guards') as {
  releaseRefusals: (o: {onlykeyH: string | null; firmwareJson: string | null; env?: Record<string, string | undefined>}) => string[];
  stagedLockOff: (json: string) => boolean;
};
const fs = require('fs') as {readFileSync(p: string, e: string): string};
const path = require('path') as {join(...p: string[]): string};

const PROD_H = '#define OKEMU\n//#define DEBUG\n';
const DEBUG_H = '#define OKEMU\n#define DEBUG\n';
const locked = JSON.stringify({debugLock: true});
const unlocked = JSON.stringify({debugLock: false});

test('a production staging passes', () => {
  expect(releaseRefusals({onlykeyH: PROD_H, firmwareJson: locked, env: {}})).toEqual([]);
});

test('DEBUG firmware is refused, as before', () => {
  const r = releaseRefusals({onlykeyH: DEBUG_H, firmwareJson: locked, env: {}});
  expect(r).toHaveLength(1);
  expect(r[0]).toMatch(/DEBUG on/);
});

test('the debugging lock off is refused unless this build asked for a TEST build', () => {
  const r = releaseRefusals({onlykeyH: PROD_H, firmwareJson: unlocked, env: {}});
  expect(r).toHaveLength(1);
  expect(r[0]).toMatch(/debugging lock OFF/);
  /* a leftover TEST staging with a stray other value is still refused */
  expect(releaseRefusals({onlykeyH: PROD_H, firmwareJson: unlocked, env: {OKRN_DEBUG_LOCK: 'on'}})).toHaveLength(1);
  expect(releaseRefusals({onlykeyH: PROD_H, firmwareJson: unlocked, env: {OKRN_DEBUG_LOCK: 'off'}})).toEqual([]);
});

test('nothing staged, or an unreadable firmware.json, is refused', () => {
  expect(releaseRefusals({onlykeyH: null, firmwareJson: locked, env: {}})[0]).toMatch(/no staged soft-key firmware/);
  expect(releaseRefusals({onlykeyH: PROD_H, firmwareJson: null, env: {}})[0]).toMatch(/cannot read/);
  expect(releaseRefusals({onlykeyH: PROD_H, firmwareJson: '{oops', env: {}})[0]).toMatch(/cannot read/);
});

test('the Gradle side: the guard runs before every release build, and an unlocked build is named TEST', () => {
  expect(stagedLockOff(unlocked)).toBe(true);
  expect(stagedLockOff(locked)).toBe(false);
  const gradle = fs.readFileSync(path.join(__dirname, '../android/app/build.gradle'), 'utf8');
  expect(gradle).toMatch(/tasks\.matching \{ it\.name == 'preReleaseBuild' \}\.configureEach \{ doFirst \{ refuseUnsafeRelease\(\) \} \}/);
  expect(gradle).toMatch(/tools\/release-guards\.js/);
  expect(gradle).toMatch(/versionNameSuffix stagedLockOff\(\) \? "-TEST-nolock" : ""/);
});
