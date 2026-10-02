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
import React, {useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {codes} from 'node-onlykey-lib/edge';
import {Btn, Section} from '../ui/components';
import {theme} from '../ui/theme';
import {useEdge} from '../hooks/useEdge';
import type {EdgeRow, Verdict} from '../edgeStore';
import type {EdgeBudget, EdgeRequest} from '../edgeFake';

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
  if (f.op === OP.TICKET) return `answers no request (#${f.refSeq})`; // only orphans are drawn as rows
  if (f.decision === DECISION.SELF_PRESS) return `self-press · budget ${f.grantId} step ${f.grantStep}`;
  if (f.decision === DECISION.DENY) return 'denied';
  if (f.decision === DECISION.TIMEOUT) return 'timed out';
  if (f.flags & FLAG.PRESS_OBSERVED) return 'pressed';
  return 'approved';
}

/** A used/total bar: thick for a whole budget, thin for a scope or a step. */
function Progress({used, total, thick}: {used: number; total: number; thick?: boolean}) {
  const pct = total > 0 ? Math.min(100, (100 * used) / total) : 0;
  const full = used >= total;
  return (
    <View style={[styles.bar, thick && styles.barThick]}>
      <View style={[styles.barFill, thick && styles.barThick, {width: `${pct}%`}, full && {backgroundColor: theme.warn}]} />
    </View>
  );
}

function TicketHook({t, verified}: {t: NonNullable<EdgeRow['ticket']>; verified: boolean}) {
  /* waiting is drawn as its own row above the request, not as a hook */
  if (t.status === 'no-ticket-owed' || t.status === 'waiting') return null;
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
      <Text style={[styles.ticketTitle, {color}]}>
        {alarm ? `⚠ ${name}` : name}
        <Text style={styles.dim}>{`  ticket #${t.ticket!.seq}${verified ? '' : ' · unverifiable'}`}</Text>
      </Text>
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

/** The latest use has no ticket yet - the key still takes one for it (R16). */
function WaitingRow({seq}: {seq: number}) {
  return (
    <View style={[styles.link, styles.waiting]}>
      <Text style={[styles.ticketTitle, {color: theme.warn}]}>Waiting for ticket</Text>
      <Text style={styles.dim}>{`The agent has not yet said what it did with #${seq}.`}</Text>
    </View>
  );
}

function LinkRow({row, ticketVerified, budgetUses}: {row: EdgeRow; ticketVerified: boolean; budgetUses?: Map<number, number>}) {
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
      {row.fields.decision === DECISION.SELF_PRESS && budgetUses?.has(row.fields.grantId) ? (
        <View style={styles.step}>
          <Progress used={row.fields.grantStep} total={budgetUses.get(row.fields.grantId)!} />
        </View>
      ) : null}
      {row.ticket ? <TicketHook t={row.ticket} verified={ticketVerified} /> : null}
    </View>
  );
}

/**
 * Newest first. A ticket ATTACHED to its request is drawn only under that
 * request (owner, 2026-10-02); a ticket that answers no request keeps a row of
 * its own, since there is nothing to hang it from.
 */
function ChainList({rows, budgetUses}: {rows: EdgeRow[]; budgetUses?: Map<number, number>}) {
  const verified = new Map(rows.map(r => [r.seq, r.verified]));
  const attached = new Set<number>();
  for (const r of rows) if (r.ticket?.ticket) attached.add(r.ticket.ticket.seq);
  return (
    <>
      {rows
        .filter(r => !(r.fields.op === OP.TICKET && attached.has(r.seq)))
        .map(r => (
          <React.Fragment key={r.seq}>
            {r.ticket?.status === 'waiting' ? <WaitingRow seq={r.seq} /> : null}
            <LinkRow row={r} budgetUses={budgetUses} ticketVerified={r.ticket?.ticket ? verified.get(r.ticket.ticket.seq) !== false : true} />
          </React.Fragment>
        ))}
    </>
  );
}

function BudgetCard({b, busy, onOpen, onRevoke}: {b: EdgeBudget; busy: boolean; onOpen?: () => void; onRevoke?: () => void}) {
  const body = (
    <>
      <Text style={styles.op}>{b.reason}</Text>
      <Text style={styles.dim}>{`${b.used} of ${b.uses} uses spent${b.used >= b.uses ? ' - used up' : ''}`}</Text>
      <Progress used={b.used} total={b.uses} thick />
      {b.scopes.map((s, i) => (
        <View key={i} style={styles.scope}>
          <Text style={styles.dim}>
            {opName(s.op)} · slot {s.slot} · {s.used} / {s.cap}
          </Text>
          <Progress used={s.used} total={s.cap} />
        </View>
      ))}
      <Text style={styles.dim}>{`Budget ${b.grantId} · ends when you lock the key.`}</Text>
    </>
  );
  return (
    <View style={styles.budget}>
      {onOpen ? (
        <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={`Open budget ${b.grantId}`} style={styles.budgetBody}>
          {body}
          <Text style={[styles.dim, {color: theme.link}]}>Show its chain ›</Text>
        </Pressable>
      ) : (
        body
      )}
      {onRevoke ? (
        <View style={styles.row}>
          <Btn title="Revoke" tone="danger" onPress={onRevoke} disabled={busy} />
        </View>
      ) : null}
    </View>
  );
}

/** A budget's own links: its grant-create, the self-presses it paid for, its end. */
function budgetRows(rows: EdgeRow[], grantId: number): EdgeRow[] {
  return rows.filter(r => {
    const f = r.fields;
    if (f.grantId !== grantId) return false;
    if (f.op === OP.GRANT_CREATE || f.op === OP.GRANT_END) return true;
    return (f.op === OP.SIGN || f.op === OP.DECRYPT) && f.decision === DECISION.SELF_PRESS;
  });
}

/**
 * A budget someone asked for (the CLI, an agent's MCP server). Approving is the
 * clasp (spec 4.3): Yes here, then a press on the key - no press, no budget.
 * Declining sends nothing to the key.
 */
function PendingCard({r, busy, waiting, fake, onApprove, onPress, onDecline}: {
  r: EdgeRequest;
  busy: boolean;
  waiting: boolean;
  fake: boolean;
  onApprove: () => void;
  onPress: () => void;
  onDecline: () => void;
}) {
  const uses = r.scopes.reduce((n, sc) => n + sc.cap, 0);
  return (
    <View style={[styles.budget, styles.pending]}>
      <Text style={[styles.ticketTitle, {color: theme.warn}]}>Waiting for you</Text>
      <Text style={styles.op}>{r.reason}</Text>
      <Text style={styles.dim}>{`Asked by ${r.from} · ${uses} use${uses === 1 ? '' : 's'} without a press`}</Text>
      {r.scopes.map((sc, i) => (
        <Text key={i} style={styles.dim}>
          {opName(sc.op)} · slot {sc.slot} · up to {sc.cap}
        </Text>
      ))}
      {waiting ? (
        <>
          <Text style={[styles.op, {color: theme.warn}]}>Press the key to confirm</Text>
          <Text style={styles.dim}>
            {fake
              ? 'The fake key stands in for the keypad.'
              : 'This phone is also the key, so its press proves less than a hard key\'s. The key stops waiting after 25 s.'}
          </Text>
          <View style={styles.row}>
            {/* not disabled while busy: the request IS what is in flight, waiting for this */}
            <Btn title={fake ? 'Press (fake key)' : 'Press the soft key'} tone="primary" onPress={onPress} />
          </View>
        </>
      ) : (
        <View style={styles.row}>
          <Btn title="Approve" tone="primary" onPress={onApprove} disabled={busy} />
          <Btn title="Decline" onPress={onDecline} disabled={busy} />
        </View>
      )}
    </View>
  );
}

/**
 * One budget's chain, with the verdict on top (owner, 2026-10-02: the verdict
 * belongs with the chain, not on the list). The verdict is the WHOLE chain's -
 * a budget's links are only as good as every weld before them - and below it
 * are the budget's own links: its grant-create, every self-press it paid for
 * (each with its ticket), and its end. Its steps must run 1, 2, 3...
 */
function BudgetView({b, edge, onBack}: {b: EdgeBudget; edge: ReturnType<typeof useEdge>; onBack: () => void}) {
  const v = edge.view;
  const line = v ? verdictLine(v.verdict) : {text: 'Reading…', color: theme.textDim};
  const mine = budgetRows(v?.rows ?? [], b.grantId);
  const steps = mine.filter(r => r.fields.decision === DECISION.SELF_PRESS).map(r => r.fields.grantStep).reverse();
  const inOrder = steps.every((st, i) => st === i + 1);
  const ended = mine.some(r => r.fields.op === OP.GRANT_END);
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.row}>
        <Btn title="‹ Back" onPress={onBack} />
      </View>
      <Section title="The chain">
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
      <Section title={`Budget ${b.grantId}`}>
        <BudgetCard b={b} busy={false} />
        <Text style={[styles.dim, {color: inOrder ? theme.textDim : theme.error}]}>
          {steps.length === 0
            ? 'Nothing spent from it yet.'
            : inOrder
              ? `${steps.length === 1 ? 'Step 1' : `Steps 1–${steps.length}`} spent in order${ended ? '; ended' : ''}.`
              : `Steps out of order: ${steps.join(', ')}`}
        </Text>
        {mine.length ? (
          <ChainList rows={mine} budgetUses={new Map([[b.grantId, b.uses]])} />
        ) : (
          <Text style={styles.dim}>Its links are not on this phone yet - Sync.</Text>
        )}
      </Section>
      <Section title="This phone's copy (testing)">
        <Text style={styles.dim}>
          Edits change only this phone's copy of the chain, the way an attacker could. Verify shows what they break; Sync heals
          what the key still holds.
        </Text>
        <View style={styles.row}>
          <Btn title="Flip a byte" tone="danger" onPress={() => edge.tamper('flip')} disabled={edge.busy} />
          <Btn title="Delete a link" tone="danger" onPress={() => edge.tamper('delete')} disabled={edge.busy} />
          <Btn title="Swap two" tone="danger" onPress={() => edge.tamper('swap')} disabled={edge.busy} />
          <Btn title="Cut the tail" tone="danger" onPress={() => edge.tamper('truncate')} disabled={edge.busy} />
          <Btn title="Forget copy" onPress={() => edge.tamper('forget')} disabled={edge.busy} />
        </View>
      </Section>
    </ScrollView>
  );
}

/**
 * The Edge tab: budgets - waiting for you, then approved. A chain (and its
 * verdict) is shown only once you pick a budget (owner, 2026-10-02).
 */
export function EdgeScreen() {
  const edge = useEdge();
  const [open, setOpen] = useState<EdgeBudget | null>(null);
  if (open) {
    /* the live numbers if the budget is still live; the snapshot taken when it was opened if it ended */
    const b = edge.budgets.find(x => x.grantId === open.grantId) ?? open;
    return <BudgetView b={b} edge={edge} onBack={() => setOpen(null)} />;
  }
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Section title="Budgets">
        {edge.error ? <Text style={[styles.dim, {color: theme.error}]}>{edge.error}</Text> : null}
        {edge.requests.map(r => (
          <PendingCard
            key={`r${r.id}`}
            r={r}
            busy={edge.busy}
            waiting={edge.pressFor === r.id}
            fake={edge.isFake}
            onApprove={() => edge.approve(r.id)}
            onPress={edge.press}
            onDecline={() => edge.decline(r.id)}
          />
        ))}
        {edge.budgets.map(b => (
          <BudgetCard key={b.grantId} b={b} busy={edge.busy} onOpen={() => setOpen(b)} onRevoke={() => edge.revoke(b.grantId)} />
        ))}
        {/* B3: a locked key says nothing - so say that, not "no budget" */}
        {edge.view?.verdict.kind === 'locked' ? (
          <Text style={[styles.dim, {color: theme.warn}]}>Unlock the key to sync. A locked key answers nothing, so its budgets cannot be read.</Text>
        ) : null}
        {edge.view?.verdict.kind !== 'locked' && edge.budgets.length === 0 && edge.requests.length === 0 ? (
          <Text style={styles.dim}>
            No budget. A budget lets an agent use the key a set number of times without a press; you approve it once.
          </Text>
        ) : null}
      </Section>

      {edge.isFake ? (
        <Section title="Fake key (testing)">
          <Text style={styles.dim}>
            A fake key - this build's soft key has no Edge. These do what an agent or the CLI would; the budgets update after each.
          </Text>
          <View style={styles.row}>
            <Btn
              title="Agent: request a budget"
              onPress={() => edge.request('onlykey-js on NITRO16', 'Sign three commits on feature/edge', [{op: OP.SIGN, slot: 101, cap: 3}])}
              disabled={edge.busy}
            />
            <Btn title="Agent: use + OK ticket" onPress={() => edge.act(k => { k.use(`commit ${Date.now() % 100000}`); k.ticket(0x00, 'Used as stated; the target accepted it.'); })} disabled={edge.busy} />
            <Btn title="Agent: use, no ticket" onPress={() => edge.act(k => { k.use(`commit ${Date.now() % 100000}`); })} disabled={edge.busy} />
            <Btn title="Alarm ticket" onPress={() => edge.act(k => { k.use('tag'); k.ticket(0x82, 'Decrypted output may have been written to a shared folder.'); })} disabled={edge.busy} />
            <Btn title="Denied request" onPress={() => edge.act(k => k.deny('decrypt notes.age'))} disabled={edge.busy} />
            <Btn title="Lock (ends budgets)" onPress={() => edge.act(k => k.lock())} disabled={edge.busy} />
            <Btn title="New fake key" onPress={edge.resetFake} disabled={edge.busy} />
          </View>
        </Section>
      ) : (
        <Section title="Soft key (testing)">
          <Text style={styles.dim}>
            The soft key has Edge. Until an agent's MCP server can send requests, this makes one; agent signs come from the CLI or the e2e test.
          </Text>
          <View style={styles.row}>
            <Btn
              title="Agent: request a budget"
              onPress={() => edge.request('testing on this phone', 'Sign three agent messages (P-256)', [{op: OP.SIGN, slot: 222, cap: 3}])}
              disabled={edge.busy}
            />
          </View>
        </Section>
      )}
    </ScrollView>
  );
}


const styles = StyleSheet.create({
  page: {padding: 12, gap: 12},
  verdict: {fontSize: 20, fontWeight: '700', marginBottom: 4},
  dim: {color: theme.textDim, fontSize: 13, lineHeight: 19},
  row: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10},
  budget: {borderWidth: 1, borderColor: theme.border, borderRadius: theme.radius, padding: 10, gap: 6, marginBottom: 8},
  budgetBody: {gap: 6},
  pending: {borderColor: theme.warn, borderStyle: 'dashed'},
  scope: {gap: 4},
  bar: {height: 6, borderRadius: 3, backgroundColor: theme.inputBg, overflow: 'hidden'},
  barFill: {height: 6, backgroundColor: theme.accentHover},
  barThick: {height: 10, borderRadius: 5},
  step: {marginLeft: 44, marginTop: 6, width: 120},
  link: {paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.border},
  unverified: {opacity: 0.45},
  linkHead: {flexDirection: 'row', alignItems: 'center', gap: 10},
  seq: {width: 34, height: 34, borderRadius: 17, borderWidth: 2, alignItems: 'center', justifyContent: 'center'},
  seqText: {color: theme.text, fontFamily: theme.mono, fontSize: 13},
  linkText: {flex: 1},
  op: {color: theme.text, fontSize: theme.fontSize},
  ticket: {marginLeft: 44, marginTop: 6, paddingLeft: 10, borderLeftWidth: 3, gap: 2},
  ticketMissing: {borderLeftColor: theme.warn, borderStyle: 'dashed'},
  waiting: {borderWidth: 1, borderStyle: 'dashed', borderColor: theme.warn, borderRadius: theme.radius, paddingHorizontal: 10, marginTop: 6},
  ticketTitle: {fontWeight: '600', fontSize: 14},
  message: {color: theme.textSecondary, fontSize: 13, lineHeight: 19},
});
