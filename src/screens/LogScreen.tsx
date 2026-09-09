import React, {useState} from 'react';
import {ScrollView, StyleSheet} from 'react-native';
import {Btn, LogList, Section, Segmented} from '../ui/components';
import type {LogEntry} from '../hooks/useLog';

/*
 * 'Hard Key' rather than 'USB': this buffer carries traffic to and from a
 * PHYSICAL OnlyKey plugged into the phone, as against the soft key running
 * inside it. USB is how it is attached, not what it is.
 */
const SOURCES = ['Firmware', 'CTAP', 'Hard Key'] as const;
type Source = (typeof SOURCES)[number];

export type LogBuffers = Record<
  Source,
  {entries: LogEntry[]; clear: () => void}
>;

/**
 * Every log, in one place.
 *
 * One source at a time rather than a merged stream, because the three buffers
 * number their entries independently - there is no shared clock to interleave
 * them by, and interleaving on the formatted timestamp would silently reorder
 * anything that arrived inside the same second. A real merged view wants a
 * single buffer with a source tag, which is a change to useLog rather than to
 * this screen.
 */
export function LogScreen({buffers}: {buffers: LogBuffers}) {
  const [source, setSource] = useState<Source>('Firmware');
  const active = buffers[source];

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}>
      <Section
        title={source}
        right={<Btn title="Clear" onPress={active.clear} />}>
        <Segmented options={SOURCES} value={source} onChange={setSource} />
      </Section>
      <Section title="Traffic">
        <LogList entries={active.entries} />
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  content: {paddingBottom: 4},
});
