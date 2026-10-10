/**
 * Whether the SOFT KEY's firmware is waiting for you to confirm a request that
 * came over the API (a sign, decrypt, HMAC or Edge approval) - the phone's
 * counterpart of the prompt CTAP already gets (owner, 2026-10-02: "add the
 * panel like ctap"). Without it the key waited silently: the ssh practice timed
 * out twice because nothing on the phone said a press was wanted.
 *
 * READ FROM THE FIRMWARE ITSELF (OkEmu.waiting -> okemu_jni.cpp
 * nativeConfirmState), polled while it can matter: the soft key is the active
 * key and running, and the app is in front. The vendor bridge stays a plain
 * pipe - it never parses what passes through it.
 */
import {useEffect, useState} from 'react';
import {AppState} from 'react-native';
import OkEmu, {type KeyWaiting} from '../transport/OkEmu';

const POLL_MS = 400;

/*
 * A WAIT THAT OUTLIVES THE FIRMWARE'S OWN WINDOW IS WRITTEN DOWN. The A13
 * (2026-10-04) kept "Confirm on your key" for an ssh sign after the computer
 * was gone; a press did nothing and only an app restart cleared it. The Pixel
 * could not reproduce it (dropped link, held link: both cleared at the 20 s
 * window, 2026-10-05). The firmware closes every wait after 20 s
 * (okcore.cpp Usertimeout), so one still open at 30 s is that bug: the log says
 * what it waited for and how long, so the next time leaves data. Nothing here is
 * sensitive - an opcode, a slot, a mode - so a production build logs it too.
 */
export const STUCK_MS = 30_000;

export function createStuckWatch(log: (line: string) => void, stuckMs = STUCK_MS) {
  let current: KeyWaiting | null = null;
  let since = 0;
  let reported = false;
  return (w: KeyWaiting | null, now: number) => {
    if (!same(current, w)) {
      if (reported && current) log(`[keyWaiting] the stuck wait ended after ${Math.round((now - since) / 1000)} s`);
      current = w;
      since = now;
      reported = false;
      return;
    }
    if (w && !reported && now - since >= stuckMs) {
      reported = true;
      log(`[keyWaiting] still waiting after ${Math.round((now - since) / 1000)} s (the firmware's window is 20 s): ${w.what} opcode 0x${w.opcode.toString(16)} slot ${w.slot} mode ${w.mode} entered ${w.entered}`);
    }
  };
}

export function useKeyWaiting(enabled: boolean): KeyWaiting | null {
  const [waiting, setWaiting] = useState<KeyWaiting | null>(null);
  useEffect(() => {
    if (!enabled) {
      setWaiting(null);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const watch = createStuckWatch(line => console.warn(line));
    const tick = async () => {
      if (!alive) return;
      if (AppState.currentState === 'active') {
        try {
          const w = await OkEmu.waiting();
          watch(w, Date.now());
          if (alive) setWaiting(prev => (same(prev, w) ? prev : w));
        } catch {
          if (alive) setWaiting(null);
        }
      }
      if (alive) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [enabled]);
  return waiting;
}

/* a new object every poll would re-render every tab 2.5 times a second */
function same(a: KeyWaiting | null, b: KeyWaiting | null): boolean {
  if (a === null || b === null) return a === b;
  return a.what === b.what && a.opcode === b.opcode && a.slot === b.slot && a.mode === b.mode && a.entered === b.entered;
}

/** What the request is for, in the words the banner uses. */
export function describeWaiting(w: KeyWaiting): string {
  const slot =
    w.slot >= 1 && w.slot <= 4 ? `RSA slot ${w.slot}` :
    w.slot >= 101 && w.slot <= 116 ? `ECC slot ${w.slot - 100}` :
    w.slot === 128 ? 'a web or agent derived key' :
    w.slot > 200 ? 'a derived key (the ssh / gpg agent)' : `slot ${w.slot}`;
  switch (w.what) {
    case 'sign': return `A program on the computer is asking the key to sign with ${slot}.`;
    case 'decrypt': return `A program on the computer is asking the key to decrypt with ${slot}.`;
    case 'hmac': return 'A program on the computer is asking the key for an HMAC challenge-response.';
    case 'edge': return 'Edge is waiting for your approval (a budget, a resume, a settle, a restore, a loss, the registration of an agent, a place that keeps copies, a sync, or pairing another key of yours).';
    default: return 'A program on the computer is waiting for the key.';
  }
}
