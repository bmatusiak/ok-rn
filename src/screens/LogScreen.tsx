import React, {useState} from 'react';
import {ScrollView, StyleSheet} from 'react-native';
import {Btn, LogList, Section, Segmented} from '../ui/components';
import type {LogEntry} from '../hooks/useLog';

/*
 * NAMED FOR THE DEVICE, not for the layer.
 *
 * "Firmware" was unambiguous while there was one key. It is not now - both
 * keys run firmware and both talk - so the two device logs say which device.
 *
 * And the buffer that used to be called 'Hard Key' was never a hard key's
 * firmware: it is the byte-level USB panel behind the Testing tab, which is a
 * different thing from a device session and now has a name that says so. The
 * hard key's own log took the name it had been borrowing.
 */
const SOURCES = ['Soft Key', 'Hard Key', 'CTAP', 'USB bytes'] as const;
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
  const [source, setSource] = useState<Source>('Soft Key');
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
