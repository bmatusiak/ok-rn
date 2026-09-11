import React, {useCallback, useEffect, useState} from 'react';
import {ActivityIndicator, ScrollView, StyleSheet, Text, View} from 'react-native';
import {Btn} from '../ui/components';
import {SlotGrid} from '../ui/SlotGrid';
import {DuoSlotGrid} from '../ui/DuoSlotGrid';
import {theme} from '../ui/theme';
import {useActiveKey, useKeyName} from '../hooks/KeyContext';
import {device as okdevice} from 'node-onlykey-lib';

/*
 * Slots, as the device's own shape rather than as a list.
 *
 * The grid is the point: 1a and 1b sit left of the top row because button 1 is
 * top-left on the key, so the layout answers "which button do I press" without
 * a legend. That is the desktop app's design and the reason the photo is here.
 *
 * WHAT THE DEVICE WILL AND WILL NOT TELL US is the other thing this screen has
 * to get across. Labels are the only slot data any client can read back; a URL,
 * username or password can only be obtained by asking the key to TYPE it. So an
 * unlabelled slot is not an empty one, and saying "empty" - which is what this
 * app used to say - invites exactly the wrong conclusion.
 */
export function SlotsScreen({
  onOpen,
}: {
  onOpen: (slot: {id: string; index: number}) => void;
}) {
  /* The ACTIVE key, not whichever one this file used to assume. */
  const getKey = useActiveKey();
  /* Named in every panel that states a fact about it. See useKeyName. */
  const keyName = useKeyName();

  const [labels, setLabels] = useState<(string | null)[] | null>(null);
  /*
   * HOW MANY SLOTS is a fact about the model, and the library knows it:
   * a Classic has 12, a DUO 24. This screen said 12 in a literal, which
   * drew a DUO as a Classic and hid half its slots without a word. The
   * grid itself still draws the Classic picture; a DUO gets the honest
   * note below until its own layout exists.
   */
  const [count, setCount] = useState<number>(okdevice.slots.SLOT_COUNT[okdevice.slots.DEVICE_TYPE.CLASSIC]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const {device} = await getKey();
      setCount(okdevice.slots.SLOT_COUNT[device.deviceType] ?? count);
      const {labels: got} = await device.readLabels({timeoutMs: 10000});
      setLabels(got);
    } catch (e) {
      /*
       * The device answers a label read with silence while locked, so the
       * library's error already says "probably locked; call unlock() first".
       * Shown as-is rather than replaced with "failed to load".
       */
      setError(String((e as Error)?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [getKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}>
      <View style={styles.header}>
        <Text style={styles.title}>{`Slots — ${keyName}`}</Text>
        <Btn title={loading ? '…' : 'Refresh'} disabled={loading} onPress={refresh} />
      </View>

      <Text style={styles.intro}>
        Each button holds two slots — a and b. A tap types the a slot; a hold
        types the b slot.
      </Text>

      {loading && labels === null ? (
        <ActivityIndicator color={theme.textDim} style={styles.spinner} />
      ) : error ? (
        <Text style={styles.error}>{error}</Text>
      ) : (
        count > 12 ? (
          /* A DUO: three buttons, four profiles, no picture yet. See DuoSlotGrid. */
          <DuoSlotGrid labels={labels ?? new Array(count).fill(null)} onSelect={onOpen} />
        ) : (
          <SlotGrid labels={labels ?? new Array(count).fill(null)} onSelect={onOpen} />
        )
      )}

      <Text style={styles.note}>
        Only labels ever leave the key. A slot shown as “no label” may still
        hold a login — the app cannot see what is in it until the key is asked
        to type it.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  content: {padding: 16, gap: 16, paddingBottom: 32},

  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  title: {color: theme.text, fontSize: 20, fontWeight: '700'},

  intro: {color: theme.textSecondary, fontSize: theme.fontSize, lineHeight: theme.lineHeight},
  note: {color: theme.textDim, fontSize: 13, lineHeight: 20},

  error: {color: theme.error, fontSize: 13, lineHeight: 20},
  spinner: {paddingVertical: 32},
});
