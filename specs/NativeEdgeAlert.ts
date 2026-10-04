import type {TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';

/**
 * B7 "stands out without looking" (onlykey-edge build/okrn-edge-tab.md): a phone
 * notification for an Edge alarm - an alarm ticket, an ARM that did not match,
 * a press under a live budget, a budget spent or expired. One notification per
 * link, on its own channel; tapping it opens the app on that link.
 */
export interface Spec extends TurboModule {
  /** Post (or replace) the alarm for link `seq`. Title and text are plain; the agent's words never go in them. */
  post(seq: number, title: string, text: string): void;
  /** The link whose notification was tapped since the last call, then forgotten; -1 when none. */
  takeOpenedSeq(): number;
}

/*
 * get, not getEnforcing: alarms are an extra. On an APK built before this module
 * existed the app must still start (a frozen splash on the Pixel, 2026-10-04) -
 * it just posts no alarms.
 */
export default TurboModuleRegistry.get<Spec>('NativeEdgeAlert');
