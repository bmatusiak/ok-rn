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
import React, {useEffect, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {codes, live} from 'node-onlykey-lib/edge';
import {Btn, Section, Segmented} from '../ui/components';
import {theme} from '../ui/theme';
import {EdgeList, type EdgeListItem} from '../ui/EdgeList';
import {BottomDrawer, DRAWER_HANDLE} from '../ui/BottomDrawer';
import {BudgetBlock} from '../ui/BudgetBlock';
import {useEdge} from '../hooks/useEdge';
import NativeEdgeAlert from '../../specs/NativeEdgeAlert';
import {onSheet} from '../edgeAgents';
import {consentRefusal, markTestConsent, scopesAreTest} from '../debugGuard';
import {EdgeAgentsCard} from '../ui/EdgeAgentsCard';
import type {EdgeRow, EdgeView, Verdict} from '../edgeStore';
import type {EdgeBudget, EdgeCopyCheck, EdgeRequest} from '../edgeFake';

const {OP, DECISION, FLAG} = codes;

function verdictLine(v: Verdict): {text: string; color: string} {
  switch (v.kind) {
    case 'verified':
      return {
        text: v.through < 0 ? 'Verified: nothing recorded yet' : `Verified through #${v.through}${v.lost?.length ? ` (${v.lost.map(l => (l.from === l.to ? `#${l.from}` : `#${l.from}–#${l.to}`)).join(', ')} accepted as lost)` : ''}`,
        color: theme.ok,
      };
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

/** R27: why Yes is off - the library's reason (src/edge/copy.js), in words. */
function copyProblem(c: EdgeCopyCheck | null): string | null {
  if (!c || c.ok) return null;
  const at = c.seq !== undefined ? ` (#${c.seq})` : '';
  switch (c.reason) {
    case 'restoring': return 'The key was restored from a backup. Finish the restore first.';
    case 'scope': return `A budget's spend does not match what its opening allows (R3)${at}.`;
    case 'chain': return `This phone's copy does not weld to the key${at}.`;
    case 'gap': return c.seq === undefined ? "Links are missing from this phone's copy." : `This phone's copy is missing #${c.seq}${c.to !== undefined && c.to !== c.seq ? `–#${c.to}` : ''}.`;
    case 'checkpoint': return "The key's checkpoint does not verify against this phone's copy.";
    case 'budget-opening-missing': return `A budget in the chain was opened on another device; this phone cannot check it${at}.`;
    case 'budget-opening': return `A budget's opening does not verify${at}.`;
    case 'reveal-missing': return `A self-press has no reveal on this phone${at}.`;
    case 'reveal': return `A self-press reveal does not belong to its budget${at}.`;
    case 'debts': return "The tickets in this phone's copy do not match what the key says is owed.";
    default: return `This phone's copy does not verify: ${c.reason}${at}.`;
  }
}

/* the phone's clock when it first stored the link (links carry no time) */
const seenText = (ms?: number) => (ms ? `seen ${new Date(ms).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'})} · ` : '');
const elapsed = (ms: number) => {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return sec < 3600 ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : `${Math.floor(sec / 3600)} h ${Math.floor((sec % 3600) / 60)} min`;
};

function approval(row: EdgeRow): string {
  const f = row.fields;
  /* a WAIVE (code 0x8F + the press flag): your press accepted uses without their tickets */
  if (f.op === OP.TICKET && f.code === 0x8f && (f.flags & FLAG.PRESS_OBSERVED)) return `waive · pressed (from #${f.refSeq})`;
  if (f.op === OP.TICKET) return `answers no request (#${f.refSeq})`; // only orphans are drawn as rows
  if (f.decision === DECISION.SELF_PRESS) return `self-press · budget ${f.grantId} step ${f.grantStep}`;
  if (f.decision === DECISION.DENY) return 'denied';
  if (f.decision === DECISION.TIMEOUT) return 'timed out';
  /* B7: the key wrote which press this was (flags ARMED / OWES_TICKET) - lib live.classifyUse, as okedge watch */
  const k = live.classifyUse(f)?.kind;
  if (k === live.KIND.MISMATCHED_ARM) return 'pressed · its ARM did not match';
  if (k === live.KIND.PRESS_UNDER_BUDGET) return 'pressed while a budget was live';
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
  /*
   * Waived: you accepted the use without its ticket (a pressed WAIVE link) - there
   * is no ticket to show. Crashed the tab before (the Pixel, 2026-10-04: a waive
   * during the B7 watcher test - t.ticket was null).
   */
  if (t.status === 'waived' || t.status === 'waived-unlisted' || !t.ticket) {
    const by = (t as any).waivedBy as number | null | undefined;
    return (
      <View style={[styles.ticket, {borderLeftColor: theme.warn}]}>
        <Text style={[styles.ticketTitle, {color: theme.warn}]}>Waived</Text>
        <Text style={styles.dim}>{`You accepted this use without its ticket${by ? ` (waive #${by})` : ''}.`}</Text>
      </View>
    );
  }
  const alarm = t.status === 'alarm';
  const code = t.ticket.code;
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

/* B7 stage 2 (spec 2026-10-04): a ticket owed this long is misbehaviour - red */
const OWED_RED_MS = 10 * 60 * 1000;
/* a paid use whose agent said nothing about it within this long: "no reason given" */
const NO_REASON_MS = 60 * 1000;

/** The latest use has no ticket yet - the key still takes one for it (R16). B7: how long it has been owed. */
function WaitingRow({seq, since}: {seq: number; since?: number}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  return (
    <View style={[styles.link, styles.waiting]}>
      <Text style={[styles.ticketTitle, {color: since && now - since > OWED_RED_MS ? theme.error : theme.warn}]}>
        {since ? `${now - since > OWED_RED_MS ? '⚠ ' : ''}Waiting for ticket · owed ${elapsed(now - since)}` : 'Waiting for ticket'}
      </Text>
      <Text style={styles.dim}>{`The agent has not yet said what it did with #${seq}.`}</Text>
    </View>
  );
}

/* R28: how many debts a continue link carried, in words */
const debtsLine = (n: number) => (n === 0 ? 'No debts carried over.' : `${n} debt${n === 1 ? '' : 's'} carried over - still owed here.`);

function LinkRow({row, ticketVerified, budgetUses, agentOf, notesFrom, continued}: {row: EdgeRow; continued?: EdgeView['continued']; ticketVerified: boolean; budgetUses?: Map<number, number>; agentOf?: Map<number, string>; notesFrom?: Map<string, number>}) {
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
            {seenText(row.seenAt)}
            {approval(row)}
            {row.fields.decision === DECISION.SELF_PRESS && budgetUses?.has(row.fields.grantId) ? ` · ${Math.max(0, budgetUses.get(row.fields.grantId)! - row.fields.grantStep)} left` : ''}
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
      {/*
        * B7 stage 2: what the agent said this use was for - its claim, quoted, plain
        * text; only from the agent whose budget paid it (EDGE_NOTE, spec 2026-10-04)
        */}
      {(() => {
        const agent = row.fields.grantId ? agentOf?.get(row.fields.grantId) : undefined;
        if (!agent || (row.fields.op !== OP.SIGN && row.fields.op !== OP.DECRYPT)) return null;
        if (row.note && row.note.agent === agent) {
          return <Text style={styles.reason}>{`the agent says: “${row.note.text}”`}</Text>;
        }
        /* only once this agent sends notes at all: uses from before EDGE_NOTE are not "no reason" */
        const since = notesFrom?.get(agent);
        if (row.fields.decision === DECISION.SELF_PRESS && since !== undefined && row.seenAt && row.seenAt >= since && Date.now() - row.seenAt > NO_REASON_MS) {
          return <Text style={[styles.reason, {color: theme.warn}]}>No reason given - the agent did not say what this use was for.</Text>;
        }
        return null;
      })()}
      {row.ticket ? <TicketHook t={row.ticket} verified={ticketVerified} /> : null}
      {/* the press that opened a budget: a blue receipt, like a ticket (Brad, 2026-10-04) */}
      {row.fields.op === OP.GRANT_CREATE ? (
        <View style={[styles.ticket, {borderLeftColor: theme.link}]}>
          <Text style={[styles.ticketTitle, {color: theme.link}]}>Budget approved</Text>
          <Text style={styles.dim}>{`Budget ${row.fields.grantId} opened with your Yes and a press.`}</Text>
        </View>
      ) : null}
      {/*
        * A budget's other moments, as receipts in the same family (Brad, 2026-10-04):
        * blue = your press opened or resumed it; yellow = needs your attention
        * (on hold, or a press no budget paid); grey = closed.
        */}
      {row.fields.op === OP.GRANT_HOLD ? (
        <View style={[styles.ticket, {borderLeftColor: theme.warn}]}>
          <Text style={[styles.ticketTitle, {color: theme.warn}]}>Budget on hold</Text>
          <Text style={styles.dim}>{`Budget ${row.fields.grantId} pays for nothing until you resume it.`}</Text>
        </View>
      ) : null}
      {row.fields.op === OP.GRANT_RESUME ? (
        <View style={[styles.ticket, {borderLeftColor: theme.link}]}>
          <Text style={[styles.ticketTitle, {color: theme.link}]}>Budget resumed</Text>
          <Text style={styles.dim}>{`Budget ${row.fields.grantId} pays again - resumed with a press.`}</Text>
        </View>
      ) : null}
      {row.fields.op === OP.GRANT_END ? (
        <View style={[styles.ticket, {borderLeftColor: theme.textDim}]}>
          <Text style={[styles.ticketTitle, {color: theme.textDim}]}>Budget ended</Text>
          <Text style={styles.dim}>{`Budget ${row.fields.grantId} is closed - nothing more can spend from it.`}</Text>
        </View>
      ) : null}
      {/* blue: your press registered an agent; red: history gone (a loss you accepted, a wipe) - always visible to an audit */}
      {row.fields.op === OP.AGENT_ADD ? (
        <View style={[styles.ticket, {borderLeftColor: theme.link}]}>
          <Text style={[styles.ticketTitle, {color: theme.link}]}>Agent registered</Text>
          <Text style={styles.dim}>An agent may now ask for budgets - registered with your press.</Text>
        </View>
      ) : null}
      {row.fields.op === OP.LOSS || row.fields.op === OP.WIPE ? (
        <View style={[styles.ticket, {borderLeftColor: theme.error}]}>
          <Text style={[styles.ticketTitle, {color: theme.error}]}>{row.fields.op === OP.LOSS ? 'Loss accepted' : 'Wiped'}</Text>
          <Text style={styles.dim}>
            {row.fields.op === OP.LOSS
              ? 'Links no copy holds were accepted as lost, with your press - the chain says so here.'
              : 'The key was wiped - the chain starts again after this.'}
          </Text>
        </View>
      ) : null}
      {/*
        * R28: the first link of this phone key's OWN chain. Blue: it names exactly the
        * head of an old copy this phone keeps (checked by the lib). Yellow: nothing here
        * to check it against (restored onto this phone). Red: no copy here has that head.
        */}
      {row.fields.op === OP.CONTINUE ? (
        <View style={[styles.ticket, {borderLeftColor: !continued ? theme.textDim : continued.ok ? theme.link : continued.reason === 'no-match' ? theme.error : theme.warn}]}>
          <Text style={[styles.ticketTitle, {color: !continued ? theme.textDim : continued.ok ? theme.link : continued.reason === 'no-match' ? theme.error : theme.warn}]}>This key's own chain starts here</Text>
          <Text style={styles.dim}>
            {!continued
              ? 'Continues another chain - not checked yet.'
              : continued.ok
                ? `Continues #${continued.oldSeq} of chain ${(continued.fromDeviceId ?? '').slice(0, 8)}… - checked against this phone's copy${continued.debtsChecked ? ', debts included' : ''}. ${debtsLine(row.fields.grantId)}`
                : continued.reason === 'no-match'
                  ? `Says it continues #${continued.oldSeq}, but no copy on this phone has that head.`
                  : `Continues #${continued.oldSeq} of a chain this phone cannot check (no full copy here). ${debtsLine(row.fields.grantId)}`}
          </Text>
        </View>
      ) : null}
      {/* a sign or decrypt no budget paid: hung under it like a ticket, in yellow, so it stands out in Presses (Brad, 2026-10-04) */}
      {/* B7: the two presses that should never happen under a budget, in red - they stand out without looking */}
      {live.classifyUse(row.fields)?.alarm ? (
        <View style={[styles.ticket, {borderLeftColor: theme.error}]}>
          <Text style={[styles.ticketTitle, {color: theme.error}]}>
            {live.classifyUse(row.fields)!.kind === live.KIND.MISMATCHED_ARM ? '⚠ ARM did not match' : '⚠ Press during a live budget'}
          </Text>
          <Text style={styles.dim}>
            {live.classifyUse(row.fields)!.kind === live.KIND.MISMATCHED_ARM
              ? 'An agent ARMed the key, but the request that came was not the one it ARMed for - someone else may have jumped in. It needed a press and owes a ticket.'
              : 'A press was asked for while a budget was live, so it owes a ticket (R16). If you did not expect it, hold the budget.'}
          </Text>
        </View>
      ) : (row.fields.op === OP.SIGN || row.fields.op === OP.DECRYPT) && !row.fields.grantId ? (
        <View style={[styles.ticket, {borderLeftColor: theme.warn}]}>
          <Text style={[styles.ticketTitle, {color: theme.warn}]}>No budget</Text>
          <Text style={styles.dim}>{row.fields.decision === DECISION.APPROVE ? 'A press on the key - no budget paid for it.' : 'Asked outside any budget.'}</Text>
        </View>
      ) : null}
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

function BudgetCard({b, busy, onOpen, onRevoke, held, onHold, onResume, waitingResume, onPress, ended = false}: {
  b: EdgeBudget;
  busy: boolean;
  /* its grant-end link is in the chain (ended by hand, revoked): no countdown any more */
  ended?: boolean;
  onOpen?: () => void;
  onRevoke?: () => void;
  /* R15a: on hold, it pays for nothing; Hold needs no press, Resume needs one */
  held?: boolean;
  onHold?: () => void;
  onResume?: () => void;
  waitingResume?: boolean;
  onPress?: () => void;
}) {
  const complete = b.uses > 0 && b.used >= b.uses;
  const body = (
    <>
      <Text style={styles.op}>{b.reason}</Text>
      {b.agent ? <Text style={styles.dim}>{`for ${b.agent}`}</Text> : null}
      {held ? <Text style={[styles.ticketTitle, {color: theme.warn}]}>On hold – it pays for nothing until you resume it</Text> : null}
      <Text style={styles.dim}>{`${b.used} of ${b.uses} uses spent${b.used >= b.uses ? ' – used up' : ''}`}</Text>
      <Progress used={b.used} total={b.uses} thick />
      {scopeLines(b.scopes, b.exact).map((s, i) => (
        <View key={i} style={styles.scope}>
          <Text style={styles.dim}>
            {s.identities.length ? `${opName(s.op)} · ${s.identities.join(' + ')} · slot ${s.slot} · ${s.used} / ${s.cap}` : `${opName(s.op)} · slot ${s.slot} · ${s.used} / ${s.cap}`}
          </Text>
          <Progress used={s.used} total={s.cap} />
        </View>
      ))}
      {/* every use spent: the timer means nothing any more (Brad, 2026-10-04: "replace timer with complete") */}
      {/* ended (its grant-end link): no countdown either - budget 191 on the A13 kept "55 min left" after it ended (Brad, 2026-10-05) */}
      {ended ? (
        <Text style={[styles.ticketTitle, {color: theme.textDim}]}>Ended</Text>
      ) : complete ? (
        <Text style={[styles.ticketTitle, {color: theme.ok}]}>Complete</Text>
      ) : b.endsAt ? (
        <TimeLeft endsAt={b.endsAt} />
      ) : null}
      <Text style={styles.dim}>
        {ended
          ? `Budget ${b.grantId} · ended - nothing more can spend from it.`
          : complete
          ? `Budget ${b.grantId} · every use spent - it pays for nothing more, but covers its identities until it ends.`
          : b.endsAt
            ? `Budget ${b.grantId} · ends at ${new Date(b.endsAt).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})}, or when you lock the key.`
            : `Budget ${b.grantId} · ends when you lock the key.`}
      </Text>
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
      {waitingResume ? (
        <>
          <Text style={[styles.op, {color: theme.warn}]}>Press the key to resume</Text>
          <View style={styles.row}>
            <Btn title="Press the soft key" tone="primary" onPress={() => onPress?.()} />
          </View>
        </>
      ) : onRevoke && complete ? (
        /*
         * every use spent: nothing to hold, but it still COVERS its identities until it
         * ends (R16 - a later pressed use owes a ticket). End writes the grant-end link and
         * frees the key's slot; the agent normally does this itself once its last use is
         * ticketed (spec 2026-10-04).
         */
        <View style={styles.row}>
          <Btn title="End" tone="danger" onPress={onRevoke} disabled={busy} />
        </View>
      ) : onRevoke ? (
        <View style={styles.row}>
          {held && onResume ? <Btn title="Resume" tone="primary" onPress={onResume} disabled={busy} /> : null}
          {!held && onHold ? <Btn title="Hold" onPress={onHold} disabled={busy} /> : null}
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
function PendingCard({r, busy, waiting, fake, blocked, onApprove, onPress, onDecline}: {
  r: EdgeRequest;
  busy: boolean;
  waiting: boolean;
  fake: boolean;
  /** R27: why Approve is off - this phone's copy does not verify */
  blocked: string | null;
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
        <>
          {blocked ? <Text style={[styles.dim, {color: theme.error}]}>{`Approve is off: ${blocked} Nothing is sent to the key.`}</Text> : null}
          <View style={styles.row}>
            <Btn title="Approve" tone="primary" onPress={onApprove} disabled={busy || !!blocked} />
            <Btn title="Decline" onPress={onDecline} disabled={busy} />
          </View>
        </>
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
        <BudgetCard b={b} busy={false} ended={ended} />
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
          <Btn title="Store a stray reply" tone="danger" onPress={() => edge.tamper('stray')} disabled={edge.busy} />
        </View>
      </Section>
    </ScrollView>
  );
}

/**
 * Tickets owed (firmware R16-R18): every approved use, pressed or self-pressed,
 * owes a ticket, and until each is filed or waived nothing automatic happens -
 * no budget, no resume, no self-press. Waive is the way out for uses nobody
 * will ticket: the person's Yes here first, then a press on the key.
 */
function OwedBanner({owed, overflow, edge, confirming, setConfirming, isTest = false}: {
  /* spec rule 10: every owed use belongs to a budget marked TEST: */
  isTest?: boolean;
  owed: number;
  overflow: boolean;
  edge: ReturnType<typeof useEdge>;
  confirming: boolean;
  setConfirming: (on: boolean) => void;
}) {
  const what = `${owed} use${owed === 1 ? '' : 's'} owe${owed === 1 ? 's' : ''} a ticket${overflow ? ', and older ones fell off the key\'s list' : ''}`;
  return (
    <View style={[styles.budget, styles.pending]}>
      <Text style={[styles.ticketTitle, {color: theme.warn}]}>Tickets owed</Text>
      <Text style={styles.op}>{what}</Text>
      <Text style={styles.dim}>No budget, resume or self-press until each is ticketed by its agent, or you waive them here.</Text>
      {edge.pressFor === 'waive' ? (
        <>
          <Text style={[styles.op, {color: theme.warn}]}>Press the key to waive</Text>
          {consentRefusal(isTest) ? <Text style={[styles.op, {color: theme.error}]}>{consentRefusal(isTest)}</Text> : null}
          <View style={styles.row}>
            <Btn title="Press the soft key" tone="primary" disabled={consentRefusal(isTest) !== null} onPress={() => { if (!consentRefusal(isTest)) edge.press(); }} />
          </View>
        </>
      ) : confirming ? (
        <>
          <Text style={styles.dim}>Waive records, in the chain, that you accept these uses without their tickets. It needs a press on the key.</Text>
          <View style={styles.row}>
            {consentRefusal(isTest) ? <Text style={[styles.op, {color: theme.error}]}>{consentRefusal(isTest)}</Text> : null}
            <Btn title="Yes, waive" tone="danger" onPress={() => { if (consentRefusal(isTest)) return; if (isTest) markTestConsent(); setConfirming(false); void edge.waive(); }} disabled={edge.busy || consentRefusal(isTest) !== null} />
            <Btn title="Cancel" onPress={() => setConfirming(false)} disabled={edge.busy} />
          </View>
        </>
      ) : (
        <View style={styles.row}>
          <Btn title="Waive…" onPress={() => setConfirming(true)} disabled={edge.busy} />
        </View>
      )}
    </View>
  );
}

/**
 * B6, after a restore (firmware R26): the key forgot every link after its
 * backup, and the debts they made. Nothing automatic until the person finishes
 * the restore: replay the newest copy this phone has (the Edge Worker's comes
 * later), see where it stopped and why - the end of the copy, or a fork kept as
 * evidence, never smoothed over - then accept "restored to #N" with a press.
 */
function RestoreCard({edge}: {edge: ReturnType<typeof useEdge>}) {
  const r = edge.replay;
  const head = edge.view?.headSeq ?? null;
  return (
    <View style={styles.mismatch}>
      <Text style={[styles.ticketTitle, {color: theme.error}]}>Restore: finish it here</Text>
      <Text style={styles.op}>{`The key was restored from a backup. It forgot everything after #${head ?? '?'}.`}</Text>
      <Text style={styles.dim}>Until you finish, the key opens no budget, resumes none and self-presses nothing. Pressed uses still work.</Text>
      {r ? (
        <>
          <Text style={styles.op}>
            {r.replayedTo > r.keyWas ? `Replayed #${r.keyWas + 1}–#${r.replayedTo} from this phone.` : 'Nothing replayed from this phone.'}
          </Text>
          <Text style={[styles.dim, r.stop.why !== 'end' && {color: theme.error}]}>
            {r.stop.why === 'end'
              ? `This phone's copy ends at #${r.newest}.`
              : r.stop.why === 'fork'
                ? `This phone's copy forks from the key after #${r.stop.at}: the key's head …${r.stop.keyHead.slice(-8)}, this phone's …${r.stop.copyHead.slice(-8)}. Both are kept.`
                : `This phone's copy is missing #${r.stop.at}.`}
          </Text>
          {edge.pressFor === 'restore' ? (
            <>
              <Text style={[styles.op, {color: theme.warn}]}>Press the key to finish</Text>
              <View style={styles.row}>
                <Btn title="Press the soft key" tone="primary" disabled={consentRefusal(false) !== null} onPress={() => { if (!consentRefusal(false)) edge.press(); }} />
              </View>
            </>
          ) : (
            <>
              <Text style={styles.op}>
                {r.vouchedTo < 0 || r.replayedTo < r.vouchedTo
                  ? `Nothing here is vouched for by the key past the backup. Finishing records everything after #${r.keyWas} as lost.`
                  : `Restored to #${r.replayedTo}, vouched by the key; the newest your copies hold is #${r.newest}.${r.newest > r.replayedTo ? ` #${r.replayedTo + 1}–#${r.newest} will be recorded as lost.` : ''}`}
              </Text>
              <View style={styles.row}>
                <Btn title="Finish the restore" tone="primary" onPress={() => edge.finishRestore(Math.max(r.newest, r.replayedTo))} disabled={edge.busy} />
              </View>
            </>
          )}
        </>
      ) : (
        <View style={styles.row}>
          <Btn title="Replay this phone's copy" tone="primary" onPress={edge.replayCopy} disabled={edge.busy} />
        </View>
      )}
    </View>
  );
}

/**
 * The Edge tab: budgets - waiting for you, then approved. A chain (and its
 * verdict) is shown only once you pick a budget (owner, 2026-10-02).
 */
/**
 * testingMode: App's testing mode. The whole tab is testing-mode only today
 * (App.tsx shows it only then), and the key's testing controls below check it
 * themselves too, so they stay hidden when the tab ships to everyone.
 */
export function EdgeScreen({testingMode = false, focusSeq = null, onFocused}: {testingMode?: boolean; focusSeq?: number | null; onFocused?: () => void}) {
  const edge = useEdge();
  const [open, setOpen] = useState<EdgeBudget | null>(null);
  /* two views (Brad, 2026-10-04): the budgets - live, then past as blocks - and the history, the whole chain */
  const [pane, setPane] = useState<'Budgets' | 'Presses'>('Budgets');
  /* B7: opened from an alarm notification - Presses, that link marked */
  const [marked, setMarked] = useState<number | null>(null);
  useEffect(() => {
    if (focusSeq === null) return;
    setPane('Presses');
    setMarked(focusSeq);
    onFocused?.();
  }, [focusSeq, onFocused]);
  const [confirmWaive, setConfirmWaive] = useState(false);
  const [confirmLoss, setConfirmLoss] = useState(false);
  /*
   * An agent's sheet ended (a budget opened, an agent registered): the budgets
   * and the copy moved. ABOVE the early return below: a hook after it ran only
   * while no budget was open, so opening one rendered a hook fewer - React's
   * "Rendered fewer hooks than expected" red box (Brad, 2026-10-03).
   */
  useEffect(() => onSheet(st => {
    if (st?.phase === 'done') void edge.sync();
  }), [edge.sync]); // eslint-disable-line react-hooks/exhaustive-deps

  if (open) {
    /* the live numbers if the budget is still live; the snapshot taken when it was opened if it ended */
    const b = edge.budgets.find(x => x.grantId === open.grantId) ?? open;
    return <BudgetView b={b} edge={edge} onBack={() => setOpen(null)} />;
  }
  /*
   * The mismatch banner (spec okrn-edge-tab.md 4.3): the verdict lives in a
   * budget's chain view, so with no budget open a copy that does not verify
   * would show nowhere. Only when something is wrong; a good copy stays quiet.
   */

  const v = edge.view?.verdict;
  const ks = edge.keyState;
  /* while the key is restoring, the Restore card replaces the banner (spec 4.3) */
  const broken = !ks?.restoring && v && (v.kind === 'tampered' || v.kind === 'gap') ? verdictLine(v) : null;
  const gap = v && v.kind === 'gap' ? {from: v.from, to: v.to} : null;
  const range = gap ? (gap.from === gap.to ? `#${gap.from}` : `#${gap.from}–#${gap.to}`) : '';
  /*
   * THE TRUST LIST (Brad, 2026-10-04): the whole tab is one list, edge to edge
   * (src/ui/EdgeList.tsx) - what needs you first (a restore, a copy that does
   * not verify, tickets owed), the live budgets, then the history: every link
   * in this phone's copy, newest first, each use with its ticket under it. Tap
   * a live budget's link to open its chain. Agents, your identities and the
   * testing panels are in the drawer at the bottom (src/ui/BottomDrawer.tsx).
   */
  /*
   * Spec rule 10: a debt or a loss is "a test" only when every use it covers was
   * spent by a budget whose every identity is marked test on this phone. A gap has no links to look at, so
   * accepting its loss is never a test.
   */
  const budgetIsTest = (grantId: number) => scopesAreTest([...edge.past, ...edge.budgets].find(b => b.grantId === grantId)?.scopes);
  const owedRows = (edge.view?.rows ?? []).filter(r => r.ticket?.status === 'waiting' || r.ticket?.status === 'missing');
  const owedIsTest = owedRows.length > 0 && owedRows.every(r => r.fields.grantId > 0 && budgetIsTest(r.fields.grantId));
  const lossIsTest = (from: number, to: number) => {
    const inRange = (edge.view?.rows ?? []).filter(r => r.seq >= from && r.seq <= to);
    return inRange.length === to - from + 1 && inRange.every(r => r.fields.grantId > 0 && budgetIsTest(r.fields.grantId));
  };
  const items: EdgeListItem[] = [];
  if (ks?.restoring || broken || (ks && !ks.restoring && (ks.owed > 0 || ks.overflow))) {
    items.push({key: 'status', kind: 'node', render: () => (
      <View style={styles.statusStack}>
          {ks?.restoring ? <RestoreCard edge={edge} /> : null}
          {broken ? (
            <View style={styles.mismatch}>
              <Text style={[styles.ticketTitle, {color: theme.error}]}>This phone's copy of the chain does not match the key</Text>
              <Text style={[styles.op, {color: broken.color}]}>{broken.text}</Text>
              <Text style={styles.dim}>
                {`Key's head: #${edge.view?.headSeq ?? '?'}. Until the copy verifies, no budget can be approved here.`}
              </Text>
              {/*
                * The ways out, in the spec's order: Rebuild from a copy (only when a
                * peer holds the range - none yet, so not offered), then Accept loss.
                * Never "verify from a checkpoint" alone.
                */}
              {gap && edge.pressFor === 'loss' ? (
                <>
                  <Text style={[styles.op, {color: theme.warn}]}>Press the key to accept the loss</Text>
                  <View style={styles.row}>
                    <Btn title="Press the soft key" tone="primary" disabled={consentRefusal(false) !== null} onPress={() => { if (!consentRefusal(false)) edge.press(); }} />
                  </View>
                </>
              ) : gap && confirmLoss ? (
                <>
                  <Text style={styles.dim}>
                    {`No copy holds ${range}. Accepting records in the chain, with a press, that ${range} ${gap.from === gap.to ? 'is' : 'are'} gone for good. Budgets can be approved again after it; anything those links owed must still be ticketed or waived.`}
                  </Text>
                  <View style={styles.row}>
                    <Btn title={`Yes, accept loss of ${range}`} tone="danger" onPress={() => { if (consentRefusal(lossIsTest(gap.from, gap.to))) return; setConfirmLoss(false); void edge.acceptLoss(gap.from, gap.to); }} disabled={edge.busy} />
                    <Btn title="Cancel" onPress={() => setConfirmLoss(false)} disabled={edge.busy} />
                  </View>
                </>
              ) : (
                <View style={styles.row}>
                  <Btn title="Sync" tone="primary" onPress={edge.sync} disabled={edge.busy} />
                  {gap ? <Btn title={`Accept loss of ${range}…`} onPress={() => setConfirmLoss(true)} disabled={edge.busy} /> : null}
                </View>
              )}
            </View>
          ) : null}
          {ks && !ks.restoring && (ks.owed > 0 || ks.overflow) ? (
            <OwedBanner owed={ks.owed} overflow={ks.overflow} edge={edge} confirming={confirmWaive} setConfirming={setConfirmWaive} isTest={owedIsTest} />
          ) : null}
      </View>
    )});
  }
  /*
   * Records the copy set aside: they were never links of this chain - a late
   * reply read one report out of step and stored as a link (the A13,
   * 2026-10-04). Said once here so the audit is not silent about it.
   */
  const aside = edge.view?.setAside ?? [];
  if (aside.length) {
    items.push({key: 'setaside', kind: 'node', render: () => (
      <View style={styles.mismatch}>
        <Text style={[styles.op, {color: theme.warn}]}>{`Set aside ${aside.length === 1 ? 'one record' : `${aside.length} records`} that ${aside.length === 1 ? 'was' : 'were'} not a link of this chain`}</Text>
        <Text style={styles.dim}>{`${aside.map(a => (a.seq === null ? '?' : `#${a.seq}`)).join(', ')}: a reply read out of step, stored by mistake. The copy is checked without ${aside.length === 1 ? 'it' : 'them'}.`}</Text>
      </View>
    )});
  }
  /*
   * THE BUDGET RULES FAIL (R3 and the rest of verifyCopy): the tab says so, not only the
   * request sheet (2026-10-04: the tab showed nothing while every request was refused
   * copy_unverified). The fix the spec chose is a LOSS over that budget's links - your press.
   */
  const cc = edge.copyCheck;
  if (cc && !cc.ok && cc.reason !== 'restoring' && cc.reason !== 'gap' && !broken) {
    const atRow = cc.seq !== undefined ? (edge.view?.rows ?? []).find(r => r.seq === cc.seq) : undefined;
    const grant = atRow?.fields.grantId;
    const bud = grant ? edge.past.find(b => b.grantId === grant) ?? edge.budgets.find(b => b.grantId === grant) : undefined;
    const lossFrom = bud?.firstSeq;
    const lossTo = bud?.lastSeq;
    const lossRange = lossFrom !== undefined && lossTo !== undefined ? (lossFrom === lossTo ? `#${lossFrom}` : `#${lossFrom}–#${lossTo}`) : '';
    items.push({key: 'copyfail', kind: 'node', render: () => (
      <View style={styles.mismatch}>
        <Text style={[styles.ticketTitle, {color: theme.error}]}>This phone's copy does not pass the budget rules</Text>
        <Text style={styles.op}>{`${copyProblem(cc) ?? cc.reason}${grant ? ` - budget ${grant}${lossRange ? ` (${lossRange})` : ''}` : ''}`}</Text>
        <Text style={styles.dim}>Until it passes, every agent request is refused (copy_unverified). Accepting the loss records, with a press, that these links are set aside; the copy is checked after them.</Text>
        {lossRange && edge.pressFor === 'loss' ? (
          <>
            <Text style={[styles.op, {color: theme.warn}]}>Press the key to accept the loss</Text>
            <View style={styles.row}><Btn title="Press the soft key" tone="primary" disabled={consentRefusal(false) !== null} onPress={() => { if (!consentRefusal(false)) edge.press(); }} /></View>
          </>
        ) : lossRange && confirmLoss ? (
          <View style={styles.row}>
            <Btn title={`Yes, accept loss of ${lossRange}`} tone="danger" onPress={() => { if (consentRefusal(lossIsTest(lossFrom!, lossTo!))) return; setConfirmLoss(false); void edge.acceptLoss(lossFrom!, lossTo!); }} disabled={edge.busy} />
            <Btn title="Cancel" onPress={() => setConfirmLoss(false)} disabled={edge.busy} />
          </View>
        ) : lossRange ? (
          <View style={styles.row}><Btn title={`Accept loss of ${lossRange}…`} onPress={() => setConfirmLoss(true)} disabled={edge.busy} /></View>
        ) : null}
      </View>
    )});
  }
  items.push({key: 's-budgets', kind: 'section', title: 'Budgets'});
  items.push({key: 'budgets', kind: 'node', render: () => (
    <>
          {edge.error ? <Text style={[styles.dim, {color: theme.error}]}>{edge.error}</Text> : null}
          {edge.requests.map(r => (
            <PendingCard
              key={`r${r.id}`}
              r={r}
              busy={edge.busy}
              waiting={edge.pressFor === `r${r.id}`}
              fake={edge.isFake}
              blocked={copyProblem(edge.copyCheck)}
              onApprove={() => edge.approve(r.id)}
              onPress={edge.press}
              onDecline={() => edge.decline(r.id)}
            />
          ))}
          {edge.budgets.map(b => (
            <BudgetCard
              key={b.grantId}
              b={b}
              busy={edge.busy}
              onOpen={() => setOpen(b)}
              onRevoke={() => edge.revoke(b.grantId)}
              held={edge.keyState?.held.includes(b.grantId)}
              onHold={edge.keyState ? () => edge.hold(b.grantId) : undefined}
              onResume={edge.keyState ? () => edge.resume(b.grantId) : undefined}
              waitingResume={edge.pressFor === `resume:${b.grantId}`}
              onPress={edge.press}
            />
          ))}
          {edge.ended.map(e => (
            <View key={`e${e.grantId}`} style={[styles.budget, styles.ended]}>
              <Text style={[styles.ticketTitle, {color: theme.textDim}]}>Ended when the key locked or restarted</Text>
              <Text style={styles.op}>{e.reason}</Text>
              {e.agent ? (
                <>
                  {/* 4.7a: an agent's budget - the agent asks to continue it; the tab only hides the card */}
                  <Text style={styles.dim}>
                    {`Budget ${e.grantId} for ${e.agent} · ${e.usesLeft} use${e.usesLeft === 1 ? '' : 's'} and ${Math.floor(e.minutesLeft / 60)} h ${e.minutesLeft % 60} min were left. The agent asks to continue it if it still needs it. Dismiss only hides this card; the chain does not change.`}
                  </Text>
                  <View style={styles.row}>
                    <Btn title="Dismiss" onPress={() => edge.dismissEnded(e.grantId)} disabled={edge.busy} />
                  </View>
                </>
              ) : (
                <>
                  <Text style={styles.dim}>
                    {`Budget ${e.grantId} · ${e.usesLeft} use${e.usesLeft === 1 ? '' : 's'} and ${Math.floor(e.minutesLeft / 60)} h ${e.minutesLeft % 60} min left. Continue asks for exactly that – never more – with your Yes and a press.`}
                  </Text>
                  <View style={styles.row}>
                    <Btn title="Continue" tone="primary" onPress={() => edge.continueBudget(e.grantId)} disabled={edge.busy} />
                  </View>
                </>
              )}
            </View>
          ))}
          {/* B3: a locked key says nothing - so say that, not "no budget" */}
          {edge.view?.verdict.kind === 'locked' ? (
            <Text style={[styles.dim, {color: theme.warn}]}>Unlock the key to sync. A locked key answers nothing, so its budgets cannot be read.</Text>
          ) : null}
          {edge.view?.verdict.kind !== 'locked' && edge.budgets.length === 0 && edge.requests.length === 0 && edge.ended.length === 0 ? (
            <Text style={styles.dim}>
              No budget. A budget lets an agent use the key a set number of times without a press; you approve it once.
            </Text>
          ) : null}
    </>
  )});
  /* BUDGET HISTORY (Brad, 2026-10-04): every budget this phone opened that is not live now - tap one for its chain */
  if (edge.past.length) {
    items.push({key: 's-past', kind: 'section', title: 'Past budgets', right: `${edge.past.length}`});
    for (const b of edge.past) {
      items.push({key: `p${b.grantId}`, kind: 'node', bare: true, render: () => <BudgetBlock b={b} onPress={() => setOpen(b)} />});
    }
  }
  const rows = edge.view?.rows ?? [];
  const verifiedAt = new Map(rows.map(r => [r.seq, r.verified]));
  const attached = new Set<number>();
  for (const r of rows) if (r.ticket?.ticket) attached.add(r.ticket.ticket.seq);
  const liveUses = new Map(edge.budgets.map(b => [b.grantId, b.uses]));
  /* each agent's first note (this phone's clock): "no reason given" counts from there */
  const notesFrom = new Map<string, number>();
  for (const r of edge.view?.rows ?? []) {
    if (r.note && !(notesFrom.get(r.note.agent)! <= r.note.at)) notesFrom.set(r.note.agent, Math.min(r.note.at, r.seenAt ?? r.note.at));
  }
  const agentOf = new Map([...edge.past, ...edge.budgets].filter(b => b.agentKey).map(b => [b.grantId, String(b.agentKey).toLowerCase()]));
  /*
   * B7 stage 2: refused ARMs write no link. The key's own count since it started
   * (HEAD byte 60) is the evidence; the agents' notes say which and why (their word).
   */
  const refusedByKey = edge.keyState?.refusedArms ?? 0;
  const reported = (edge.view?.refusals ?? []).slice(-3).reverse();
  if (!edge.isFake && (refusedByKey > 0 || reported.length)) {
    items.push({key: 'live-refused', kind: 'node', render: () => (
      <View style={[styles.mismatch, {borderColor: theme.error}]}>
        <Text style={[styles.ticketTitle, {color: theme.error}]}>
          {refusedByKey > 0 ? `⚠ The key refused ${refusedByKey} ARM${refusedByKey === 1 ? '' : 's'} since it started` : 'Refused ARMs reported by an agent'}
        </Text>
        {reported.map((r, i) => (
          <Text key={i} style={styles.dim}>{`${new Date(r.at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})} · head #${r.seq} · the agent says: “${r.status}”`}</Text>
        ))}
        <Text style={styles.dim}>A refused ARM writes no link. If you did not expect one, hold the budget.</Text>
      </View>
    )});
  }
  /* B7: Hold one tap away while anything is live - stopping an agent never needs navigating */
  const liveNow = edge.budgets.filter(b => !(edge.keyState?.held ?? []).includes(b.grantId) && !(b.uses > 0 && b.used >= b.uses));
  if (!edge.isFake && liveNow.length) {
    items.push({key: 'live-hold', kind: 'node', render: () => (
      <View style={styles.holdBar}>
        {liveNow.map(b => (
          <View key={b.grantId} style={styles.row}>
            <Text style={[styles.op, {flex: 1}]}>{`Budget ${b.grantId} live · ${Math.max(0, b.uses - b.used)} of ${b.uses} left`}</Text>
            <Btn title="Hold" tone="danger" onPress={() => edge.hold(b.grantId)} disabled={edge.busy} />
          </View>
        ))}
      </View>
    )});
  }
  items.push({key: 's-history', kind: 'section', title: 'Presses', right: rows.length ? `#${rows[0].seq} → #${rows[rows.length - 1].seq} · newest first` : 'nothing yet'});
  for (const r of rows) {
    if (r.fields.op === OP.TICKET && attached.has(r.seq)) continue; /* it hangs under its use */
    /* tap: the budget it was for - live or past (Brad, 2026-10-04); a press no budget paid has none */
    const forBudget = r.fields.grantId ? edge.budgets.find(b => b.grantId === r.fields.grantId) ?? edge.past.find(b => b.grantId === r.fields.grantId) : undefined;
    items.push({key: `h${r.seq}`, kind: 'node', bare: true, render: () => {
      const body = (
        <View style={[styles.historyRow, r.seq === marked && styles.marked]}>
          {r.ticket?.status === 'waiting' ? <WaitingRow seq={r.seq} since={r.seenAt} /> : null}
          <LinkRow row={r} continued={edge.view?.continued} budgetUses={liveUses} agentOf={agentOf} notesFrom={notesFrom} ticketVerified={r.ticket?.ticket ? verifiedAt.get(r.ticket.ticket.seq) !== false : true} />
        </View>
      );
      return forBudget ? (
        <Pressable onPress={() => setOpen(forBudget)} accessibilityRole="button" accessibilityLabel={`Open budget ${forBudget.grantId}`}>{body}</Pressable>
      ) : body;
    }});
  }

  return (
    <View style={styles.screen}>
      <View style={styles.paneBar}>
        <Segmented options={['Budgets', 'Presses'] as const} value={pane} onChange={setPane} />
      </View>
      <EdgeList
        items={items.filter(it => it.key === 'status' || (pane === 'Presses') === (it.key === 's-history' || it.key === 'live-hold' || it.key === 'live-refused' || /^h\d/.test(it.key)))}
        bottomInset={DRAWER_HANDLE} refreshing={edge.busy} onRefresh={edge.sync}
      />
      <BottomDrawer title="Agents">
        {edge.isFake ? null : <EdgeAgentsCard onChanged={edge.sync} changed={edge.budgets} inDrawer testingMode={testingMode} />}
        {!testingMode ? null : edge.isFake ? (
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
              <Btn title="Agent: one pressed sign" onPress={edge.agentSign} disabled={edge.busy} />
            </View>
            {/*
              * B7 stage 2's heartbeat test (spec 2026-10-04): hang the JS thread for good,
              * the way a dead JS side would look - no beats, no cleanup. The native
              * watchdog must post "Edge watching stopped" within ~30 s. Restart the app after.
              */}
            <View style={styles.row}>
              <Btn title="Freeze JS (test)" tone="danger" onPress={() => { for (;;) { /* never returns */ } }} />
              <Btn
                title="Post a test Edge alarm"
                onPress={() => NativeEdgeAlert?.post(edge.view?.headSeq ?? 0, 'Edge: test alarm', 'A test alarm from the testing panel.', `budget ${edge.budgets.map(b => b.grantId).join(', ') || '-'}`, false)}
              />
            </View>
          </Section>
        )}
      </BottomDrawer>
    </View>
  );
}


/*
 * One line per op+slot. The chain says which budget and step paid, not which
 * of two scopes on the same slot (see edgeSoftKey budgets()), so scopes that
 * share op and slot are one line: their identities, one count, their caps added.
 */
function scopeLines(scopes: EdgeBudget['scopes'], exact = false) {
  const out: {op: number; slot: number; identities: string[]; used: number; cap: number}[] = [];
  /* R3: when every spend named its scope, each identity is its own line with its own count */
  if (exact) return scopes.map(s => ({op: s.op, slot: s.slot, identities: s.identity ? [s.identity] : [], used: s.used, cap: s.cap}));
  for (const s of scopes) {
    const line = out.find(l => l.op === s.op && l.slot === s.slot);
    if (line) {
      if (s.identity) line.identities.push(s.identity);
      line.cap += s.cap;
    } else {
      out.push({op: s.op, slot: s.slot, identities: s.identity ? [s.identity] : [], used: s.used, cap: s.cap});
    }
  }
  return out;
}

/*
 * A budget's countdown (Brad, 2026-10-03: "a countdown to things that expire"):
 * minutes left, then m:ss in the last minute; red in the last five minutes.
 */
function TimeLeft({endsAt}: {endsAt: number}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const sec = Math.max(0, Math.ceil((endsAt - now) / 1000));
  const text = sec === 0 ? 'ended'
    : sec < 60 ? `0:${String(sec).padStart(2, '0')} left`
    : sec < 3600 ? `${Math.ceil(sec / 60)} min left`
    : `${Math.floor(sec / 3600)} h ${Math.floor((sec % 3600) / 60)} min left`;
  return <Text style={[styles.op, {fontWeight: '700', color: sec <= 300 ? theme.error : theme.warn}]}>{text}</Text>;
}

const styles = StyleSheet.create({
  reason: {color: theme.textDim, fontStyle: 'italic', marginTop: 4, marginLeft: 56},
  holdBar: {paddingHorizontal: 16, paddingVertical: 8, gap: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border},
  page: {padding: 12, gap: 12},
  /* the trust list: the screen is the list (src/ui/EdgeList.tsx), with the drawer's handle over its foot */
  screen: {flex: 1},
  statusStack: {gap: 12},
  historyRow: {paddingHorizontal: 16},
  marked: {borderLeftWidth: 4, borderLeftColor: theme.error},
  paneBar: {paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border},
  verdict: {fontSize: 20, fontWeight: '700', marginBottom: 4},
  dim: {color: theme.textDim, fontSize: 13, lineHeight: 19},
  row: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10},
  budget: {borderWidth: 1, borderColor: theme.border, borderRadius: theme.radius, padding: 10, gap: 6, marginBottom: 8},
  budgetBody: {gap: 6},
  pending: {borderColor: theme.warn, borderStyle: 'dashed'},
  ended: {borderStyle: 'dashed', opacity: 0.85},
  mismatch: {borderWidth: 2, borderColor: theme.error, borderRadius: theme.radius, padding: 12, gap: 6},
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
