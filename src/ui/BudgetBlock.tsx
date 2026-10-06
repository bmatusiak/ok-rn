/**
 * BudgetBlock - one budget as an audit entry, read like a block in a chain
 * explorer (Brad, 2026-10-04: "it should act like a log, showing everything -
 * how things lasted, how much of the budget it used... like a block chain
 * explorer"). Re-usable: the Edge tab's budget history, and anything else that
 * lists budgets.
 *
 * What it shows, at a glance: which budget, what for, for whom; the links it
 * spans (#first-#last); when it opened and how long it lasted, against its
 * lifetime; how much it spent (a bar, the count, the %), each identity's own
 * count; whether every use got its ticket; how it ended. Tap it for its links.
 *
 * Times are this phone's clock (the chain carries none); "time unknown" when
 * the phone did not see it end.
 */
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import type {EdgeBudget} from '../edgeFake';
import {theme} from './theme';
import {budgetStatusText, type BudgetStatus} from '../budgetStatus';

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
const day = (ms: number) => new Date(ms).toLocaleDateString([], {month: 'short', day: 'numeric'});

function span(minutes: number): string {
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

function Bar({used, total}: {used: number; total: number}) {
  const pct = total > 0 ? Math.min(100, (100 * used) / total) : 0;
  return (
    <View style={styles.bar}>
      <View style={[styles.fill, {width: `${pct}%`}, used >= total && {backgroundColor: theme.warn}]} />
    </View>
  );
}

export function BudgetBlock({b, status, onPress}: {b: EdgeBudget; status?: BudgetStatus; onPress?: () => void}) {
  const pct = b.uses ? Math.round((100 * b.used) / b.uses) : 0;
  const lasted = b.openedAt && b.endedAt ? span((b.endedAt - b.openedAt) / 60000) : null;
  const owed = Math.max(0, b.used - (b.ticketsFiled ?? 0));
  const ended = b.endedHow ?? 'live';
  const body = (
    <View style={styles.block}>
      <View style={styles.head}>
        <Text style={styles.id}>{`Budget ${b.grantId}`}</Text>
        {status ? (
          <Text style={[styles.status, {color: status.kind === 'validated' || status.kind === 'active' ? theme.ok : status.kind === 'failed' ? theme.error : status.owed ? theme.warn : theme.textDim}]}>{budgetStatusText(status)}</Text>
        ) : (
          <Text style={[styles.status, ended === 'live' && {color: theme.ok}]}>{ended}</Text>
        )}
      </View>
      <Text style={styles.reason}>{b.reason}</Text>
      {b.agent ? <Text style={styles.dim}>{`for ${b.agent}`}</Text> : null}
      <View style={styles.head}>
        <Text style={styles.dim}>
          {b.openedAt
            ? `opened ${day(b.openedAt)} ${clock(b.openedAt)} · ${lasted ? `lasted ${lasted}` : 'time unknown'}${b.lifetime ? ` of ${span(b.lifetime)}` : ''}`
            : 'opened elsewhere'}
        </Text>
        {b.firstSeq !== undefined ? <Text style={styles.mono}>{`#${b.firstSeq}–#${b.lastSeq}`}</Text> : null}
      </View>
      <Bar used={b.used} total={b.uses} />
      <Text style={styles.line}>{`${b.used} of ${b.uses} used · ${pct}%`}</Text>
      {b.scopes.map((sc, i) => (
        <View key={i} style={styles.head}>
          <Text style={styles.ident} numberOfLines={1}>{sc.identity || `slot ${sc.slot}`}</Text>
          <Text style={styles.mono}>{b.exact !== false ? `${sc.used} / ${sc.cap}` : `– / ${sc.cap}`}</Text>
        </View>
      ))}
      <Text style={[styles.line, {color: owed ? theme.warn : theme.ok}]}>
        {b.used === 0 ? 'no uses' : owed ? `tickets ${b.ticketsFiled ?? 0} of ${b.used} - ${owed} owed` : `tickets ${b.used} of ${b.used} ✓`}
      </Text>
    </View>
  );
  return onPress ? (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Open budget ${b.grantId}`}
      style={({pressed}) => (pressed ? {backgroundColor: theme.inputBg} : null)}>
      {body}
    </Pressable>
  ) : (
    body
  );
}

const styles = StyleSheet.create({
  block: {paddingHorizontal: 16, paddingVertical: 12, gap: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border},
  head: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8},
  id: {color: theme.text, fontWeight: '700', fontSize: 15},
  status: {color: theme.textDim, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5},
  reason: {color: theme.text, fontSize: 14, lineHeight: 19},
  dim: {color: theme.textDim, fontSize: 12, lineHeight: 17, flexShrink: 1},
  mono: {color: theme.textDim, fontSize: 12, fontFamily: 'monospace'},
  ident: {color: theme.textDim, fontSize: 12, flex: 1},
  line: {color: theme.textDim, fontSize: 12},
  bar: {height: 6, borderRadius: 3, backgroundColor: theme.inputBg, overflow: 'hidden', marginTop: 4},
  fill: {height: 6, backgroundColor: theme.link},
});
