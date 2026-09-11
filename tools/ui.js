/**
 * Reading and tapping the phone's screen, shared by tools/e2e.js and tools/tap.js.
 *
 * Everything here goes through `uiautomator dump`, which describes the window
 * as XML with a `bounds` box per node. Two facts about it shape every function:
 *
 * - IT WAITS FOR THE SCREEN TO GO QUIET, and gives up after ten seconds with
 *   "ERROR: could not get idle state" and NO FILE. The first runner ignored
 *   that and read the previous dump - see
 *   FINDING-uiautomator-cannot-dump-a-screen-that-never-idles.md.
 * - React Native renders a pressable as a ViewGroup with the label on
 *   `content-desc`, and the visible text as a separate NON-clickable child.
 *   Tapping the child usually falls through to the parent, but not always, so
 *   the clickable node wins when there is one.
 */
'use strict';

const {adb} = require('./adb');

const DUMP_FILE = '/sdcard/ok-e2e-ui.xml';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const noop = () => {};

/**
 * The current view hierarchy, as XML - or an error, never a stale one.
 *
 * Remove the old file first, read what the dump SAID, retry a few times -
 * the app batches its log rendering so quiet windows exist - and otherwise
 * throw naming the error. The dump is written on the device and read back;
 * `-o -` is not supported on every Android version.
 */
function dumpUi({trace = noop} = {}) {
  let said = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    adb(['shell', 'rm', '-f', DUMP_FILE]);
    said = adb(['shell', 'uiautomator', 'dump', DUMP_FILE]).trim();
    if (/dumped to/i.test(said)) {
      return adb(['shell', 'cat', DUMP_FILE]);
    }
    trace(`ui dump ${attempt}/3 failed: ${said || '(no output)'}`);
  }
  throw new Error(
    `the screen could not be read: uiautomator said "${said}". It needs a second ` +
    'with no content changes; something on screen is repainting continuously.',
  );
}

/** Centre of the node carrying this label, preferring a clickable one. */
function findByText(xml, label) {
  let fallback = null;

  for (const node of xml.split('<node ')) {
    const text = /text="([^"]*)"/.exec(node);
    const desc = /content-desc="([^"]*)"/.exec(node);
    const matches = (text && text[1] === label) || (desc && desc[1] === label);
    if (!matches) continue;

    const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node);
    if (!b) continue;
    const [, x1, y1, x2, y2] = b.map(Number);
    const spot = {x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2)};

    if (/clickable="true"/.test(node)) return spot;
    if (!fallback) fallback = spot;
  }
  return fallback;
}

/**
 * Every label the screen is showing, for an error that has to name them.
 * Truncated: a full hierarchy is hundreds of nodes.
 */
function visibleLabels(xml, limit = 25) {
  const seen = new Set();
  for (const node of xml.split('<node ')) {
    for (const attr of [/text="([^"]+)"/, /content-desc="([^"]+)"/]) {
      const m = attr.exec(node);
      if (m && m[1].trim()) seen.add(m[1].trim());
    }
  }
  const all = [...seen];
  return all.length > limit
    ? all.slice(0, limit).join(' | ') + ` … and ${all.length - limit} more`
    : all.join(' | ');
}

/** The display size, from the root node of a UI dump. Falls back to a phone. */
function screenSize(xml) {
  const m = /bounds="\[0,0\]\[(\d+),(\d+)\]"/.exec(xml);
  return m ? {w: Number(m[1]), h: Number(m[2])} : {w: 1080, h: 2400};
}

/** One swipe up, most of the screen, for a control below the fold. */
function swipeUp(xml) {
  const {w, h} = screenSize(xml);
  adb(['shell', 'input', 'swipe',
    String(w >> 1), String(Math.round(h * 0.75)),
    String(w >> 1), String(Math.round(h * 0.3)), '300']);
}

/**
 * Tap the control with this label, waiting for it to appear.
 *
 * Says so once when it turns into a wait rather than a tap - silence for the
 * whole timeout is what makes a slow step look like a broken one - and the
 * error names what WAS on screen, so a wrong screen, a renamed control and an
 * app that never loaded read differently.
 */
async function tapText(label, {timeoutMs = 15000, trace = noop, scroll = 0} = {}) {
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();
  let waited = false;
  let swipes = 0;
  let last = null;

  for (;;) {
    last = dumpUi({trace});
    const spot = findByText(last, label);
    if (spot) {
      const took = Date.now() - started;
      trace(`tapped "${label}" at ${spot.x},${spot.y}`
        + (took > 1000 ? ` after ${(took / 1000).toFixed(1)}s` : ''));
      adb(['shell', 'input', 'tap', String(spot.x), String(spot.y)]);
      return spot;
    }

    if (swipes < scroll) {
      swipes += 1;
      trace(`"${label}" is not on screen, swiping up (${swipes}/${scroll})`);
      swipeUp(last);
      await sleep(800);
      continue;
    }

    if (!waited && Date.now() - started > 2000) {
      waited = true;
      trace(`waiting for "${label}" … on screen now: ${visibleLabels(last, 12)}`);
    }

    if (Date.now() > deadline) {
      throw new Error(
        `could not find "${label}" within ${timeoutMs}ms.` +
        `\n  on screen: ${visibleLabels(last)}`,
      );
    }
    await sleep(500);
  }
}

module.exports = {dumpUi, findByText, visibleLabels, screenSize, swipeUp, tapText, sleep};
