/*
 * R29 (okedge sync phase 2, P2b): "Your other keys" - the keys this key is
 * paired with, in the Edge Management drawer (Brad, 2026-10-05).
 *
 * Pairing starts on a computer (okedge sibling add) and shows a sheet on both
 * phones; UNPAIRING starts here and only here (spec, 2026-10-05): the list,
 * Remove, the person's Yes, then a PHYSICAL press, and the key links it
 * (sibling-remove). Each phone unpairs its own key - removing the Pixel on
 * the A13 leaves the Pixel's own list as it is.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {KeyboardAvoidingView, Modal, Platform, StyleSheet, Text, TextInput, View} from 'react-native';
import {request as requestLib} from 'node-onlykey-lib/edge';
import type {useEdge} from '../hooks/useEdge';
import {rememberSiblingName, siblingNames} from '../edgeSiblingNames';
import {consentRefusal} from '../debugGuard';
import {Btn, Section, Segmented} from './components';
import {ALARM_HOURS, alarmHours, lastAnchoredAt, reminderHours, setAlarmHours, stageOf} from '../edgeSiblingAlarm';
import {theme} from './theme';

type Row = {index: number; key: string; deviceId: string};
const MAX = 4;

export function EdgeSiblingsCard({edge}: {edge: ReturnType<typeof useEdge>}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  /* R30: when each key last synced here (its newest anchor), and the alarm setting */
  const [synced, setSynced] = useState<Record<string, number | null>>({});
  const [hours, setHours] = useState<number>(24);
  /* (a) the person names each key on THIS phone (Brad, 2026-10-05) - a label, kept here only */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const {siblings} = edge;

  const load = useCallback(async () => {
    try {
      const list = await siblings();
      setRows(list);
      setNames(await siblingNames());
      setHours(await alarmHours());
      const at: Record<string, number | null> = {};
      for (const r of list) at[r.key] = await lastAnchoredAt(r.deviceId).catch(() => null);
      setSynced(at);
      setError(null);
    } catch (e: any) {
      setError(`The key did not list them: ${e?.message ?? e}`);
    }
  }, [siblings]);
  /* again whenever the chain moves - a pairing or an unpairing is a link */
  useEffect(() => { void load(); }, [load, edge.view?.headSeq]);

  const nameOf = (r: Row) => names[r.key.toLowerCase()] ?? null;
  const pressing = rows?.find(r => edge.pressFor === `sibling:${r.index}`) ?? null;

  return (
    <Section title={`Your other keys${rows ? ` (${rows.length} of ${MAX})` : ''}`}>
      <Text style={styles.dim}>
        Keys of yours paired with this one, each with a press. Pair from a computer (okedge sibling add); unpair here. Unpairing here leaves the other phone's list as it is - unpair there too.
      </Text>
      {error ? <Text style={[styles.op, {color: theme.error}]}>{error}</Text> : null}
      {rows && !rows.length ? <Text style={styles.dim}>None paired yet.</Text> : null}
      {rows && rows.length ? (
        <>
          <Text style={[styles.dim, {marginTop: 8}]}>{`Alarm when a key has not synced for ${hours} h (a reminder at ${reminderHours(hours)} h). Nothing syncs on its own: a sync is your Yes and press on each phone.`}</Text>
          <Segmented
            options={ALARM_HOURS.map(h => `${h} h`) as unknown as readonly string[]}
            value={`${hours} h`}
            onChange={(v: string) => { const h = parseInt(v, 10); setHours(h); void setAlarmHours(h); }}
          />
        </>
      ) : null}
      {(rows ?? []).map(r => (
        <View key={r.key} style={styles.item}>
          <Text style={styles.op}>{nameOf(r) ?? `Key ${requestLib.fingerprint(r.key)}`}</Text>
          {nameOf(r) ? <Text style={styles.dim}>{`Key ${requestLib.fingerprint(r.key)}`}</Text> : null}
          <Text style={styles.dim}>{`Device ${r.deviceId.slice(0, 8)}…${r.deviceId.slice(-8)}`}</Text>
          {(() => {
            const at = synced[r.key];
            if (at === undefined) return null;
            if (at === null) return <Text style={styles.dim}>Not synced with this key yet</Text>;
            const age = Date.now() - at;
            const stage = stageOf(age, hours);
            const h = Math.floor(age / 3600_000);
            return <Text style={[styles.dim, stage === 2 ? {color: theme.error} : stage === 1 ? {color: theme.warn} : null]}>{`Last synced ${h ? `${h} h` : `${Math.max(1, Math.round(age / 60_000))} min`} ago${stage === 2 ? ' - sync now' : stage === 1 ? ' - a sync is due' : ''}`}</Text>;
          })()}
          {pressing && pressing.index === r.index ? (
            <>
              <Text style={[styles.op, {color: theme.warn}]}>Press the key to unpair</Text>
              {consentRefusal() ? <Text style={[styles.op, {color: theme.error}]}>{consentRefusal()}</Text> : null}
              <View style={styles.row}>
                <Btn title="Press the soft key" tone="primary" disabled={consentRefusal() !== null} onPress={() => { if (!consentRefusal()) void edge.press(); }} />
              </View>
            </>
          ) : confirming === r.index ? (
            <>
              <Text style={[styles.op, {color: theme.warn}]}>{`Unpair ${nameOf(r) ?? 'this key'}?`}</Text>
              <Text style={styles.dim}>The key records it in the chain. It needs a press.</Text>
              {consentRefusal() ? <Text style={[styles.op, {color: theme.error}]}>{consentRefusal()}</Text> : null}
              <View style={styles.row}>
                <Btn
                  title="Unpair"
                  tone="danger"
                  disabled={edge.busy || consentRefusal() !== null}
                  onPress={() => {
                    if (consentRefusal()) return;
                    setConfirming(null);
                    void edge.removeSibling(r.index).then(load);
                  }}
                />
                <Btn title="Cancel" onPress={() => setConfirming(null)} disabled={edge.busy} />
              </View>
            </>
          ) : (
            <View style={styles.row}>
              <Btn title="Rename…" onPress={() => { setDraft(nameOf(r) ?? ''); setRenaming(r.key); }} disabled={pressing !== null} />
              <Btn title="Remove…" onPress={() => setConfirming(r.index)} disabled={edge.busy || pressing !== null} />
            </View>
          )}
        </View>
      ))}
      {/*
        * The rename box is its own small dialog, kept above the keyboard: inline
        * in the drawer, the keyboard covered the field and the drawer scrolled
        * away from it (found on the Pixel, 2026-10-05).
        */}
      <Modal transparent animationType="fade" visible={renaming !== null} onRequestClose={() => setRenaming(null)}>
        <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={styles.dialog}>
            <Text style={styles.op}>Name this key</Text>
            <Text style={styles.dim}>{`Key ${renaming ? requestLib.fingerprint(renaming) : ''} - the name is kept on this phone only.`}</Text>
            <TextInput style={styles.input} value={draft} onChangeText={setDraft} placeholder="A name for this key" placeholderTextColor={theme.textDim} maxLength={64} autoFocus />
            <View style={styles.row}>
              <Btn
                title="Save"
                tone="primary"
                disabled={!draft.trim()}
                onPress={() => {
                  /* shown at once - the list does not wait on a key read to show the new name */
                  if (renaming) {
                    const key = renaming.toLowerCase();
                    setNames(n => ({...n, [key]: draft.trim()}));
                    void rememberSiblingName(key, draft.trim());
                  }
                  setRenaming(null);
                }}
              />
              <Btn title="Cancel" onPress={() => setRenaming(null)} />
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </Section>
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
