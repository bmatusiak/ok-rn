/*
 * THE APPROVE SHEET FOR A SYNC (Brad, 2026-10-08): "sync with Approve sheet, however the
 * approve sheet should not be displayed automatically, we need to add a banner at the top
 * of edge tab to open it"; "the Approve sheet will show the list of devices in the merge,
 * we should hold these blocks in the app until approved and merged".
 *
 * Opened only from the Edge tab's banner. One row per held device log (edgeDevices
 * reviewHeld, sorted by the lib with this key's owner key), and the held Key Chain list.
 * Nothing here needs the key's press: pairing and sync are all app.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {Modal, ScrollView, StyleSheet, Text, View} from 'react-native';
import {approveHeld, approveKeychain, declineHeld, declineKeychain, heldKeychain, notMine, onDevicesChanged, reviewHeld, type HeldKeychain, type HeldView} from '../edgeDevices';
import {keepMergedKeyChain} from '../keyChainRecorder';
import {consentRefusal} from '../debugGuard';
import {netTag} from '../net';
import {Btn} from './components';
import {theme} from './theme';

const short = (id: string) => `${id.slice(0, 8)}…${id.slice(-8)}`;

export function MergeSheet({visible, onClose}: {visible: boolean; onClose: () => void}) {
  const [rows, setRows] = useState<HeldView[]>([]);
  const [kc, setKc] = useState<HeldKeychain | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(async () => {
    setRows(await reviewHeld());
    setKc(await heldKeychain());
  }, []);
  useEffect(() => { if (visible) { setNote(null); void load(); } }, [visible, load]);
  useEffect(() => onDevicesChanged(() => { void load(); }), [load]);

  const act = (f: () => Promise<unknown>, done: string) => async () => {
    if (consentRefusal()) { setNote(consentRefusal()); return; }
    setBusy(true);
    try {
      await f();
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
    <Modal transparent animationType="slide" visible={visible} onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <ScrollView>
            <Text style={styles.title}>{netTag() + 'Sync wants to merge new devices'}</Text>
            <Text style={styles.dim}>Logs a computer brought, held on this phone until you answer. A log made with your OnlyKey shows its device's own nametag; nothing merges until you approve it.</Text>
            {waiting.map(r => (
              <View key={r.deviceId} style={styles.item}>
                <Text style={styles.op}>{r.nametag ?? `"${r.claimed}"`}</Text>
                <Text style={styles.dim}>{`Device ${short(r.deviceId)} · ${r.count} link${r.count === 1 ? '' : 's'} · from ${r.from}`}</Text>
                {r.class === 'forged' ? (
                  <>
                    <Text style={[styles.op, {color: theme.error}]}>Not made with your OnlyKey - this computer sent a forged log. Kept as evidence, never merged.</Text>
                    <View style={styles.row}><Btn title="Keep as evidence" onPress={act(() => declineHeld(r.deviceId), 'Kept as evidence.')} disabled={busy} /></View>
                  </>
                ) : !r.checkOk ? (
                  <>
                    <Text style={[styles.op, {color: theme.error}]}>{`Made with your OnlyKey, but its chain does not check (${r.alarm}). Kept, not merged.`}</Text>
                    <View style={styles.row}><Btn title="Keep as evidence" onPress={act(() => declineHeld(r.deviceId), 'Kept as evidence.')} disabled={busy} /></View>
                  </>
                ) : r.class === 'mine-new' ? (
                  <>
                    <Text style={[styles.op, {color: theme.warn}]}>A device made with your OnlyKey appeared. Is it yours?</Text>
                    <View style={styles.row}>
                      <Btn title="Yes, it's mine - merge" tone="primary" onPress={act(() => approveHeld(r.deviceId, {isMine: true}), `Merged "${r.nametag}".`)} disabled={busy} />
                      <Btn title="No" tone="danger" onPress={act(() => notMine(r.deviceId), 'Alarm raised: someone else holds your OnlyKey. The log is kept as evidence.')} disabled={busy} />
                    </View>
                  </>
                ) : (
                  <View style={styles.row}>
                    <Btn title="Approve - merge" tone="primary" onPress={act(() => approveHeld(r.deviceId), `Merged "${r.nametag}".`)} disabled={busy} />
                    <Btn title="Decline" onPress={act(() => declineHeld(r.deviceId), 'Declined - kept, not merged.')} disabled={busy} />
                  </View>
                )}
              </View>
            ))}
            {kc ? (
              <View style={styles.item}>
                <Text style={styles.op}>Key Chain list</Text>
                <Text style={styles.dim}>{`From ${kc.from}: ${kc.in} entr${kc.in === 1 ? 'y' : 'ies'} this phone does not have yet.`}</Text>
                <View style={styles.row}>
                  <Btn title="Approve - merge" tone="primary" onPress={act(() => approveKeychain(keepMergedKeyChain), 'Key Chain list merged.')} disabled={busy} />
                  <Btn title="Decline" onPress={act(() => declineKeychain(), 'Key Chain list declined.')} disabled={busy} />
                </View>
              </View>
            ) : null}
            {!waiting.length && !kc ? <Text style={[styles.op, {marginTop: 12}]}>Nothing waits to be merged.</Text> : null}
            {kept ? <Text style={[styles.dim, {marginTop: 12}]}>{`${kept} log${kept === 1 ? '' : 's'} kept as evidence on this phone.`}</Text> : null}
            {note ? <Text style={[styles.op, {marginTop: 10}]}>{note}</Text> : null}
            <View style={[styles.row, {marginTop: 14}]}><Btn title="Close" onPress={onClose} /></View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end'},
  sheet: {backgroundColor: theme.surface, borderTopLeftRadius: 16, borderTopRightRadius: 16, borderTopWidth: 2, borderTopColor: theme.warn, padding: 16, maxHeight: '88%'},
  title: {color: theme.text, fontSize: 17, fontWeight: '600', marginBottom: 6},
  op: {color: theme.text, fontSize: 14, lineHeight: 20},
  dim: {color: theme.textDim, fontSize: 13, lineHeight: 19},
  row: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6},
  item: {marginTop: 12, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border},
});
