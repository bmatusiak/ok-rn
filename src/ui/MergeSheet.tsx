/*
 * THE APPROVE SHEET FOR A SYNC (Brad, 2026-10-08): "sync with Approve sheet, however the
 * approve sheet should not be displayed automatically, we need to add a banner at the top
 * of edge tab to open it"; "the Approve sheet will show the list of devices in the merge,
 * we should hold these blocks in the app until approved and merged".
 *
 * Opened only from the Edge tab's banner. One row per held device log (edgeDevices
 * reviewHeld, sorted by the lib with this key's owner key). The Key Chain list is not here:
 * it is the Key Chain plugin's (Brad, 2026-10-08: "Move it out of Edge").
 * Nothing here needs the key's press: pairing and sync are all app.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {approveHeld, declineHeld, notMine, onDevicesChanged, reviewHeld, type HeldView} from '../edgeDevices';
import {consentRefusal} from '../debugGuard';
import {netTag} from '../net';
import {Btn} from './components';
import {Sheet} from './Sheet';
import {theme} from './theme';

const short = (id: string) => `${id.slice(0, 8)}…${id.slice(-8)}`;

export function MergeSheet({visible, onClose}: {visible: boolean; onClose: () => void}) {
  /* the system bars (the A13's 3-button bar once covered this sheet's Close) are the Sheet's job */
  const [rows, setRows] = useState<HeldView[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /*
   * THE ANSWER SHOWS AT ONCE (two-phone testnet walk, 2026-10-11: after "Keep as evidence" the
   * row and its button stayed, and the evidence count stayed at 1, for seconds). reviewHeld
   * re-checks every held log - the classify, the completeness check, the ML-DSA signatures -
   * which takes seconds on a phone, so the list drawn before the answer stayed until it ended.
   * Now the answered row changes here as soon as the store has it, and the full re-check
   * follows. Loads overlap (the change notice and the action each start one); only the newest
   * one is drawn.
   */
  const loads = useRef(0);
  const load = useCallback(async () => {
    const n = ++loads.current;
    const fresh = await reviewHeld();
    if (n === loads.current) setRows(fresh);
  }, []);
  useEffect(() => { if (visible) { setNote(null); void load(); } }, [visible, load]);
  useEffect(() => onDevicesChanged(() => { void load(); }), [load]);

  const act = (f: () => Promise<unknown>, done: string, deviceId: string, as: 'declined' | 'leak' | 'merged') => async () => {
    if (consentRefusal()) { setNote(consentRefusal()); return; }
    setBusy(true);
    try {
      await f();
      setRows(now => (as === 'merged' ? now.filter(r => r.deviceId !== deviceId) : now.map(r => (r.deviceId === deviceId ? {...r, [as]: true} : r))));
      setNote(done);
    } catch (e: any) {
      setNote(String(e?.message ?? e));
    } finally {
      setBusy(false);
      void load();
    }
  };

  const waiting = rows.filter(r => !r.declined && !r.leak);
  const kept = rows.length - waiting.length;
  return (
    <Sheet visible={visible} tone="edge" title={netTag() + 'Sync wants to merge new devices'} titleColor={theme.text} onClose={onClose} footer={<Btn title="Close" onPress={onClose} />}>
            <Text style={styles.dim}>Logs a computer brought, held on this phone until you answer. A log made with your OnlyKey shows its device's own nametag; nothing merges until you approve it.</Text>
            {waiting.map(r => (
              <View key={r.deviceId} style={styles.item}>
                <Text style={styles.op}>{r.nametag ?? `"${r.claimed}"`}</Text>
                {/* from the DEVICE that made the blocks (Brad, 2026-10-08: "the nitro16 didnt make the blocks so it should say from pixel"); only a forged log names the computer that sent it */}
                <Text style={styles.dim}>{`${r.count} link${r.count === 1 ? '' : 's'} · from ${r.class === 'forged' ? `the computer ${r.from}` : r.nametag ?? `device ${short(r.deviceId)}`} · device ${short(r.deviceId)}`}</Text>
                {r.class === 'forged' ? (
                  <>
                    <Text style={[styles.op, {color: theme.error}]}>Not made with your OnlyKey - this computer sent a forged log. Kept as evidence, never merged.</Text>
                    <View style={styles.row}><Btn title="Keep as evidence" onPress={act(() => declineHeld(r.deviceId), 'Kept as evidence.', r.deviceId, 'declined')} disabled={busy} /></View>
                  </>
                ) : !r.complete ? (
                  <>
                    {/* complete before it is merged (Brad, 2026-10-09): every use of the credential, with its result */}
                    <Text style={[styles.op, {color: theme.error}]}>{`Not complete - nothing merged. ${r.missing.slice(0, 4).join('; ')}${r.missing.length > 4 ? ` (+${r.missing.length - 4} more)` : ''}`}</Text>
                    <View style={styles.row}><Btn title="Decline" onPress={act(() => declineHeld(r.deviceId), 'Declined - kept, not merged.', r.deviceId, 'declined')} disabled={busy} /></View>
                  </>
                ) : !r.checkOk ? (
                  <>
                    <Text style={[styles.op, {color: theme.error}]}>{`Made with your OnlyKey, but its chain does not check (${r.alarm}). Kept, not merged.`}</Text>
                    <View style={styles.row}><Btn title="Keep as evidence" onPress={act(() => declineHeld(r.deviceId), 'Kept as evidence.', r.deviceId, 'declined')} disabled={busy} /></View>
                  </>
                ) : r.class === 'mine-new' ? (
                  <>
                    <Text style={[styles.op, {color: theme.warn}]}>A device made with your OnlyKey appeared. Is it yours?</Text>
                    <View style={styles.row}>
                      <Btn title="Yes, it's mine - merge" tone="primary" onPress={act(() => approveHeld(r.deviceId, {isMine: true}), `Merged "${r.nametag}".`, r.deviceId, 'merged')} disabled={busy} />
                      <Btn title="No" tone="danger" onPress={act(() => notMine(r.deviceId), 'Alarm raised: someone else holds your OnlyKey. The log is kept as evidence.', r.deviceId, 'leak')} disabled={busy} />
                    </View>
                  </>
                ) : (
                  <View style={styles.row}>
                    <Btn title="Approve - merge" tone="primary" onPress={act(() => approveHeld(r.deviceId), `Merged "${r.nametag}".`, r.deviceId, 'merged')} disabled={busy} />
                    <Btn title="Decline" onPress={act(() => declineHeld(r.deviceId), 'Declined - kept, not merged.', r.deviceId, 'declined')} disabled={busy} />
                  </View>
                )}
              </View>
            ))}
            {!waiting.length ? <Text style={[styles.op, {marginTop: 12}]}>Nothing waits to be merged.</Text> : null}
            {kept ? <Text style={[styles.dim, {marginTop: 12}]}>{`${kept} log${kept === 1 ? '' : 's'} kept as evidence on this phone.`}</Text> : null}
            {note ? <Text style={[styles.op, {marginTop: 10}]}>{note}</Text> : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  op: {color: theme.text, fontSize: 14, lineHeight: 20},
  dim: {color: theme.textDim, fontSize: 13, lineHeight: 19},
  row: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6},
  item: {marginTop: 12, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border},
});
