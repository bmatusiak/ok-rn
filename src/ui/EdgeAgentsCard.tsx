/**
 * THE AGENTS CARD on the Edge tab (mcp-service.md 4.7a; Brad, 2026-10-03:
 * "build it as you described").
 *
 * Who may ask this phone for budgets, and what each holds:
 * - every agent: its name, its key's fingerprint (what the computer prints),
 *   "registered with a press at #N" (the key's AGENT_ADD link) - or that it
 *   does not count, for one kept from before the press existed;
 * - its live budgets (uses left, when each ends) and its last request (when,
 *   the reason, what it got);
 * - Remove: no press. ok-rn forgets the agent - its requests are then refused
 *   unread - and ends every budget it holds on the key.
 * The header: Requests on/off (off = every agent request refused unread), and
 * the person's OWN identities, the list that brings the red warning.
 *
 * Approving is not here: that stays on the sheet over any tab.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {StyleSheet, Switch, Text, TextInput, View} from 'react-native';
import {request as requestLib} from 'node-onlykey-lib/edge';
import {
  agentRequestsOn, liveAgentBudgets, loadLastRequests, loadOwnIdentities, onSheet, removeAgent,
  saveOwnIdentities, loadTestIdentities, saveTestIdentities, setAgentRequestsOn, verifiedAgents, type Agent, type LastRequest,
} from '../edgeAgents';
import type {EdgeBudget} from '../edgeFake';
import {Btn, Section} from './components';
import {theme} from './theme';
import {debuggingOn, testingModeOn} from '../debugGuard';
import {DrawerArea} from './BottomDrawer';

const clock = (ms: number) => {
  const t = new Date(ms);
  return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
};
const when = (ms: number) => {
  const d = new Date(ms);
  return new Date().toDateString() === d.toDateString() ? clock(ms) : `${d.toLocaleDateString()} ${clock(ms)}`;
};

/* changed: anything that moves when the tab's sync brings new budgets (the screen's list) - the card reads again */
/* inDrawer: laid out as areas of the Agents drawer (src/ui/BottomDrawer.tsx), the switch in its own */
export function EdgeAgentsCard({onChanged, changed, inDrawer = false, testingMode = false}: {onChanged?: () => void; changed?: unknown; inDrawer?: boolean; testingMode?: boolean}) {
  const [agents, setAgents] = useState<(Agent & {inCopy: number | null})[]>([]);
  const [budgets, setBudgets] = useState<Record<string, EdgeBudget[]>>({});
  const [last, setLast] = useState<Record<string, LastRequest>>({});
  const [on, setOn] = useState(true);
  const [own, setOwn] = useState<string[]>([]);
  const [adding, setAdding] = useState('');
  /* Remove asks once more on the row before it acts */
  const [removing, setRemoving] = useState<string | null>(null);
  /* the same for one of the person's own identities (it takes the red warning away) */
  const [removingOwn, setRemovingOwn] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setAgents(await verifiedAgents());
    setLast(await loadLastRequests());
    setOn(await agentRequestsOn());
    setOwn(await loadOwnIdentities());
    setBudgets(await liveAgentBudgets().catch(() => ({})));
  }, []);
  useEffect(() => {
    void load();
    /* a sheet ended: an agent registered, a budget opened - read again */
    return onSheet(st => {
      if (st?.phase === 'done') void load();
    });
  }, [load]);
  /* the tab's live refresh synced (an agent spent): the uses left follow */
  useEffect(() => {
    if (changed !== undefined) void load();
  }, [changed, load]);

  const remove = async (key: string) => {
    setBusy(true);
    try {
      await removeAgent(key);
      setRemoving(null);
      await load();
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };
  const saveOwn = async (names: string[]) => {
    await saveOwnIdentities(names);
    setOwn(names);
  };
  /* rule 10: test identities - marked only here, and only with debugging off */
  const [testIds, setTestIds] = useState<string[]>([]);
  const [addingTest, setAddingTest] = useState('');
  const [testRefused, setTestRefused] = useState(false);
  useEffect(() => { void loadTestIdentities().then(setTestIds).catch(() => {}); }, []);
  const saveTest = async (names: string[]) => {
    await saveTestIdentities(names);
    setTestIds(names);
  };

  /* the switch and what it means - in the drawer they get an area of their own (Brad, 2026-10-04) */
  const toggle = <Switch value={on} onValueChange={v => { setOn(v); void setAgentRequestsOn(v); }} />;
  const explain = (
      <Text style={styles.dim}>
        {on
          ? 'Requests on: a registered agent may ask for budgets; each still shows here and needs your press.'
          : 'Requests off: every agent request is refused unread.'}
      </Text>
  );
  const agentsPart = (
    <>

      {agents.length === 0 ? (
        <Text style={styles.dim}>No agent is registered. An agent registers from its computer (onlykey-js edge register), with your Yes and a press.</Text>
      ) : null}
      {agents.map(a => {
        const held = budgets[a.key] ?? [];
        const l = last[a.key];
        /* R15c: counts only with its agent-add link in the verified copy */
        const pressed = a.inCopy !== null;
        return (
          <View key={a.key} style={[styles.agent, !pressed && styles.unpressed]}>
            <Text style={styles.name}>{a.name}</Text>
            <Text style={styles.mono}>{`Key ${requestLib.fingerprint(a.key)}`}</Text>
            <Text style={[styles.dim, !pressed && {color: theme.warn}]}>
              {pressed
                ? `Registered with a press at #${a.inCopy} (in the verified copy) · ${when(a.registered)}`
                : 'No agent-add link in the verified copy - it does not count; its requests are refused unread until it registers again with a press.'}
            </Text>
            {held.length ? (
              held.map(b => (
                <View key={b.grantId}>
                  <Text style={styles.op}>
                    {`Budget ${b.grantId}: ${Math.max(0, b.uses - b.used)} of ${b.uses} use${b.uses === 1 ? '' : 's'} left${b.endsAt ? `, until ${clock(b.endsAt)}` : ''}`}
                  </Text>
                  {/* R3: each identity on its own line, its own uses left, from the chain */}
                  {b.exact
                    ? b.scopes.map((sc, i) => (
                        <Text key={i} style={styles.dim}>
                          {`  ${sc.identity || `slot ${sc.slot}`}: ${Math.max(0, sc.cap - sc.used)} of ${sc.cap} left`}
                        </Text>
                      ))
                    : null}
                </View>
              ))
            ) : (
              <Text style={styles.dim}>No live budget.</Text>
            )}
            {l ? <Text style={styles.dim}>{`Last request ${when(l.at)}: "${l.reason}" - ${l.result}`}</Text> : null}
            {removing === a.key ? (
              <>
                <Text style={[styles.op, {color: theme.error}]}>
                  {`Remove ${a.name}?${held.length ? ` Its ${held.length} live budget${held.length === 1 ? '' : 's'} end now.` : ''} Its requests are refused from then on.`}
                </Text>
                <View style={styles.row}>
                  <Btn title="Yes, remove" tone="danger" onPress={() => void remove(a.key)} disabled={busy} />
                  <Btn title="Back" onPress={() => setRemoving(null)} disabled={busy} />
                </View>
              </>
            ) : (
              <View style={styles.row}>
                <Btn title="Remove" onPress={() => setRemoving(a.key)} disabled={busy} />
              </View>
            )}
          </View>
        );
      })}

    </>
  );
  const ownPart = (
    <>
      <Text style={[styles.name, {marginTop: 8}]}>Your own identities</Text>
      <Text style={styles.dim}>A request naming one of these gets the red warning and a second confirm.</Text>
      {own.map(n => (
        <View key={n}>
          <View style={styles.ownRow}>
            <Text style={[styles.mono, {flex: 1}]}>{n}</Text>
            {removingOwn === n ? null : <Btn title="Remove" onPress={() => setRemovingOwn(n)} />}
          </View>
          {removingOwn === n ? (
            <>
              <Text style={[styles.op, {color: theme.error}]}>
                {`Remove ${n}? Requests naming it will no longer get the red warning.`}
              </Text>
              <View style={styles.row}>
                <Btn title="Yes, remove" tone="danger" onPress={() => { setRemovingOwn(null); void saveOwn(own.filter(x => x !== n)); }} />
                <Btn title="Back" onPress={() => setRemovingOwn(null)} />
              </View>
            </>
          ) : null}
        </View>
      ))}
      <View style={styles.ownRow}>
        <TextInput
          value={adding}
          onChangeText={setAdding}
          placeholder="ssh://user@host or gpg://Name <email>"
          placeholderTextColor={theme.textDim}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, {flex: 1}]}
        />
        <Btn
          title="Add"
          onPress={() => {
            const n = adding.trim();
            if (n && !own.includes(n)) void saveOwn([...own, n]);
            setAdding('');
          }}
          disabled={!adding.trim()}
        />
      </View>
    </>
  );
  const testPart = (
    <>
      <Text style={[styles.name, {marginTop: 12}]}>Test identities</Text>
      <Text style={styles.dim}>
        Testing mode only. Identities that are tests - never one that signs anything real. A production build has no such list: there, with debugging on, nothing can be approved, pressed, waived or settled.
      </Text>
      {testIds.map(n => (
        <View key={n} style={styles.ownRow}>
          <Text style={[styles.mono, {flex: 1}]}>{n}</Text>
          <Btn title="Remove" onPress={() => void saveTest(testIds.filter(x => x !== n))} />
        </View>
      ))}
      <View style={styles.ownRow}>
        <TextInput
          value={addingTest}
          onChangeText={t => { setAddingTest(t); setTestRefused(false); }}
          placeholder="ssh://test@host"
          placeholderTextColor={theme.textDim}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, {flex: 1}]}
        />
        <Btn
          title="Mark as test"
          onPress={() => {
            /* the lock is off only in testing mode (option 1, Brad 2026-10-04) - and this section exists only there */
            if (debuggingOn() && !testingModeOn()) { setTestRefused(true); return; }
            const n = addingTest.trim();
            if (n && !testIds.includes(n)) void saveTest([...testIds, n]);
            setAddingTest('');
          }}
          disabled={!addingTest.trim()}
        />
      </View>
      {testRefused ? <Text style={[styles.op, {color: theme.error}]}>Debugging is on - turn off debugging to mark a test identity.</Text> : null}
    </>
  );
  if (inDrawer) {
    return (
      <>
        <DrawerArea>
          <View style={styles.toggleRow}>
            <Text style={styles.name}>Requests from agents</Text>
            {toggle}
          </View>
          {explain}
        </DrawerArea>
        <DrawerArea>{agentsPart}</DrawerArea>
        <DrawerArea>{ownPart}</DrawerArea>
        {/* testing mode only - see src/debugGuard.ts */}
        {testingMode ? <DrawerArea>{testPart}</DrawerArea> : null}
      </>
    );
  }
  return (
    <Section title="Agents" right={toggle}>
      {explain}
      {agentsPart}
      {ownPart}
      {testingMode ? testPart : null}
    </Section>
  );
}

const styles = StyleSheet.create({
  agent: {borderWidth: 1, borderColor: theme.border, borderRadius: theme.radius, padding: 10, gap: 4, marginTop: 8},
  unpressed: {borderColor: theme.warn, borderStyle: 'dashed'},
  name: {color: theme.text, fontWeight: '600', fontSize: 15},
  toggleRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  op: {color: theme.text, fontSize: 14, lineHeight: 20},
  dim: {color: theme.textDim, fontSize: 13, lineHeight: 19},
  mono: {color: theme.textSecondary, fontFamily: theme.mono, fontSize: 13},
  row: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6},
  ownRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6},
  input: {
    color: theme.text, fontSize: 14, paddingHorizontal: 10, paddingVertical: 9, borderRadius: theme.radius,
    borderWidth: 1, borderColor: theme.border, backgroundColor: theme.inputBg,
  },
});
