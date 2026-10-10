/**
 * Edge: what the key decided, as a chain the phone verifies (spec
 * onlykey-edge/build/okrn-edge-tab.md 4.3), top to bottom:
 *   1. the verdict card - verified / gap / tampered / not synced
 *   2. budgets - what an agent may still do without a press
 *   3. the chain - newest first, each use with its receipt hanging from it
 *   4. (testing) the soft key's test controls
 *
 * Driven by a FAKE key until the soft key's Edge plugin exists (E3), so the
 * whole tab is testing-mode only. Receipt messages are written by an agent:
 * plain text, never links or markdown.
 */
import React, {useEffect, useState} from 'react';
import {bytes as okbytes} from 'node-onlykey-lib';
import {BackHandler, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
import {grants, codes} from 'node-onlykey-lib/edge';
import {Btn, Section, Segmented} from '../ui/components';
import {theme} from '../ui/theme';
import {EdgeList, EdgeListEntry, type EdgeListItem} from '../ui/EdgeList';
import {BottomDrawer, DRAWER_HANDLE} from '../ui/BottomDrawer';
import {BudgetBlock} from '../ui/BudgetBlock';
import {budgetStatus, budgetStatusText, type BudgetStatus} from '../budgetStatus';
import {useEdge} from '../hooks/useEdge';
import NativeEdgeAlert from '../../specs/NativeEdgeAlert';
import {onSheet} from '../edgeAgents';
import {consentRefusal} from '../debugGuard';
import {YourDevicesCard} from '../ui/YourDevicesCard';
import {MergeSheet} from '../ui/MergeSheet';
import {useYourDevices, type DeviceLink, type YourDevice} from '../hooks/useYourDevices';
import {bannerLine, onDevicesChanged, waitingCount} from '../edgeDevices';
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
    case 'gap': {
      /* say what IS checked, then what is not (spec, 2026-10-05) - not "Gap #0–#268 unverifiable" */
      const range = v.from === v.to ? `#${v.from}` : `#${v.from}–#${v.to}`;
      const checked = v.from === 0 ? `Checked from #${v.to + 1} on` : `Checked through #${v.from - 1} and from #${v.to + 1} on`;
      return {text: `${checked}. ${range} can't be checked on this phone.`, color: theme.warn};
    }
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
    case 'scope': return `A budget's spend does not match what its opening allows (R3)${at}.`;
    case 'chain': return `This phone's copy does not weld to the key${at}.`;
    case 'gap': return c.seq === undefined ? "Links are missing from this phone's copy." : `This phone's copy is missing #${c.seq}${c.to !== undefined && c.to !== c.seq ? `–#${c.to}` : ''}.`;
    case 'checkpoint': return "The key's checkpoint does not verify against this phone's copy.";
    case 'budget-opening-missing': return `A budget in the chain was opened on another device; this phone cannot check it${at}.`;
    case 'budget-opening': return `A budget's opening does not verify${at}.`;
    case 'reveal-missing': return `A self-press has no reveal on this phone${at}.`;
    case 'reveal': return `A self-press reveal does not belong to its budget${at}.`;
    case 'debts': return "The receipts in this phone's copy do not match what the key says is owed.";
    default: return `This phone's copy does not verify: ${c.reason}${at}.`;
  }
}

/* the phone's clock when it first stored the link (links carry no time) */
/* R30: the other key's rings - a colour of its own (yours to change) */
const SIBLING_RING = '#c4a1ff';
/* the newest of an anchor's group shown at first */
const SIBLING_FIRST = 5;

const seenText = (ms?: number) => (ms ? `seen ${new Date(ms).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'})} · ` : '');
const elapsed = (ms: number) => {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return sec < 3600 ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : `${Math.floor(sec / 3600)} h ${Math.floor((sec % 3600) / 60)} min`;
};

function approval(row: EdgeRow): string {
  const f = row.fields;
  /* a SETTLE (code 0x8F + the press flag): your press accepted uses without their receipts */
  if (f.op === OP.RECEIPT && f.code === 0x8f && (f.flags & FLAG.PRESS_OBSERVED)) return `settle · pressed (from #${f.refSeq})`;
  if (f.op === OP.RECEIPT) return `answers no request (#${f.refSeq})`; // only orphans are drawn as rows
  if (f.decision === DECISION.SELF_PRESS) return `self-press · budget ${f.grantId} step ${f.grantStep}`;
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

function ReceiptHook({t, verified, seq, since, edge}: {t: NonNullable<EdgeRow['receipt']>; verified: boolean; seq: number; since?: number; edge?: ReturnType<typeof useEdge>}) {
  if (t.status === 'no-receipt-owed') return null;
  /* WHERE THE RECEIPT WILL HANG (Brad, 2026-10-06): under the use it waits for, not a box above it; Settle is here in the budget's view */
  if (t.status === 'waiting') return <WaitingReceipt seq={seq} since={since} edge={edge} />;
  if (t.status === 'missing') {
    return (
      <View style={[styles.receipt, styles.receiptMissing]}>
        <Text style={[styles.receiptTitle, {color: theme.warn}]}>No receipt</Text>
        <Text style={styles.dim}>The agent did not say what it did with this.</Text>
      </View>
    );
  }
  /*
   * Settled: you accepted the use without its receipt (a pressed SETTLE link) - there
   * is no receipt to show. Crashed the tab before (the Pixel, 2026-10-04: a settle
   * during the B7 watcher test - t.receipt was null).
   */
  if (t.status === 'settled' || t.status === 'settled-unlisted' || !t.receipt) {
    const by = (t as any).settledBy as number | null | undefined;
    return (
      <View style={[styles.receipt, {borderLeftColor: theme.warn}]}>
        <Text style={[styles.receiptTitle, {color: theme.warn}]}>Settled</Text>
        <Text style={styles.dim}>{`You accepted this use without its receipt${by ? ` (settle #${by})` : ''}.`}</Text>
      </View>
    );
  }
  const alarm = t.status === 'alarm';
  const code = t.receipt.code;
  const color = alarm ? theme.error : code < 0x10 ? theme.ok : theme.textDim;
  const name = t.receipt!.name ?? `unknown code 0x${code.toString(16).padStart(2, '0')}`;
  return (
    <View style={[styles.receipt, {borderLeftColor: color}]}>
      <Text style={[styles.receiptTitle, {color}]}>
        {alarm ? `⚠ ${name}` : name}
        <Text style={styles.dim}>{`  receipt #${t.receipt!.seq}${verified ? '' : ' · unverifiable'}`}</Text>
      </Text>
      {t.message !== null && t.message !== undefined ? (
        <Text style={styles.message}>{t.message}</Text>
      ) : (
        <Text style={styles.dim}>
          {t.messageStatus === 'mismatch' ? 'Message does not match the receipt - not shown.' : 'No message synced.'}
        </Text>
      )}
    </View>
  );
}

/* B7 stage 2 (spec 2026-10-04): a receipt owed this long is misbehaviour - red */
const OWED_RED_MS = 10 * 60 * 1000;
/* a paid use whose agent said nothing about it within this long: "no reason given" */
const NO_REASON_MS = 60 * 1000;

/** The latest use has no receipt yet - the key still takes one for it (R16). B7: how long it has been owed. */
function WaitingReceipt({seq, since, edge}: {seq: number; since?: number; edge?: ReturnType<typeof useEdge>}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  return (
    <View style={[styles.receipt, {borderLeftColor: since && now - since > OWED_RED_MS ? theme.error : theme.warn}]}>
      <Text style={[styles.receiptTitle, {color: since && now - since > OWED_RED_MS ? theme.error : theme.warn}]}>
        {since ? `${now - since > OWED_RED_MS ? '⚠ ' : ''}Waiting for receipt · owed ${elapsed(now - since)}` : 'Waiting for receipt'}
      </Text>
      <Text style={styles.dim}>{`The agent has not yet said what it did with #${seq}.`}</Text>
      {/* the settle lives here, at the use that owes (Brad, 2026-10-06: "move the waive button there") - not as a banner on the budgets list */}
      {edge ? <SettleControls edge={edge} /> : null}
    </View>
  );
}

/* R28: how many debts a continue link carried, in words */
const debtsLine = (n: number) => (n === 0 ? 'No debts carried over.' : `${n} debt${n === 1 ? '' : 's'} carried over - still owed here.`);

const deviceName = (d: YourDevice) => d.nametag ?? `Device ${d.deviceId.slice(0, 8)}…`;

/* one link of another device of yours, as this phone holds it - its own ring colour, its nametag, when this phone got it (2026-10-08) */
function DeviceRow({device: c, link: l}: {device: YourDevice; link: DeviceLink}) {
  return (
    <View style={[styles.historyRow, styles.siblingRow]}>
      <View style={styles.link}>
        <View style={styles.linkHead}>
          <View style={[styles.seq, {borderColor: SIBLING_RING}]}>
            <Text style={styles.seqText}>{l.seq}</Text>
          </View>
          <View style={styles.linkText}>
            <Text style={styles.op}>{`${deviceName(c)} · ${opName(l.op)}${l.op === OP.SIGN || l.op === OP.DECRYPT ? ` · slot ${l.slot}` : ''}`}</Text>
            <Text style={styles.dim}>{`${l.seenAt ? `seen here ${new Date(l.seenAt).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'})} via sync` : 'via sync'}${l.flags & FLAG.PRESS_OBSERVED ? ' · pressed' : ''}`}</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

function LinkRow({row, receiptVerified, budgetUses, agentOf, notesFrom, continued, edge}: {row: EdgeRow; continued?: EdgeView['continued']; receiptVerified: boolean; budgetUses?: Map<number, number>; agentOf?: Map<number, string>; notesFrom?: Map<string, number>; edge?: ReturnType<typeof useEdge>}) {
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
        if (row.fields.op !== OP.SIGN && row.fields.op !== OP.DECRYPT) return null;
        /*
         * R13b (Brad, 2026-10-06): the intent is welded into the link (bytes 47-62).
         * The agent's text shows as the intent only when it hashes to those bytes;
         * text that does not is red; no text is "intent unknown". The audit reads
         * top-down: the budget's reason (task), each use's intent (step), its receipt (result).
         */
        const intent = (row.fields as {intent?: Uint8Array | null}).intent ?? null;
        if (intent) {
          if (!row.note) return <Text style={[styles.reason, {color: theme.warn}]}>intent unknown</Text>;
          if (okbytes.toHex(grants.intentOf(row.note.text)) === okbytes.toHex(intent)) return <Text style={styles.reason}>{`intent: “${row.note.text}”`}</Text>;
          return <Text style={[styles.reason, {color: theme.error}]}>{`the agent says “${row.note.text}” - it does not match the intent in the chain`}</Text>;
        }
        const agent = row.fields.grantId ? agentOf?.get(row.fields.grantId) : undefined;
        if (!agent) return null;
        if (row.note && row.note.computer === agent) {
          return <Text style={styles.reason}>{`no intent · the agent says: “${row.note.text}”`}</Text>;
        }
        /* only once this agent sends notes at all: uses from before EDGE_NOTE are not "no reason" */
        const since = notesFrom?.get(agent);
        if (row.fields.decision === DECISION.SELF_PRESS && since !== undefined && row.seenAt && row.seenAt >= since && Date.now() - row.seenAt > NO_REASON_MS) {
          return <Text style={[styles.reason, {color: theme.warn}]}>No reason given - the agent did not say what this use was for.</Text>;
        }
        return null;
      })()}
      {row.receipt ? <ReceiptHook t={row.receipt} verified={receiptVerified} seq={row.seq} since={row.seenAt} edge={edge} /> : null}
      {/* the press that opened a budget: a blue receipt, like a receipt (Brad, 2026-10-04) */}
      {row.fields.op === OP.GRANT_CREATE ? (
        <View style={[styles.receipt, {borderLeftColor: theme.link}]}>
          <Text style={[styles.receiptTitle, {color: theme.link}]}>Budget approved</Text>
          <Text style={styles.dim}>{`Budget ${row.fields.grantId} opened with your Yes and a press.`}</Text>
        </View>
      ) : null}
      {/*
        * A budget's other moments, as receipts in the same family (Brad, 2026-10-04):
        * blue = your press opened or resumed it; yellow = needs your attention
        * (on hold, or a press no budget paid); grey = closed.
        */}
      {row.fields.op === OP.GRANT_HOLD ? (
        <View style={[styles.receipt, {borderLeftColor: theme.warn}]}>
          <Text style={[styles.receiptTitle, {color: theme.warn}]}>Budget on hold</Text>
          <Text style={styles.dim}>{`Budget ${row.fields.grantId} pays for nothing until you resume it.`}</Text>
        </View>
      ) : null}
      {row.fields.op === OP.GRANT_RESUME ? (
        <View style={[styles.receipt, {borderLeftColor: theme.link}]}>
          <Text style={[styles.receiptTitle, {color: theme.link}]}>Budget resumed</Text>
          <Text style={styles.dim}>{`Budget ${row.fields.grantId} pays again - resumed with a press.`}</Text>
        </View>
      ) : null}
      {row.fields.op === OP.GRANT_END ? (
        <View style={[styles.receipt, {borderLeftColor: theme.textDim}]}>
          <Text style={[styles.receiptTitle, {color: theme.textDim}]}>Budget ended</Text>
          <Text style={styles.dim}>{`Budget ${row.fields.grantId} is closed - nothing more can spend from it.`}</Text>
        </View>
      ) : null}
      {/* blue: an old agent registration (retired 2026-10-08 - a chain that has one still reads); red: history gone (a loss you accepted, a wipe) - always visible to an audit */}
      {row.fields.op === OP.AGENT_ADD ? (
        <View style={[styles.receipt, {borderLeftColor: theme.link}]}>
          <Text style={[styles.receiptTitle, {color: theme.link}]}>Agent registered (old)</Text>
          <Text style={styles.dim}>From before agents stopped registering: a paired computer may ask for budgets, no registration needed.</Text>
        </View>
      ) : null}
      {row.fields.op === OP.LOSS ? (
        <View style={[styles.receipt, {borderLeftColor: theme.error}]}>
          <Text style={[styles.receiptTitle, {color: theme.error}]}>{row.fields.op === OP.LOSS ? 'Loss accepted' : 'Wiped'}</Text>
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
        <View style={[styles.receipt, {borderLeftColor: !continued ? theme.textDim : continued.ok ? theme.link : continued.reason === 'no-match' ? theme.error : theme.warn}]}>
          <Text style={[styles.receiptTitle, {color: !continued ? theme.textDim : continued.ok ? theme.link : continued.reason === 'no-match' ? theme.error : theme.warn}]}>This key's own chain starts here</Text>
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
    </View>
  );
}

/**
 * Newest first. A receipt ATTACHED to its request is drawn only under that
 * request (owner, 2026-10-02); a receipt that answers no request keeps a row of
 * its own, since there is nothing to hang it from.
 */
function ChainList({rows, budgetUses, edge}: {rows: EdgeRow[]; budgetUses?: Map<number, number>; edge?: ReturnType<typeof useEdge>}) {
  const verified = new Map(rows.map(r => [r.seq, r.verified]));
  const attached = new Set<number>();
  for (const r of rows) if (r.receipt?.receipt) attached.add(r.receipt.receipt.seq);
  return (
    <>
      {rows
        .filter(r => !(r.fields.op === OP.RECEIPT && attached.has(r.seq)))
        .map(r => (
          <React.Fragment key={r.seq}>
            <LinkRow row={r} edge={edge} budgetUses={budgetUses} receiptVerified={r.receipt?.receipt ? verified.get(r.receipt.receipt.seq) !== false : true} />
          </React.Fragment>
        ))}
    </>
  );
}

/* the status word's colour: green done or live, yellow a receipt owed, red a failed check */
export function statusColor(s: BudgetStatus): string {
  if (s.kind === 'failed') return theme.error;
  if (s.kind === 'unchecked') return theme.textDim;
  if (s.kind === 'active' && s.owed > 0) return theme.warn;
  return theme.ok;
}

export function BudgetCard({b, busy, stopping = false, onOpen, onRevoke, held, onHold, onResume, waitingResume, onPress, status, heading, footer}: {
  b: EdgeBudget;
  /* the budget view's "Budget N", inside the card (Brad, 2026-10-06) */
  heading?: string;
  /* the budget view's steps line, at the card's bottom (Brad, 2026-10-06) */
  footer?: React.ReactNode;
  busy: boolean;
  /* rule 8: Hold / Revoke / End wait only for one of themselves in flight - never for the tab's background work (busy) */
  stopping?: boolean;
  /* Active / Ended · N owed / Validated / red (budgetStatus - never stored): an ended one has no countdown */
  status: BudgetStatus;
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
      {heading ? <Text style={{color: theme.text, fontSize: 15, fontWeight: '700'}}>{heading}</Text> : null}
      <Text style={styles.op}>{b.reason}</Text>
      {b.agent ? <Text style={styles.dim}>{`for ${b.agent}`}</Text> : null}
      {held ? <Text style={[styles.receiptTitle, {color: theme.warn}]}>On hold – it pays for nothing until you resume it</Text> : null}
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
      {/*
        THE STATUS WORD (Brad, 2026-10-06): Active; Ended · N receipts owed; Validated
        only when ended and every use's receipt verified in the copy checked this
        session; red when the copy fails. Every use spent: no timer (2026-10-04);
        ended: no countdown either - budget 191 on the A13 kept "55 min left" (2026-10-05).
      */}
      <Text style={[styles.receiptTitle, {color: statusColor(status)}]}>{budgetStatusText(status)}</Text>
      {status.kind === 'active' && status.live && !complete && b.endsAt ? <TimeLeft endsAt={b.endsAt} /> : null}
      <Text style={styles.dim}>
        {status.kind === 'active' && !status.live
          ? `Budget ${b.grantId} · nothing more can spend from it - it stays active until its last receipt is filed.`
          : status.kind !== 'active'
          ? `Budget ${b.grantId} · ended - nothing more can spend from it.`
          : complete
          ? `Budget ${b.grantId} · every use spent - it pays for nothing more, but covers its identities until it ends.`
          : b.endsAt
            ? `Budget ${b.grantId} · ends at ${new Date(b.endsAt).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})}, or when you lock the key.`
            : `Budget ${b.grantId} · ends when you lock the key.`}
      </Text>
      {footer}
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
          {consentRefusal() ? <Text style={[styles.op, {color: theme.error}]}>{consentRefusal()}</Text> : null}
          <View style={styles.row}>
            <Btn title="Press the soft key" tone="primary" disabled={consentRefusal() !== null} onPress={() => { if (!consentRefusal()) onPress?.(); }} />
          </View>
        </>
      ) : onRevoke && complete ? (
        /*
         * every use spent: nothing to hold, but it still COVERS its identities until it
         * ends (R16 - a later pressed use owes a receipt). End writes the grant-end link and
         * frees the key's slot; the agent normally does this itself once its last use is
         * receipted (spec 2026-10-04).
         */
        <View style={styles.row}>
          <Btn title="End" tone="danger" onPress={onRevoke} disabled={stopping} />
        </View>
      ) : onRevoke ? (
        <View style={styles.row}>
          {held && onResume ? <Btn title="Resume" tone="primary" onPress={() => { if (!consentRefusal()) onResume(); }} disabled={busy || consentRefusal() !== null} /> : null}
          {!held && onHold ? <Btn title="Hold" onPress={onHold} disabled={stopping} /> : null}
          <Btn title="Revoke" tone="danger" onPress={onRevoke} disabled={stopping} />
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
function PendingCard({r, busy, waiting, blocked, onApprove, onPress, onDecline}: {
  r: EdgeRequest;
  busy: boolean;
  waiting: boolean;
  /** R27: why Approve is off - this phone's copy does not verify */
  blocked: string | null;
  onApprove: () => void;
  onPress: () => void;
  onDecline: () => void;
}) {
  const uses = r.scopes.reduce((n, sc) => n + sc.cap, 0);
  return (
    <View style={[styles.budget, styles.pending]}>
      <Text style={[styles.receiptTitle, {color: theme.warn}]}>Waiting for you</Text>
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
            {'This phone is also the key, so its press proves less than a hard key\'s. The key stops waiting after 20 s.'}
          </Text>
          <View style={styles.row}>
            {/* not disabled while busy: the request IS what is in flight, waiting for this */}
            <Btn title="Press the soft key" tone="primary" disabled={consentRefusal() !== null} onPress={() => { if (!consentRefusal()) onPress(); }} />
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
 * (each with its receipt), and its end. Its steps must run 1, 2, 3...
 */
/*
 * ANOTHER DEVICE'S BUDGET (Brad, 2026-10-09: "full cards"): its card - words checked against its
 * log at the merge - and its links as merged from that device, newest first. Nothing here reads
 * this phone's chain: that device numbers its budgets from 1 as this one does.
 */
function DeviceBudgetView({b, device, onBack}: {b: EdgeBudget; device: YourDevice | undefined; onBack: () => void}) {
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onBack(); return true; });
    return () => sub.remove();
  }, [onBack]);
  const links = (device?.links ?? []).filter(l => l.grantId === b.grantId);
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.row}>
        <Btn title="‹ Back" onPress={onBack} />
      </View>
      <BudgetCard b={b} busy={false} heading={`Budget ${b.grantId}`} status={budgetStatus(b, false, null)} footer={
        <Text style={styles.dim}>{`On ${b.device ?? 'another device'}${device?.mergedUpTo !== null && device?.mergedUpTo !== undefined ? ` · merged up to #${device.mergedUpTo}` : ''}`}</Text>
      } />
      {device ? links.map(l => <DeviceRow key={l.seq} device={device} link={l} />) : null}
    </ScrollView>
  );
}

/* other: another device's budget - its own chain view, read-only (no Settle, no copy tools), its name on the card */
function BudgetView({b, edge, onBack, other}: {b: EdgeBudget; edge: ReturnType<typeof useEdge>; onBack: () => void; other?: {view: EdgeView; name: string}}) {
  /* the phone's own Back (button or gesture) goes back too, as the ‹ Back button does (Brad, 2026-10-07) */
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onBack(); return true; });
    return () => sub.remove();
  }, [onBack]);
  const v = other ? other.view : edge.view;
  const line = v ? verdictLine(v.verdict) : {text: 'Reading…', color: theme.textDim};
  /* oldest first, only to check its steps ran 1, 2, 3; the view lists its presses newest first,
     like the Presses tab, so a pending receipt shows at once (Brad, 2026-10-06) */
  const mine = budgetRows(v?.rows ?? [], b.grantId).slice().reverse();
  const steps = mine.filter(r => r.fields.decision === DECISION.SELF_PRESS).map(r => r.fields.grantStep);
  const inOrder = steps.every((st, i) => st === i + 1);
  const ended = mine.some(r => r.fields.op === OP.GRANT_END);
  /* the Presses tab's rows for this budget, drawn as that tab draws them (Brad, 2026-10-06) */
  const all = v?.rows ?? [];
  const verifiedAt = new Map(all.map(r => [r.seq, r.verified]));
  const attached = new Set<number>();
  for (const r of all) if (r.receipt?.receipt) attached.add(r.receipt.receipt.seq);
  const liveUses = other ? new Map<number, number>() : new Map(edge.budgets.map(x => [x.grantId, x.uses]));
  const notesFrom = new Map<string, number>();
  for (const r of all) {
    if (r.note && !(notesFrom.get(r.note.computer)! <= r.note.at)) notesFrom.set(r.note.computer, Math.min(r.note.at, r.seenAt ?? r.note.at));
  }
  const agentOf = other ? new Map<number, string>() : new Map([...edge.past, ...edge.budgets].filter(x => x.computerId).map(x => [x.grantId, String(x.computerId)]));
  const presses: EdgeListItem[] = [{key: 's-presses', kind: 'section', title: other ? `Presses on ${other.name}` : 'Presses'}];
  for (const r of all) {
    if (r.fields.grantId !== b.grantId) continue;
    if (r.fields.op === OP.RECEIPT && attached.has(r.seq)) continue; /* it hangs under its use */
    presses.push({key: `h${r.seq}`, kind: 'node', bare: true, render: () => (
      <View style={styles.historyRow}>
        {/* edge: an owed receipt shows the Settle controls under it, as the old list did */}
        <LinkRow row={r} edge={other ? undefined : edge} continued={v?.continued} budgetUses={liveUses} agentOf={agentOf} notesFrom={notesFrom} receiptVerified={r.receipt?.receipt ? verifiedAt.get(r.receipt.receipt.seq) !== false : true} />
      </View>
    )});
  }
  return (
    /* pull = the old chain panel's Sync (Brad, 2026-10-06): read what is new and validate the whole copy from the root */
    <ScrollView contentContainerStyle={styles.page} refreshControl={<RefreshControl refreshing={edge.busy} onRefresh={edge.fullSync} />}>
      <View style={styles.row}>
        <Btn title="‹ Back" onPress={onBack} />
      </View>
      <BudgetCard b={b} busy={false} heading={`Budget ${b.grantId}`} status={budgetStatus(b, !other && edge.budgets.some(x => x.grantId === b.grantId), v)} footer={
        <Text style={[styles.dim, {color: inOrder ? theme.textDim : theme.error}]}>
          {steps.length === 0
            ? 'Nothing spent from it yet.'
            : inOrder
              ? `${steps.length === 1 ? 'Step 1' : `Steps 1–${steps.length}`} spent in order${ended ? '; ended' : ''}.`
              : `Steps out of order: ${steps.join(', ')}`}
        </Text>
      } />
      {/* the whole chain's verdict, the key's head, the last sync - under the card (Brad, 2026-10-06) */}
      <Text style={[styles.verdict, {color: line.color}]}>{line.text}</Text>
      <Text style={styles.dim}>
        {v?.headSeq !== null && v?.headSeq !== undefined ? `Key's head: #${v.headSeq}` : 'Key not read yet'}
        {v?.lastSync ? ` · last sync ${new Date(v.lastSync).toLocaleTimeString()} (phone clock)` : ''}
      </Text>
      {edge.error ? <Text style={[styles.dim, {color: theme.error}]}>{edge.error}</Text> : null}
      {other ? <Text style={styles.dim}>{`On ${other.name}`}</Text> : null}
      {presses.map(it => <EdgeListEntry key={it.key} item={it} />)}
      {other ? null : <Section title="This phone's copy (testing)">
        <Text style={styles.dim}>
          Edits change only this phone's copy of the chain, the way an attacker could. Verify shows what they break; Sync heals
          what the key still holds.
        </Text>
        <View style={styles.row}>
          <Btn title="Verify" onPress={edge.verify} disabled={edge.busy} />
          <Btn title="Flip a byte" tone="danger" onPress={() => edge.tamper('flip')} disabled={edge.busy} />
          <Btn title="Flip a receipt" tone="danger" onPress={() => edge.tamper('receipt')} disabled={edge.busy} />
          <Btn title="Delete a link" tone="danger" onPress={() => edge.tamper('delete')} disabled={edge.busy} />
          <Btn title="Swap two" tone="danger" onPress={() => edge.tamper('swap')} disabled={edge.busy} />
          <Btn title="Cut the tail" tone="danger" onPress={() => edge.tamper('truncate')} disabled={edge.busy} />
          <Btn title="Forget copy" onPress={() => edge.tamper('forget')} disabled={edge.busy} />
          <Btn title="Store a stray reply" tone="danger" onPress={() => edge.tamper('stray')} disabled={edge.busy} />
        </View>
      </Section>}
    </ScrollView>
  );
}

/**
 * Receipts owed (firmware R16-R18): every budget use owes a receipt, and until each
 * is filed or settled nothing automatic happens - no TX start, no new budget, no resume.
 * Settle is the way out for uses nobody will receipt (a signer that died mid-stream):
 * the person's Yes here first, then a press on the key.
 */
/*
 * SETTLE SETTLES THE BUDGET (Brad, 2026-10-10: "its more secure to just end the budget instead
 * of allowing it to be continue to be used; this will force a new budget to be created by the
 * agent"): the key ends every live budget, each with its end link, then links the settle - the
 * person accepts every owed use without its receipt. In the budget's detail view, under the use
 * that is waiting for its receipt (Brad, 2026-10-06), not a banner on the list.
 */
function SettleControls({edge}: {edge: ReturnType<typeof useEdge>}) {
  const [confirming, setConfirming] = useState(false);
  return edge.pressFor === 'settle' ? (
    <>
      <Text style={[styles.op, {color: theme.warn}]}>Press the key to settle</Text>
      {consentRefusal() ? <Text style={[styles.op, {color: theme.error}]}>{consentRefusal()}</Text> : null}
      <View style={styles.row}>
        <Btn title="Press the soft key" tone="primary" disabled={consentRefusal() !== null} onPress={() => { if (!consentRefusal()) edge.press(); }} />
      </View>
    </>
  ) : confirming ? (
    <>
      <Text style={styles.dim}>Settling ends every live budget and records, in the chain, that you accept every owed use without its receipt. The agent then needs a new budget, which you approve again. It needs a press on the key.</Text>
      <View style={styles.row}>
        {consentRefusal() ? <Text style={[styles.op, {color: theme.error}]}>{consentRefusal()}</Text> : null}
        <Btn title="Yes, settle" tone="danger" onPress={() => { if (consentRefusal()) return; setConfirming(false); void edge.settle(); }} disabled={edge.busy || consentRefusal() !== null} />
        <Btn title="Cancel" onPress={() => setConfirming(false)} disabled={edge.busy} />
      </View>
    </>
  ) : (
    <View style={styles.row}>
      <Btn title="Settle…" onPress={() => setConfirming(true)} disabled={edge.busy} />
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
/*
 * BLOCKS (BLOCKS.md §3, Brad 2026-10-07: "we use hash of a json"): the chain as
 * canonical JSON blocks - one per closed budget, each sealed by the key - exported as
 * a .json file anyone can check with SHA-256 and this key's public key.
 */
function BlocksCard({edge}: {edge: ReturnType<typeof useEdge>}) {
  const [line, setLine] = useState<string | null>(null);
  return (
    <Section title="Blocks">
      <Text style={styles.dim}>
        The chain as JSON blocks: one per closed budget, each sealed by the key. Anyone can check them with SHA-256 and this
        key's public key.
      </Text>
      <View style={styles.row}>
        <Btn title="Export blocks" onPress={() => { setLine('…'); void edge.exportBlocks().then(setLine, (e: unknown) => setLine(String(e))); }} disabled={edge.busy} />
      </View>
      {line ? <Text style={styles.dim}>{line}</Text> : null}
    </Section>
  );
}

export function EdgeScreen({testingMode = false, focusSeq = null, onFocused, openGrantId = null, onBudgetOpened}: {testingMode?: boolean; focusSeq?: number | null; onFocused?: () => void; openGrantId?: number | null; onBudgetOpened?: () => void}) {
  const edge = useEdge();
  /* your other devices' logs this phone holds, by nametag (above every early return) */
  const devices = useYourDevices(edge.view?.headSeq);
  /* a device's log opened in full */
  const [allOf, setAllOf] = useState<Set<string>>(new Set());
  /* THE SYNC BANNER (Brad, 2026-10-08): logs a sync brought, held until you answer - the sheet opens only from the banner */
  const [waiting, setWaiting] = useState(0);
  const [bannerTitle, setBannerTitle] = useState<string | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  useEffect(() => {
    const read = () => {
      void waitingCount().then(setWaiting).catch(() => undefined);
      void bannerLine().then(setBannerTitle).catch(() => undefined);
    };
    read();
    return onDevicesChanged(read);
  }, [edge.view?.headSeq]);
  const [open, setOpen] = useState<EdgeBudget | null>(null);
  /* the request sheet's budget card, tapped (edgeNav.ts): its details, once the budget is in the lists */
  useEffect(() => {
    if (openGrantId === null) return;
    const b = edge.budgets.find(x => x.grantId === openGrantId) ?? edge.past.find(x => x.grantId === openGrantId);
    if (!b) return;
    setOpen(b);
    onBudgetOpened?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openGrantId, edge.budgets, edge.past]);
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
    /*
     * The numbers from the copy, live or ended. It fell back to the snapshot taken
     * when the budget was opened: budget 351 on the A13, opened with nothing spent,
     * read "0 of 4 uses spent" after its four uses and its end (Brad, 2026-10-06).
     */
    /* another device's budget: its own view - its card and its links from that device's merged log, never this phone's chain */
    if (open.deviceId) {
      const ob = edge.others.find(x => x.deviceId === open.deviceId && x.grantId === open.grantId) ?? open;
      const dv = edge.deviceViews[String(open.deviceId).toLowerCase()];
      if (dv) return <BudgetView b={ob} edge={edge} onBack={() => setOpen(null)} other={{view: dv, name: ob.device ?? 'another device'}} />;
      return <DeviceBudgetView b={ob} device={devices.find(d => d.deviceId === open.deviceId)} onBack={() => setOpen(null)} />;
    }
    const b = edge.budgets.find(x => x.grantId === open.grantId) ?? edge.past.find(x => x.grantId === open.grantId) ?? open;
    return <BudgetView b={b} edge={edge} onBack={() => setOpen(null)} />;
  }
  /*
   * The mismatch banner (spec okrn-edge-tab.md 4.3): the verdict lives in a
   * budget's chain view, so with no budget open a copy that does not verify
   * would show nowhere. Only when something is wrong; a good copy stays quiet.
   */

  const v = edge.view?.verdict;
  const ks = edge.keyState;
  const broken = v && (v.kind === 'tampered' || v.kind === 'gap') ? verdictLine(v) : null;
  const gap = v && v.kind === 'gap' ? {from: v.from, to: v.to} : null;
  const range = gap ? (gap.from === gap.to ? `#${gap.from}` : `#${gap.from}–#${gap.to}`) : '';
  /*
   * THE TRUST LIST (Brad, 2026-10-04): the whole tab is one list, edge to edge
   * (src/ui/EdgeList.tsx) - what needs you first (a restore, a copy that does
   * not verify, receipts owed), the live budgets, then the history: every link
   * in this phone's copy, newest first, each use with its receipt under it. Tap
   * a live budget's link to open its chain. Agents, your identities and the
   * testing panels are in the drawer at the bottom (src/ui/BottomDrawer.tsx).
   */
  const items: EdgeListItem[] = [];
  if (waiting > 0) {
    items.push({key: 'merge-banner', kind: 'row', title: bannerTitle ?? 'Sync wants to merge new devices', subtitle: `${waiting} waiting for your answer - tap to review`, tone: 'warn', onPress: () => setMergeOpen(true), accessibilityLabel: 'Review what a sync brought'});
  }
  /*
   * PAST ITS LIFETIME = NOT LIVE, whatever the key still lists (Brad, 2026-10-06:
   * budget 313 expired on hold and kept Resume and Revoke). Its status follows its
   * receipts: still Active while one is owed (shown with the live ones), else past.
   */
  const nowMs = Date.now();
  const expiredIds = new Set(edge.budgets.filter(b => b.endsAt !== undefined && nowMs > b.endsAt).map(b => b.grantId));
  const liveCards = edge.budgets.filter(b => !expiredIds.has(b.grantId));
  const notLive = [...edge.past, ...edge.budgets.filter(b => expiredIds.has(b.grantId))];
  const owing = notLive.filter(b => budgetStatus(b, false, edge.view).kind === 'active');
  const done = notLive.filter(b => budgetStatus(b, false, edge.view).kind !== 'active');
  if (broken || (ks && (ks.owed > 0 || ks.overflow))) {
    items.push({key: 'status', kind: 'node', render: () => (
      <View style={styles.statusStack}>
          {broken ? (
            <View style={styles.mismatch}>
              <Text style={[styles.receiptTitle, {color: theme.error}]}>This phone's copy of the chain does not match the key</Text>
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
                    <Btn title="Press the soft key" tone="primary" disabled={consentRefusal() !== null} onPress={() => { if (!consentRefusal()) edge.press(); }} />
                  </View>
                </>
              ) : gap && confirmLoss ? (
                <>
                  <Text style={styles.dim}>
                    {`No copy holds ${range}. Accepting records in the chain, with a press, that ${range} ${gap.from === gap.to ? 'is' : 'are'} gone for good. Budgets can be approved again after it; anything those links owed must still be receipted or settled.`}
                  </Text>
                  <View style={styles.row}>
                    <Btn title={`Yes, accept loss of ${range}`} tone="danger" onPress={() => { if (consentRefusal()) return; setConfirmLoss(false); void edge.acceptLoss(gap.from, gap.to); }} disabled={edge.busy} />
                    <Btn title="Cancel" onPress={() => setConfirmLoss(false)} disabled={edge.busy} />
                  </View>
                </>
              ) : (
                <View style={styles.row}>
                  <Btn title="Sync" tone="primary" onPress={edge.fullSync} disabled={edge.busy} />
                  {gap ? <Btn title={`Accept loss of ${range}…`} onPress={() => setConfirmLoss(true)} disabled={edge.busy} /> : null}
                </View>
              )}
            </View>
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
  if (cc && !cc.ok && cc.reason !== 'gap' && !broken) {
    const atRow = cc.seq !== undefined ? (edge.view?.rows ?? []).find(r => r.seq === cc.seq) : undefined;
    const grant = atRow?.fields.grantId;
    const bud = grant ? edge.past.find(b => b.grantId === grant) ?? edge.budgets.find(b => b.grantId === grant) : undefined;
    const lossFrom = bud?.firstSeq;
    const lossTo = bud?.lastSeq;
    const lossRange = lossFrom !== undefined && lossTo !== undefined ? (lossFrom === lossTo ? `#${lossFrom}` : `#${lossFrom}–#${lossTo}`) : '';
    items.push({key: 'copyfail', kind: 'node', render: () => (
      <View style={styles.mismatch}>
        <Text style={[styles.receiptTitle, {color: theme.error}]}>This phone's copy does not pass the budget rules</Text>
        <Text style={styles.op}>{`${copyProblem(cc) ?? cc.reason}${grant ? ` - budget ${grant}${lossRange ? ` (${lossRange})` : ''}` : ''}`}</Text>
        <Text style={styles.dim}>Until it passes, every agent request is refused (copy_unverified). Accepting the loss records, with a press, that these links are set aside; the copy is checked after them.</Text>
        {lossRange && edge.pressFor === 'loss' ? (
          <>
            <Text style={[styles.op, {color: theme.warn}]}>Press the key to accept the loss</Text>
            <View style={styles.row}><Btn title="Press the soft key" tone="primary" disabled={consentRefusal() !== null} onPress={() => { if (!consentRefusal()) edge.press(); }} /></View>
          </>
        ) : lossRange && confirmLoss ? (
          <View style={styles.row}>
            <Btn title={`Yes, accept loss of ${lossRange}`} tone="danger" onPress={() => { if (consentRefusal()) return; setConfirmLoss(false); void edge.acceptLoss(lossFrom!, lossTo!); }} disabled={edge.busy} />
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
              blocked={copyProblem(edge.copyCheck)}
              onApprove={() => edge.approve(r.id)}
              onPress={edge.press}
              onDecline={() => edge.decline(r.id)}
            />
          ))}
          {liveCards.map(b => (
            <BudgetCard
              key={b.grantId}
              b={b}
              busy={edge.busy}
              stopping={edge.stopping}
              status={budgetStatus(b, true, edge.view)}
              onOpen={() => setOpen(b)}
              onRevoke={() => edge.revoke(b.grantId)}
              held={edge.keyState?.held.includes(b.grantId)}
              onHold={edge.keyState ? () => edge.hold(b.grantId) : undefined}
              onResume={edge.keyState ? () => edge.resume(b.grantId) : undefined}
              waitingResume={edge.pressFor === `resume:${b.grantId}`}
              onPress={edge.press}
            />
          ))}
          {/* ACTIVE BUDGETS ARE NOT PAST BUDGETS (Brad, 2026-10-06): one the key no longer lists but that still owes a receipt is Active - it stays up here, with no Hold or Revoke (nothing is left to hold) */}
          {owing.map(b => (
            <BudgetCard key={`o${b.grantId}`} b={b} busy={edge.busy} status={budgetStatus(b, false, edge.view)} onOpen={() => setOpen(b)} />
          ))}
          {edge.ended.map(e => (
            <View key={`e${e.grantId}`} style={[styles.budget, styles.ended]}>
              <Text style={[styles.receiptTitle, {color: theme.textDim}]}>Ended when the key locked or restarted</Text>
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
          {edge.view?.verdict.kind !== 'locked' && liveCards.length === 0 && owing.length === 0 && edge.requests.length === 0 && edge.ended.length === 0 ? (
            <Text style={styles.dim}>
              No budget. A budget lets an agent use the key a set number of times without a press; you approve it once.
            </Text>
          ) : null}
    </>
  )});
  /* BUDGET HISTORY (Brad, 2026-10-04): every budget this phone opened that is not live now - tap one for its chain */
  /* and your other devices' budgets, full cards (Brad, 2026-10-09: "i want to see them in the budget history list"), newest first */
  const history = [...done, ...edge.others].sort((a, b2) => (b2.openedAt ?? 0) - (a.openedAt ?? 0));
  if (history.length) {
    items.push({key: 's-past', kind: 'section', title: 'Past budgets', right: `${history.length}`});
    for (const b of history) {
      items.push({key: b.deviceId ? `o${b.deviceId}-${b.grantId}` : `p${b.grantId}`, kind: 'node', bare: true, render: () => (
        <BudgetBlock b={b} status={budgetStatus(b, false, b.deviceId ? edge.deviceViews[b.deviceId] ?? null : edge.view)} device={b.deviceId ? b.device : edge.ownName} onPress={() => setOpen(b)} />
      )});
    }
  }
  const rows = edge.view?.rows ?? [];
  const verifiedAt = new Map(rows.map(r => [r.seq, r.verified]));
  const attached = new Set<number>();
  for (const r of rows) if (r.receipt?.receipt) attached.add(r.receipt.receipt.seq);
  const liveUses = new Map(edge.budgets.map(b => [b.grantId, b.uses]));
  /* each agent's first note (this phone's clock): "no reason given" counts from there */
  const notesFrom = new Map<string, number>();
  for (const r of edge.view?.rows ?? []) {
    if (r.note && !(notesFrom.get(r.note.computer)! <= r.note.at)) notesFrom.set(r.note.computer, Math.min(r.note.at, r.seenAt ?? r.note.at));
  }
  const agentOf = new Map([...edge.past, ...edge.budgets].filter(b => b.computerId).map(b => [b.grantId, String(b.computerId)]));
  /*
   * B7 stage 2: refused TX starts write no link. The key's own count since it started
   * (HEAD byte 60) is the evidence; the agents' notes say which and why (their word).
   */
  const refusedByKey = edge.keyState?.refusedTx ?? 0;
  const reported = (edge.view?.refusals ?? []).slice(-3).reverse();
  if (refusedByKey > 0 || reported.length) {
    items.push({key: 'live-refused', kind: 'node', render: () => (
      <View style={[styles.mismatch, {borderColor: theme.error}]}>
        <Text style={[styles.receiptTitle, {color: theme.error}]}>
          {refusedByKey > 0 ? `⚠ The key refused ${refusedByKey} TX start${refusedByKey === 1 ? '' : 's'} since it started` : 'Refused TX starts reported by an agent'}
        </Text>
        {reported.map((r, i) => (
          <Text key={i} style={styles.dim}>{`${new Date(r.at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})} · head #${r.seq} · the agent says: “${r.status}”`}</Text>
        ))}
        <Text style={styles.dim}>A refused TX start writes no link. If you did not expect one, hold the budget.</Text>
      </View>
    )});
  }
  /* B7: Hold one tap away while anything is live - stopping an agent never needs navigating */
  const liveNow = edge.budgets.filter(b => !(edge.keyState?.held ?? []).includes(b.grantId) && !(b.uses > 0 && b.used >= b.uses));
  if (liveNow.length) {
    items.push({key: 'live-hold', kind: 'node', render: () => (
      <View style={styles.holdBar}>
        {liveNow.map(b => (
          <View key={b.grantId} style={styles.row}>
            <Text style={[styles.op, {flex: 1}]}>{`Budget ${b.grantId} live · ${Math.max(0, b.uses - b.used)} of ${b.uses} left`}</Text>
            <Btn title="Hold" tone="danger" onPress={() => edge.hold(b.grantId)} disabled={edge.stopping} />
          </View>
        ))}
      </View>
    )});
  }
  items.push({key: 's-history', kind: 'section', title: 'Presses', right: rows.length ? `#${rows[0].seq} → #${rows[rows.length - 1].seq} · newest first` : 'nothing yet'});
  for (const r of rows) {
    if (r.fields.op === OP.RECEIPT && attached.has(r.seq)) continue; /* it hangs under its use */
    /* tap: the budget it was for - live or past (Brad, 2026-10-04); a press no budget paid has none */
    const forBudget = r.fields.grantId ? edge.budgets.find(b => b.grantId === r.fields.grantId) ?? edge.past.find(b => b.grantId === r.fields.grantId) : undefined;
    items.push({key: `h${r.seq}`, kind: 'node', bare: true, render: () => {
      const body = (
        <View style={[styles.historyRow, r.seq === marked && styles.marked]}>
          <LinkRow row={r} continued={edge.view?.continued} budgetUses={liveUses} agentOf={agentOf} notesFrom={notesFrom} receiptVerified={r.receipt?.receipt ? verifiedAt.get(r.receipt.receipt.seq) !== false : true} />
        </View>
      );
      return forBudget ? (
        <Pressable onPress={() => setOpen(forBudget)} accessibilityRole="button" accessibilityLabel={`Open budget ${forBudget.grantId}`}>{body}</Pressable>
      ) : body;
    }});
  }

  /*
   * YOUR DEVICES' LOGS (Brad, 2026-10-08: "so i know a different key made the block ... but
   * because its made with our key we want that block"). Each device you approved, by its
   * own nametag and fingerprint, its links newest first - in Presses, below this key's own.
   */
  for (const d of devices) {
    if (!d.links.length) continue;
    if (!edge.deviceViews[String(d.deviceId).toLowerCase()]) continue;
    items.push({key: `dv-${d.deviceId}`, kind: 'node', bare: true, render: () => (
      <View style={styles.historyRow}>
        <Text style={[styles.dim, styles.siblingHead]}>{`${deviceName(d)} · device ${d.deviceId.slice(0, 8)}…${d.mergedUpTo !== null ? ` · merged up to #${d.mergedUpTo}` : ''}`}</Text>
      </View>
    )});
    /* the same rows this phone draws for its own chain: receipts under their use, intents checked against the chain (Brad, 2026-10-09: "all the data i see on the a13 should be just like on the pixel") */
    const dv = edge.deviceViews[String(d.deviceId).toLowerCase()];
    const dvRows = dv?.rows ?? [];
    const dvAttached = new Set<number>();
    for (const r of dvRows) if (r.receipt?.receipt) dvAttached.add(r.receipt.receipt.seq);
    const dvVerified = new Map(dvRows.map(r => [r.seq, r.verified]));
    const dvUses = new Map<number, number>(); /* its budgets are not live here: no "left", as on that device for an ended one */
    const dvShown = dvRows.filter(r => !(r.fields.op === OP.RECEIPT && dvAttached.has(r.seq)));
    const shownRows = allOf.has(d.deviceId) ? dvShown : dvShown.slice(0, SIBLING_FIRST);
    for (const r of shownRows) {
      /* a press of another device opens its budget's full card (Brad, 2026-10-09: "and by pressing the presses history") */
      const card = r.fields.grantId ? edge.others.find(x => x.deviceId === String(d.deviceId).toLowerCase() && x.grantId === r.fields.grantId) : undefined;
      items.push({key: `dv-${d.deviceId}-${r.seq}`, kind: 'node', bare: true, render: () => {
        const body = (
          <View style={styles.historyRow}>
            <LinkRow row={r} continued={dv?.continued} budgetUses={dvUses} receiptVerified={r.receipt?.receipt ? dvVerified.get(r.receipt.receipt.seq) !== false : true} />
          </View>
        );
        return card ? (
          <Pressable onPress={() => setOpen(card)} accessibilityRole="button" accessibilityLabel={`Open budget ${card.grantId} of ${deviceName(d)}`}>{body}</Pressable>
        ) : body;
      }});
    }
    if (dvShown.length > SIBLING_FIRST) {
      const isOpen = allOf.has(d.deviceId);
      items.push({key: `dv-${d.deviceId}-more`, kind: 'node', bare: true, render: () => (
        <Pressable style={[styles.historyRow, styles.siblingRow]} accessibilityRole="button"
          onPress={() => setAllOf(prev => { const n = new Set(prev); if (isOpen) n.delete(d.deviceId); else n.add(d.deviceId); return n; })}>
          <Text style={[styles.op, {color: SIBLING_RING, paddingVertical: 8}]}>{isOpen ? 'Show fewer' : `Show all ${dvShown.length}`}</Text>
        </Pressable>
      )});
    }
  }

  return (
    <View style={styles.screen}>
      <View style={styles.paneBar}>
        <Segmented options={['Budgets', 'Presses'] as const} value={pane} onChange={setPane} />
      </View>
      <EdgeList
        items={items.filter(it => it.key === 'status' || it.key === 'merge-banner' || (pane === 'Presses') === (it.key === 's-history' || it.key === 'live-hold' || it.key === 'live-refused' || /^h\d/.test(it.key) || it.key.startsWith('dv-')))}
        bottomInset={DRAWER_HANDLE} refreshing={edge.busy} onRefresh={edge.sync}
      />
      <MergeSheet visible={mergeOpen} onClose={() => setMergeOpen(false)} />
      {/* Brad, 2026-10-05: the drawer holds more than agents now */}
      <BottomDrawer title="Edge Management">
        {!edge.available ? null : <EdgeAgentsCard onChanged={edge.sync} changed={edge.budgets} inDrawer testingMode={testingMode} />}
        {!edge.available ? null : <YourDevicesCard headSeq={edge.view?.headSeq} />}
        {!edge.available ? null : <BlocksCard edge={edge} />}
        {!testingMode || !edge.available ? null : (
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
  siblingRow: {paddingLeft: 40},
  siblingHead: {paddingLeft: 24, paddingTop: 4, color: SIBLING_RING},
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
  receipt: {marginLeft: 44, marginTop: 6, paddingLeft: 10, borderLeftWidth: 3, gap: 2},
  receiptMissing: {borderLeftColor: theme.warn, borderStyle: 'dashed'},
  waiting: {borderWidth: 1, borderStyle: 'dashed', borderColor: theme.warn, borderRadius: theme.radius, paddingHorizontal: 10, marginTop: 6},
  receiptTitle: {fontWeight: '600', fontSize: 14},
  message: {color: theme.textSecondary, fontSize: 13, lineHeight: 19},
});
