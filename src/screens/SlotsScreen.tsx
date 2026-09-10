import React, {useCallback, useEffect, useState} from 'react';
import {ActivityIndicator, ScrollView, StyleSheet, Text, View} from 'react-native';
import {Btn} from '../ui/components';
import {SlotGrid} from '../ui/SlotGrid';
import {theme} from '../ui/theme';
import {useActiveKey} from '../hooks/KeyContext';

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

  const [labels, setLabels] = useState<(string | null)[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const {device} = await getKey();
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
        <Text style={styles.title}>Slots</Text>
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
        <SlotGrid labels={labels ?? new Array(12).fill(null)} onSelect={onOpen} />
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
