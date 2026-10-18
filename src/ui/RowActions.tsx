import React from 'react';
import {StyleSheet, Text} from 'react-native';

import {Btn} from './components';
import {Sheet} from './Sheet';
import {theme} from './theme';

/*
 * A ROW'S ACTIONS, from a long press in the Passwords list (spec UI, "List": "Row actions: Copy
 * password, Copy username, Type, Show TOTP"). A tap still opens the entry; this is the shortcut.
 * A sheet, not an Alert: Android's Alert holds three buttons and a login has up to five. The
 * app's Sheet (src/ui/Sheet.tsx) keeps it clear of the system bars.
 */
export type RowAction = {title: string; onPress: () => void; primary?: boolean};

export function RowActions({title, actions, onClose}: {title: string | null; actions: RowAction[]; onClose: () => void}) {
  return (
    <Sheet visible={title !== null} title={title ?? ''} onClose={onClose} footer={<Btn title="Cancel" wide onPress={onClose} />}>
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
    </Sheet>
  );
}

const styles = StyleSheet.create({
  dim: {color: theme.textDim, fontSize: 13},
});
