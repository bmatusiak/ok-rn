/**
 * Edge: what the key decided, as a chain the phone verifies (spec
 * onlykey-edge/build/okrn-edge-tab.md 4.3), top to bottom:
 *   1. the verdict card - verified / gap / tampered / not synced
 *   2. budgets - what an agent may still do without a press
 *   3. the chain - newest first, each use with its ticket hanging from it
 *   4. (testing) the fake key's controls
 *
 * Driven by a FAKE key until the soft key's Edge plugin exists (E3), so the
 * whole tab is testing-mode only. Ticket messages are written by an agent:
 * plain text, never links or markdown.
 */
import React from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import {codes} from 'node-onlykey-lib/edge';
import {Btn, Section} from '../ui/components';
import {theme} from '../ui/theme';
import {useEdge} from '../hooks/useEdge';
import type {EdgeRow, Verdict} from '../edgeStore';

const {OP, DECISION, FLAG} = codes;

function verdictLine(v: Verdict): {text: string; color: string} {
  switch (v.kind) {
    case 'verified':
      return {text: v.through < 0 ? 'Verified: nothing recorded yet' : `Verified through #${v.through}`, color: theme.ok};
    case 'gap':
      return {text: v.from === v.to ? `Gap #${v.from} unverifiable` : `Gap #${v.from}–#${v.to} unverifiable`, color: theme.warn};
    case 'tampered':
      return {text: `Tampered at #${v.seq}: ${v.reason}`, color: theme.error};
    case 'not-synced':
      return {text: 'Not synced', color: theme.textDim};
    case 'locked':
      return {text: 'Unlock the key to sync', color: theme.textDim};
    case 'no-edge':
      return {text: 'This firmware has no Edge', color: theme.textDim};
  }
}

const opName = (op: number) => codes.nameOf(OP, op) ?? `op ${op}`;

function approval(row: EdgeRow): string {
  const f = row.fields;
  if (f.op === OP.TICKET) return `ticket for #${f.refSeq}`;
  if (f.decision === DECISION.SELF_PRESS) return `self-press · budget ${f.grantId} step ${f.grantStep}`;
  if (f.decision === DECISION.DENY) return 'denied';
  if (f.decision === DECISION.TIMEOUT) return 'timed out';
  if (f.flags & FLAG.PRESS_OBSERVED) return 'pressed';
  return 'approved';
}

function TicketHook({t}: {t: NonNullable<EdgeRow['ticket']>}) {
  if (t.status === 'no-ticket-owed') return null;
  if (t.status === 'missing') {
    return (
      <View style={[styles.ticket, styles.ticketMissing]}>
        <Text style={[styles.ticketTitle, {color: theme.warn}]}>No ticket</Text>
        <Text style={styles.dim}>The agent did not say what it did with this.</Text>
      </View>
    );
  }
  const alarm = t.status === 'alarm';
  const code = t.ticket!.code;
  const color = alarm ? theme.error : code < 0x10 ? theme.ok : theme.textDim;
  const name = t.ticket!.name ?? `unknown code 0x${code.toString(16).padStart(2, '0')}`;
  return (
    <View style={[styles.ticket, {borderLeftColor: color}]}>
      <Text style={[styles.ticketTitle, {color}]}>{alarm ? `⚠ ${name}` : name}</Text>
      {t.message !== null && t.message !== undefined ? (
        <Text style={styles.message}>{t.message}</Text>
      ) : (
        <Text style={styles.dim}>
          {t.messageStatus === 'mismatch' ? 'Message does not match the ticket - not shown.' : 'No message synced.'}
        </Text>
      )}
    </View>
  );
}

function LinkRow({row}: {row: EdgeRow}) {
  const dim = !row.verified;
  return (
    <View style={[styles.link, dim && styles.unverified]}>
      <View style={styles.linkHead}>
        <View style={[styles.seq, {borderColor: dim ? theme.textDim : theme.link}]}>
          <Text style={styles.seqText}>{row.seq}</Text>
        </View>
        <View style={styles.linkText}>
          <Text style={styles.op}>
            {opName(row.fields.op)}
            {row.fields.op === OP.SIGN || row.fields.op === OP.DECRYPT ? ` · slot ${row.fields.slot}` : ''}
          </Text>
          <Text style={styles.dim}>
            {approval(row)}
            {row.fields.flags & FLAG.PREV_NO_TICKET ? ' · previous use had no ticket' : ''}
            {dim ? ' · unverifiable' : ''}
          </Text>
        </View>
      </View>
      {row.ticket ? <TicketHook t={row.ticket} /> : null}
    </View>
  );
}

export function EdgeScreen() {
  const edge = useEdge();
  const v = edge.view;
  const line = v ? verdictLine(v.verdict) : {text: 'Reading…', color: theme.textDim};
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Section title="Edge">
        <Text style={[styles.verdict, {color: line.color}]}>{line.text}</Text>
        <Text style={styles.dim}>
          {v?.headSeq !== null && v?.headSeq !== undefined ? `Key's head: #${v.headSeq}` : 'Key not read yet'}
          {v?.lastSync ? ` · last sync ${new Date(v.lastSync).toLocaleTimeString()} (phone clock)` : ''}
        </Text>
        {edge.error ? <Text style={[styles.dim, {color: theme.error}]}>{edge.error}</Text> : null}
        <View style={styles.row}>
          <Btn title="Sync" tone="primary" onPress={edge.sync} disabled={edge.busy} />
          <Btn title="Verify" onPress={edge.verify} disabled={edge.busy} />
        </View>
      </Section>

      <Section title="Budgets">
        {edge.budgets.length === 0 ? (
          <Text style={styles.dim}>
            No budget. A budget lets an agent use the key a set number of times without a press; you approve it once.
          </Text>
        ) : (
          edge.budgets.map(b => (
            <View key={b.grantId} style={styles.budget}>
              <Text style={styles.op}>{b.reason}</Text>
              {b.scopes.map((s, i) => (
                <View key={i} style={styles.scope}>
                  <Text style={styles.dim}>
                    {opName(s.op)} · slot {s.slot} · {s.used} / {s.cap}
                  </Text>
                  <View style={styles.bar}>
                    <View style={[styles.barFill, {width: `${Math.min(100, (100 * s.used) / s.cap)}%`}]} />
                  </View>
                </View>
              ))}
              <Text style={styles.dim}>Ends when you lock the key.</Text>
            </View>
          ))
        )}
      </Section>

      <Section title="The chain">
        {v && v.rows.length ? v.rows.map(r => <LinkRow key={r.seq} row={r} />) : <Text style={styles.dim}>No links on this phone yet.</Text>}
      </Section>

      <Section title="Fake key (testing)">
        <Text style={styles.dim}>
          A fake key until the soft key has Edge. Agent actions add links on the fake key, then sync. Edits change only this
          phone's copy; Verify shows what they break, Sync heals what the key still holds.
        </Text>
        <View style={styles.row}>
          <Btn title="Agent: use + OK ticket" onPress={() => edge.act(k => { k.use(`commit ${Date.now() % 100000}`); k.ticket(0x00, 'Used as stated; the target accepted it.'); })} disabled={edge.busy} />
          <Btn title="Agent: use, no ticket" onPress={() => edge.act(k => { k.use(`commit ${Date.now() % 100000}`); })} disabled={edge.busy} />
          <Btn title="Alarm ticket" onPress={() => edge.act(k => { k.use('tag'); k.ticket(0x82, 'Decrypted output may have been written to a shared folder.'); })} disabled={edge.busy} />
          <Btn title="Denied request" onPress={() => edge.act(k => k.deny('decrypt notes.age'))} disabled={edge.busy} />
          <Btn title="Clasp budget of 3" onPress={() => edge.act(k => k.clasp('Sign three commits', 3))} disabled={edge.busy} />
          <Btn title="Lock (ends budget)" onPress={() => edge.act(k => k.lock())} disabled={edge.busy} />
        </View>
        <View style={styles.row}>
          <Btn title="Flip a byte" tone="danger" onPress={() => edge.tamper('flip')} disabled={edge.busy} />
          <Btn title="Delete a link" tone="danger" onPress={() => edge.tamper('delete')} disabled={edge.busy} />
          <Btn title="Swap two" tone="danger" onPress={() => edge.tamper('swap')} disabled={edge.busy} />
          <Btn title="Cut the tail" tone="danger" onPress={() => edge.tamper('truncate')} disabled={edge.busy} />
          <Btn title="Forget copy" onPress={() => edge.tamper('forget')} disabled={edge.busy} />
          <Btn title="New fake key" onPress={edge.resetFake} disabled={edge.busy} />
        </View>
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: {padding: 12, gap: 12},
  verdict: {fontSize: 20, fontWeight: '700', marginBottom: 4},
  dim: {color: theme.textDim, fontSize: 13, lineHeight: 19},
  row: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10},
  budget: {borderWidth: 1, borderColor: theme.border, borderRadius: theme.radius, padding: 10, gap: 6},
  scope: {gap: 4},
  bar: {height: 6, borderRadius: 3, backgroundColor: theme.inputBg, overflow: 'hidden'},
  barFill: {height: 6, backgroundColor: theme.accentHover},
  link: {paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.border},
  unverified: {opacity: 0.45},
  linkHead: {flexDirection: 'row', alignItems: 'center', gap: 10},
  seq: {width: 34, height: 34, borderRadius: 17, borderWidth: 2, alignItems: 'center', justifyContent: 'center'},
  seqText: {color: theme.text, fontFamily: theme.mono, fontSize: 13},
  linkText: {flex: 1},
  op: {color: theme.text, fontSize: theme.fontSize},
  ticket: {marginLeft: 44, marginTop: 6, paddingLeft: 10, borderLeftWidth: 3, gap: 2},
  ticketMissing: {borderLeftColor: theme.warn, borderStyle: 'dashed'},
  ticketTitle: {fontWeight: '600', fontSize: 14},
  message: {color: theme.textSecondary, fontSize: 13, lineHeight: 19},
});
