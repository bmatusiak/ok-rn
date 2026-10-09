/**
 * REQUESTS FROM AGENTS on the Edge tab: the switch, nothing more.
 *
 * No agent list since 2026-10-08 (Brad: "so the claude key thing is overkill"; "lets cut it
 * out"): an agent is no longer registered with a key and a press. A budget request is taken
 * because it comes from a computer PAIRED with this phone (the Bluetooth tab's 6-digit code,
 * its Revoke) inside that pairing's encrypted session; the sheet names the computer. The
 * switch stays (Brad's open item 5: a kill switch?): off = every budget request refused unread.
 *
 * Approving is not here: that stays on the sheet over any tab.
 */
import React, {useEffect, useState} from 'react';
import {StyleSheet, Switch, Text, View} from 'react-native';
import {agentRequestsOn, setAgentRequestsOn} from '../edgeAgents';
import {Section} from './components';
import {theme} from './theme';
import {DrawerArea} from './BottomDrawer';

/* inDrawer: laid out as an area of the Edge Management drawer (src/ui/BottomDrawer.tsx) */
export function EdgeAgentsCard({inDrawer = false}: {onChanged?: () => void; changed?: unknown; inDrawer?: boolean; testingMode?: boolean}) {
  const [on, setOn] = useState(true);
  useEffect(() => { void agentRequestsOn().then(setOn); }, []);
  const toggle = <Switch value={on} onValueChange={v => { setOn(v); void setAgentRequestsOn(v); }} />;
  const explain = (
    <Text style={styles.dim}>
      {on
        ? 'Requests on: an agent on a computer paired with this phone (Bluetooth tab) may ask for budgets; each still shows here and needs your press.'
        : 'Requests off: every budget request is refused unread.'}
    </Text>
  );
  if (inDrawer) {
    return (
      <DrawerArea>
        <View style={styles.toggleRow}>
          <Text style={styles.name}>Requests from agents</Text>
          {toggle}
        </View>
        {explain}
      </DrawerArea>
    );
  }
  return (
    <Section title="Requests from agents" right={toggle}>
      {explain}
    </Section>
  );
}

const styles = StyleSheet.create({
  name: {color: theme.text, fontWeight: '600', fontSize: 15},
  toggleRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  dim: {color: theme.textDim, fontSize: 13, lineHeight: 19},
});
