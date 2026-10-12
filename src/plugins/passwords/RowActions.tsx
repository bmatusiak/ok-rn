import React from 'react';
import {Modal, Pressable, StyleSheet, Text, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {Btn} from '../../ui/components';
import {theme} from '../../ui/theme';

/*
 * A ROW'S ACTIONS, from a long press in the Passwords list (spec UI, "List": "Row actions: Copy
 * password, Copy username, Type, Show TOTP"). A tap still opens the entry; this is the shortcut.
 * A sheet, not an Alert: Android's Alert holds three buttons and a login has up to five. Its
 * bottom clears the gesture bar or the 3-button bar (the inset), so no button sits under them.
 */
export type RowAction = {title: string; onPress: () => void; primary?: boolean};

export function RowActions({title, actions, onClose}: {title: string | null; actions: RowAction[]; onClose: () => void}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal transparent animationType="slide" visible={title !== null} onRequestClose={onClose}>
      <View style={styles.fill}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
        <View style={[styles.sheet, {paddingBottom: 16 + insets.bottom}]}>
          <Text style={styles.title}>{title}</Text>
          {actions.length ? (
            actions.map(a => (
              <Btn
                key={a.title}
                title={a.title}
                tone={a.primary ? 'primary' : 'default'}
                wide
                onPress={() => {
                  onClose();
                  a.onPress();
                }}
              />
            ))
          ) : (
            <Text style={styles.dim}>Nothing to copy or type here - open it to see it.</Text>
          )}
          <Btn title="Cancel" wide onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: {flex: 1, justifyContent: 'flex-end'},
  backdrop: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)'},
  sheet: {backgroundColor: theme.surface, padding: 16, gap: 8, borderTopLeftRadius: 12, borderTopRightRadius: 12},
  title: {color: theme.text, fontSize: 16, fontWeight: '600', marginBottom: 4},
  dim: {color: theme.textDim, fontSize: 13},
});
