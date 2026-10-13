/**
 * EdgeList - a TRUE scrolling list, edge of the screen to edge (Brad,
 * 2026-10-04: "a TRUE scrollable list, edge of screen to edge" - "re-usable").
 * One FlatList for the whole screen: no card boxes, no side margins, rows
 * separated by a hairline, virtualised so a long history stays smooth.
 *
 * Any screen can use it. Items are either a plain row (title, subtitle,
 * detail, a right-hand note, a tone, an indent - drawn here) or a node (the
 * screen draws it: a banner, a budget with its buttons). Section headers stick
 * to the top while their rows scroll. `bottomInset` leaves room for a drawer
 * handle (src/ui/BottomDrawer.tsx) so the last row is never under it.
 */
import React from 'react';
import {FlatList, Pressable, RefreshControl, StyleSheet, Text, View} from 'react-native';
import {theme} from './theme';

export type EdgeListTone = 'normal' | 'dim' | 'warn' | 'alarm' | 'ok';

export type EdgeListItem =
  | {key: string; kind: 'section'; title: string; right?: string}
  | {
      key: string;
      kind: 'row';
      title: string;
      subtitle?: string;
      detail?: string;
      /* the detail line's colour (Guest Book's "offered in key swaps" is green) */
      detailTone?: EdgeListTone;
      right?: string;
      tone?: EdgeListTone;
      /* 1 = hangs under the row above (a receipt under its use) */
      indent?: number;
      onPress?: () => void;
      /* a second action set on a row (the Passwords list: Copy / Type without opening the entry) */
      onLongPress?: () => void;
      accessibilityLabel?: string;
    }
  /*
   * bare: the screen's node draws its own padding and border (a row it already has).
   * onPress / onLongPress: a node that acts as a row (a row whose content updates by itself, e.g.
   * an authenticator code with its time bar).
   */
  | {key: string; kind: 'node'; render: () => React.ReactNode; bare?: boolean; onPress?: () => void; onLongPress?: () => void; accessibilityLabel?: string};

const toneColor = (t: EdgeListTone | undefined) =>
  t === 'alarm' ? theme.error : t === 'warn' ? theme.warn : t === 'ok' ? theme.ok : t === 'dim' ? theme.textDim : theme.text;

function Row({item}: {item: Extract<EdgeListItem, {kind: 'row'}>}) {
  const body = (
    <View style={[styles.row, item.indent ? {paddingLeft: 16 + 20 * item.indent} : null, item.tone === 'alarm' && styles.alarm]}>
      <View style={styles.main}>
        <Text style={[styles.title, {color: toneColor(item.tone)}]}>{item.title}</Text>
        {item.subtitle ? <Text style={styles.subtitle}>{item.subtitle}</Text> : null}
        {item.detail ? <Text style={[styles.detail, item.detailTone ? {color: toneColor(item.detailTone)} : null]}>{item.detail}</Text> : null}
      </View>
      {item.right ? <Text style={styles.right}>{item.right}</Text> : null}
    </View>
  );
  return item.onPress || item.onLongPress ? (
    <Pressable onPress={item.onPress} onLongPress={item.onLongPress} accessibilityRole="button" accessibilityLabel={item.accessibilityLabel ?? item.title}
      style={({pressed}) => (pressed ? styles.pressed : null)}>
      {body}
    </Pressable>
  ) : (
    body
  );
}

export function EdgeList({
  items,
  bottomInset = 0,
  refreshing,
  onRefresh,
  empty,
}: {
  items: EdgeListItem[];
  /* room for a drawer handle below the list */
  bottomInset?: number;
  refreshing?: boolean;
  onRefresh?: () => void;
  /* shown when there are no items */
  empty?: string;
}) {
  const sticky = items.map((it, i) => (it.kind === 'section' ? i : -1)).filter(i => i >= 0);
  return (
    <FlatList
      style={styles.list}
      data={items}
      keyExtractor={it => it.key}
      stickyHeaderIndices={sticky}
      contentContainerStyle={{paddingBottom: bottomInset}}
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} /> : undefined}
      ListEmptyComponent={empty ? <Text style={[styles.subtitle, {padding: 16}]}>{empty}</Text> : undefined}
      renderItem={({item}) => <EdgeListEntry item={item} />}
      /*
       * No off-screen clipping (FlatList's Android default is on). Seen on the Pixel 2026-10-12:
       * coming back from the Autofill sheet (a second surface on the same React host), the screen
       * was drawn again while not visible, the list measured an empty window and detached every
       * row - "removeViewAt: view already removed from parent! Children in parent: 0", a blank
       * Passwords list that never came back; one time "addViewAt: failed to insert view ...
       * index=1 count=0", and React tore itself down and the app crashed. The lists here are a
       * screen or two long, so clipping saved nothing.
       */
      removeClippedSubviews={false}
    />
  );
}

/*
 * One item, drawn as the list draws it - for a screen that already scrolls (a
 * budget's view, Brad 2026-10-06): a list inside a ScrollView warns, and the
 * warning's toast sat over the sheet's buttons.
 */
export function EdgeListEntry({item}: {item: EdgeListItem}) {
  return item.kind === 'section' ? (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{item.title}</Text>
      {item.right ? <Text style={styles.sectionRight}>{item.right}</Text> : null}
    </View>
  ) : item.kind === 'row' ? (
    <Row item={item} />
  ) : (
    <NodeEntry item={item} />
  );
}

function NodeEntry({item}: {item: Extract<EdgeListItem, {kind: 'node'}>}) {
  const body = item.bare ? <>{item.render()}</> : <View style={styles.node}>{item.render()}</View>;
  return item.onPress || item.onLongPress ? (
    <Pressable onPress={item.onPress} onLongPress={item.onLongPress} accessibilityRole="button" accessibilityLabel={item.accessibilityLabel}
      style={({pressed}) => (pressed ? styles.pressed : null)}>
      {body}
    </Pressable>
  ) : (
    body
  );
}

const styles = StyleSheet.create({
  list: {flex: 1, backgroundColor: theme.bg},
  section: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 8, backgroundColor: theme.surface,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border,
  },
  sectionTitle: {color: theme.text, fontWeight: '700', fontSize: 14, letterSpacing: 0.3},
  sectionRight: {color: theme.textDim, fontSize: 12},
  row: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    paddingHorizontal: 16, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border,
  },
  alarm: {backgroundColor: 'rgba(248,113,113,0.10)'},
  pressed: {backgroundColor: theme.inputBg},
  main: {flex: 1, gap: 2},
  title: {fontSize: 15, lineHeight: 20},
  subtitle: {color: theme.textDim, fontSize: 13, lineHeight: 18},
  detail: {color: theme.textDim, fontSize: 12, lineHeight: 16, fontFamily: 'monospace'},
  right: {color: theme.textDim, fontSize: 12, marginTop: 2},
  node: {paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border},
});
