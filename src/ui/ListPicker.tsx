import React, {useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {Btn} from './components';
import {EdgeListEntry, type EdgeListTone} from './EdgeList';
import {Sheet, type SheetTone} from './Sheet';
import {theme} from './theme';

/*
 * PICKING FROM A LIST: ONE ROW, THEN A SCROLLING LIST (Brad, 2026-10-18: "when selecting from a
 * list, i think it should a scrolling list view"; "not a pile of buttons needs to be a rule").
 *
 * A set that can grow - contacts, keys, files - is never drawn as one button per item. The screen
 * shows one field row ("To  Alice, Bob ›"); a tap opens the shared Sheet (system bars handled
 * there) with the items as list rows, drawn like the app's other lists (EdgeList: title, a detail
 * line in its tone). A picked row carries ✓. Several at once: tap rows on and off, then Done. One:
 * a tap picks it and closes.
 */

export type PickItem = {
  key: string;
  title: string;
  /* a second line (Guest Book: "✓ verified" green / "! unverified" amber) */
  detail?: string;
  detailTone?: EdgeListTone;
  /* shown but not pickable, with the reason as its detail */
  disabled?: boolean;
};

export function ListPicker({
  label,
  placeholder,
  items,
  selected,
  onChange,
  multi = false,
  sheetTitle,
  tone = 'neutral',
  empty,
  disabled,
  onOpen,
}: {
  /* the field's name ("To", "Your key") */
  label: string;
  /* the field's text with nothing picked */
  placeholder: string;
  items: PickItem[];
  selected: string[];
  onChange: (keys: string[]) => void;
  multi?: boolean;
  sheetTitle?: string;
  tone?: SheetTone;
  /* what the sheet says when there is nothing to pick */
  empty?: string;
  disabled?: boolean;
  /* the list is about to show: read it again (a contact added in Guest Book since) */
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const titles = items.filter(i => selected.includes(i.key)).map(i => i.title);
  const toggle = (key: string) => {
    if (!multi) {
      onChange([key]);
      setOpen(false);
      return;
    }
    onChange(selected.includes(key) ? selected.filter(k => k !== key) : [...selected, key]);
  };
  return (
    <>
      <Pressable
        onPress={() => { onOpen?.(); setOpen(true); }}
        disabled={disabled}
        style={[styles.field, disabled ? styles.faded : null]}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${titles.length ? titles.join(', ') : placeholder}`}>
        <Text style={styles.label}>{label}</Text>
        <Text style={[styles.value, titles.length ? null : styles.placeholder]} numberOfLines={2}>
          {titles.length ? titles.join(', ') : placeholder}
        </Text>
        <Text style={styles.chev}>›</Text>
      </Pressable>
      <Sheet
        visible={open}
        tone={tone}
        onClose={() => setOpen(false)}
        flush
        footer={multi ? <Btn title={selected.length ? `Done (${selected.length})` : 'Done'} tone="primary" onPress={() => setOpen(false)} /> : undefined}>
        {/* the title drawn here: a flush sheet gives its body no padding, and the rows draw their own */}
        <Text style={[styles.sheetTitle, {color: tone === 'guestbook' ? theme.accentHover : theme.text}]}>{sheetTitle ?? label}</Text>
        {items.length ? (
          items.map(i => (
            <EdgeListEntry
              key={i.key}
              item={{
                key: i.key,
                kind: 'row',
                title: i.title,
                detail: i.detail,
                detailTone: i.detailTone,
                tone: i.disabled ? 'dim' : undefined,
                right: selected.includes(i.key) ? '✓' : undefined,
                onPress: i.disabled ? undefined : () => toggle(i.key),
                accessibilityLabel: `${selected.includes(i.key) ? 'Picked' : 'Pick'} ${i.title}`,
              }}
            />
          ))
        ) : (
          <View style={styles.emptyBox}>
            <Text style={styles.placeholder}>{empty ?? 'Nothing to pick.'}</Text>
          </View>
        )}
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
    marginTop: 8,
  },
  faded: {opacity: 0.5},
  label: {color: theme.textDim, fontSize: 13, minWidth: 36},
  value: {color: theme.text, fontSize: 15, flex: 1},
  placeholder: {color: theme.textDim, fontSize: 14},
  chev: {color: theme.textDim, fontSize: 20},
  emptyBox: {padding: 16},
  sheetTitle: {fontWeight: '600', fontSize: 17, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8},
});
