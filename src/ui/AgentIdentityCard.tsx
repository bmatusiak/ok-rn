/**
 * THE AGENT IDENTITY in the Edge Management drawer (SPEC H7; Brad, 2026-10-20: "it should be
 * displayed in" the Edge Management pull-up tab; "computer sets, phone keeps").
 *
 * Read-only here: a computer sets it with `onlykey-js edge setup`, and the Edge sheet asks
 * before it is kept (src/edgeAgents.ts handleIdentity). The rows are the library's
 * (identity.rows), the same words the sheet shows and the CLI prints.
 */
import React, {useEffect, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {identity as identityLib} from 'node-onlykey-lib/edge';
import {loadKept, onIdentity, type KeptIdentity} from '../edgeIdentity';
import {DrawerArea} from './BottomDrawer';
import {theme} from './theme';

export function AgentIdentityCard() {
  const [kept, setKept] = useState<KeptIdentity | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void loadKept().then(k => { if (live) setKept(k); });
    const off = onIdentity(k => setKept(k));
    return () => { live = false; off(); };
  }, []);
  if (kept === undefined) return null;
  return (
    <DrawerArea>
      <Text style={styles.name}>Agent identity</Text>
      {kept ? (
        <>
          {identityLib.rows(kept.record).map(([k, v]: [string, string]) => (
            <View key={k} style={styles.row}>
              <Text style={styles.key}>{k}</Text>
              <Text style={styles.value} selectable>{v}</Text>
            </View>
          ))}
          <Text style={styles.dim}>
            {`Every computer paired with this phone uses it${kept.setBy ? ` - set from ${kept.setBy.computer}` : ''}. Change it from a computer: onlykey-js edge setup.`}
          </Text>
        </>
      ) : (
        <Text style={styles.dim}>
          None yet. Set it once from a paired computer: onlykey-js edge setup --ssh ssh://user@host --gpg "Name &lt;email&gt;" - it shows here to approve.
        </Text>
      )}
    </DrawerArea>
  );
}

const styles = StyleSheet.create({
  name: {color: theme.text, fontWeight: '600', fontSize: 15},
  row: {flexDirection: 'row', gap: 10, paddingVertical: 2},
  key: {color: theme.textDim, fontSize: 13, width: 84},
  value: {color: theme.text, fontSize: 13, flex: 1},
  dim: {color: theme.textDim, fontSize: 13, lineHeight: 19},
});
