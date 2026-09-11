import React, {useMemo, useState} from 'react';
import {ScrollView, StyleSheet, Text} from 'react-native';
import {Btn, LogList, Section, Segmented} from '../ui/components';
import {theme} from '../ui/theme';
import type {LogEntry} from '../hooks/useLog';
import {useBackend, useKeyName} from '../hooks/KeyContext';

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
 * THE CONSOLE is a view, not a fifth buffer.
 *
 * The firmware's debug console - what it prints on the SEREMU interface -
 * already lands in the active key's buffer as `[fw]` lines, between the hex
 * of every other interface. Reading it there means reading past the hex.
 * This view is the same buffer with only those lines, the tag stripped,
 * OLDEST FIRST, because a console is read top to bottom: the echo of a
 * press comes after the press.
 *
 * Output only, deliberately. The console is written to by the library's
 * press and probe paths, which know its grammar; a free-text box here would
 * be a way to send `0C` (wipe) by accident, and nothing above the wire has
 * a reason to want that.
 */
const VIEWS = [...SOURCES, 'Console'] as const;
type View = (typeof VIEWS)[number];

const FW_TAG = '[fw] ';

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
  const [view, setView] = useState<View>('Soft Key');
  const backend = useBackend();
  const keyName = useKeyName();

  /* The console is whichever key is active; the other sources are themselves. */
  const source: Source = view === 'Console'
    ? (backend === 'usb' ? 'Hard Key' : 'Soft Key')
    : view;
  const active = buffers[source];

  const consoleLines = useMemo(() => {
    if (view !== 'Console') return [];
    return active.entries
      .filter(e => e.text.startsWith(FW_TAG))
      .map(e => ({...e, text: e.text.slice(FW_TAG.length)}))
      .reverse();
  }, [active.entries, view]);

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}>
      <Section
        title={view === 'Console' ? `Console — ${keyName}` : view}
        right={<Btn title="Clear" onPress={active.clear} />}>
        <Segmented options={VIEWS} value={view} onChange={setView} />
        {view === 'Console' ? (
          <Text style={styles.hint}>
            What the {keyName}'s firmware prints on its debug console, oldest
            first. Read-only: presses and probes write to it through the
            library. Clear empties the {source} log, which this is a view of.
          </Text>
        ) : null}
      </Section>
      <Section title={view === 'Console' ? 'Output' : 'Traffic'}>
        {view === 'Console' && consoleLines.length === 0 ? (
          <Text style={styles.hint}>
            Nothing yet. A production build prints here too; only a developer
            build reads back.
          </Text>
        ) : (
          <LogList entries={view === 'Console' ? consoleLines : active.entries} />
        )}
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  content: {paddingBottom: 4},
  hint: {color: theme.textDim, fontSize: 12, lineHeight: 18, marginTop: 8},
});
