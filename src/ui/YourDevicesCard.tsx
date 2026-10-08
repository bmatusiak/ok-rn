/*
 * THIS PHONE AND YOUR DEVICES, in the Edge Management drawer (Brad, 2026-10-08: the nametag
 * is set "in the Edge Management drawer"; a device gives "its own name for its device
 * fingerprint in the block"; "find a way to fix multi names for the same device").
 *
 * This phone: its nametag, signed by its key's owner key (no press, no link) and carried
 * with its log to your other devices. Your devices: each device whose log you approved,
 * by its own newest nametag (older ones "previously"), its fingerprint, how far it is
 * merged. Forget takes it off this phone's list; its copy stays.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {KeyboardAvoidingView, Modal, Platform, StyleSheet, Text, TextInput, View} from 'react-native';
import {grants} from 'node-onlykey-lib/edge';
import {forgetDevice, onDevicesChanged, ownStatement, setNametag, type StoredStatement} from '../edgeDevices';
import {SoftKeyEdge} from '../edgeSoftKey';
import {useYourDevices} from '../hooks/useYourDevices';
import {Btn, Section} from './components';
import {theme} from './theme';

const short = (id: string) => `${id.slice(0, 8)}…${id.slice(-8)}`;

export function YourDevicesCard({headSeq}: {headSeq: number | null | undefined}) {
  const [own, setOwn] = useState<StoredStatement | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const devices = useYourDevices(headSeq);
  const load = useCallback(async () => setOwn(await ownStatement()), []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => onDevicesChanged(() => { void load(); }), [load]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      grants.nametagHash(draft); /* the same rule the key signs under: 1 to 64 characters */
      const soft = await SoftKeyEdge.open();
      if (!soft) throw new Error('the key did not answer - is it unlocked?');
      setOwn(await setNametag(soft, draft.trim()));
      setEditing(false);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Section title="This phone">
        <Text style={styles.op}>{own ? own.nametag : 'No nametag yet'}</Text>
        {own ? <Text style={styles.dim}>{`Device ${short(own.deviceId)}`}</Text> : null}
        <Text style={styles.dim}>Your other devices see this phone by its nametag. The key signs it; no press.</Text>
        {error ? <Text style={[styles.op, {color: theme.error}]}>{error}</Text> : null}
        <View style={styles.row}>
          <Btn title={own ? 'Change nametag…' : 'Set nametag…'} onPress={() => { setDraft(own?.nametag ?? ''); setEditing(true); }} disabled={busy} />
        </View>
      </Section>
      <Section title={`Your devices${devices.length ? ` (${devices.length})` : ''}`}>
        {!devices.length ? <Text style={styles.dim}>None yet. A computer's sync brings your other devices' logs; you approve each from the banner at the top of this tab.</Text> : null}
        {devices.map(d => (
          <View key={d.deviceId} style={styles.item}>
            <Text style={styles.op}>{d.nametag ?? `Device ${short(d.deviceId)}`}</Text>
            {d.previously.length ? <Text style={styles.dim}>{`Previously: ${d.previously.join(', ')}`}</Text> : null}
            <Text style={styles.dim}>{`Device ${short(d.deviceId)}${d.mergedUpTo !== null ? ` · merged up to #${d.mergedUpTo}` : ''}${d.mergedAt ? ` · ${new Date(d.mergedAt).toLocaleString()}` : ''}`}</Text>
            {confirming === d.deviceId ? (
              <View style={styles.row}>
                <Btn title="Forget" tone="danger" onPress={() => { setConfirming(null); void forgetDevice(d.deviceId); }} />
                <Btn title="Cancel" onPress={() => setConfirming(null)} />
              </View>
            ) : (
              <View style={styles.row}><Btn title="Forget…" onPress={() => setConfirming(d.deviceId)} /></View>
            )}
          </View>
        ))}
      </Section>
      {/* its own small dialog, above the keyboard (the drawer scrolled away from an inline field - Pixel, 2026-10-05) */}
      <Modal transparent animationType="fade" visible={editing} onRequestClose={() => setEditing(false)}>
        <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={styles.dialog}>
            <Text style={styles.op}>This phone's nametag</Text>
            <Text style={styles.dim}>A name or a tag your other devices will see for this phone.</Text>
            <TextInput style={styles.input} value={draft} onChangeText={setDraft} placeholder="e.g. A13" placeholderTextColor={theme.textDim} maxLength={64} autoFocus />
            {error ? <Text style={[styles.op, {color: theme.error}]}>{error}</Text> : null}
            <View style={styles.row}>
              <Btn title="Save" tone="primary" disabled={!draft.trim() || busy} onPress={() => { void save(); }} />
              <Btn title="Cancel" onPress={() => setEditing(false)} />
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  op: {color: theme.text, fontSize: 14, lineHeight: 20},
  dim: {color: theme.textDim, fontSize: 13, lineHeight: 19},
  row: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6},
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 16},
  dialog: {backgroundColor: theme.surface, borderRadius: 12, padding: 16},
  input: {color: theme.text, borderWidth: 1, borderColor: theme.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, marginTop: 6, fontSize: 15},
  item: {marginTop: 10, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border},
});
