import type {CodegenTypes, TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';

/**
 * B7 "stands out without looking" (onlykey-edge build/okrn-edge-tab.md): a phone
 * notification for an Edge alarm - an alarm ticket, an ARM that did not match,
 * a press under a live budget, the refused-ARM count rising, a ticket owed past
 * 10 minutes - and a quiet notice for a budget used up or expired. One
 * notification per event; tapping it opens the app on that link.
 *
 * Stage 2 (option A, spec 2026-10-04): the JS side keeps watching with the app
 * in the background; the native side owns the notification (lock screen: only
 * "Edge alarm" and the budget), its Hold action (works from the lock screen)
 * and a heartbeat watchdog ("Edge watching stopped: open ok-rn").
 */
export interface Spec extends TurboModule {
  /**
   * Post (or replace) a notification for link `seq`. Title and text are plain
   * and shown after unlock; `lockText` is all the lock screen shows (the budget
   * id). `quiet`: a notice (budget spent/expired) on the low channel, no Hold.
   */
  post(seq: number, title: string, text: string, lockText: string, quiet: boolean): void;
  /** The link whose notification was tapped since the last call, then forgotten; -1 when none. */
  takeOpenedSeq(): number;
  /**
   * Part T: a Bluetooth pairing alarm (copy, revoke, expiry). Lock screen: only
   * "Bluetooth alarm". A tap opens the app with takeOpenedSeq() = BT_SEQ_BASE + id.
   */
  postBluetooth(id: number, text: string): void;
  /** The JS side is watching: call every 10 s. 30 s without one while watching -> the "stopped" notice. */
  beat(): void;
  /** Edge watching on (soft key running, unlocked, Edge present) or off (no "stopped" notice then). */
  setWatching(on: boolean): void;
  /** A Hold tapped while the JS side was not running, then forgotten. */
  takeHoldRequest(): boolean;
  /** A Hold tapped on a notification while the JS side is running. */
  readonly onHoldRequested: CodegenTypes.EventEmitter<void>;
  /*
   * The watcher's clock while watching, every 10 s. React Native pauses JS timers
   * when the app is in the background or the screen is off (the Pixel, 2026-10-04:
   * the beats stopped a minute after the screen went off); an event from native
   * still runs JS. The JS side beats and syncs on it.
   */
  readonly onWatchTick: CodegenTypes.EventEmitter<void>;
}

/*
 * get, not getEnforcing: alarms are an extra. On an APK built before this module
 * existed the app must still start (a frozen splash on the Pixel, 2026-10-04) -
 * it just posts no alarms.
 */
export default TurboModuleRegistry.get<Spec>('NativeEdgeAlert');
