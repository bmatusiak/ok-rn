/**
 * THE APPROVAL SHEET for an agent's budget request (mcp-service.md 4.7a, step
 * 2). Over whatever tab is open: an agent asks while the person is elsewhere.
 *
 * It shows what the person approves - the reason TEXT, the identity NAMES, the
 * caps, the lifetime and who asks - never a hash. A request naming one of the
 * person's own identities gets the red warning and a second confirm before
 * anything reaches the key (Brad, 2026-10-03). Then the key waits for the
 * press; no press, no budget. The answer the agent gets is shown last.
 *
 * The state lives in src/edgeAgents.ts; this only draws it.
 */
import React, {useEffect, useState} from 'react';
import {Modal, ScrollView, StyleSheet, Text, View} from 'react-native';
import {answerSheet, closeSheet, onSheet, pressFromSheet, type SheetState} from '../edgeAgents';
import {Btn} from './components';
import {Locate} from './PressSheet';
import {theme} from './theme';
import {consentRefusal} from '../debugGuard';
import {BudgetCard} from '../screens/EdgeScreen';
import {SoftKeyEdge} from '../edgeSoftKey';
import {chainState, type EdgeView} from '../edgeStore';
import type {EdgeBudget} from '../edgeFake';
import {budgetStatus} from '../budgetStatus';
import {openBudget} from '../edgeNav';
import {currentNet} from '../net';

/* what each typed refusal means, in the person's words (the agent gets the code) */
const REFUSAL_TEXT: Record<string, string> = {
  declined: 'You declined. The agent was told "declined".',
  timeout: 'Nobody answered in time. The agent was told "timeout". Until you close this, new requests are refused without asking - nobody is here to answer them.',
  copy_unverified: 'This phone\'s copy of the chain does not verify, so nothing was sent to the key. The agent was told "copy_unverified".',
  receipt_owed: 'A receipt is owed for an earlier use. The agent was told "receipt_owed".',
  invalid: 'The request could not be a budget. The agent was told "invalid".',
  busy: 'Another request was on the phone. The agent was told "busy" and may ask again.',
};

const refusalText = (refusal: string, _kind: string) => REFUSAL_TEXT[refusal] ?? `Refused: ${refusal}`;

const opName = (op: string) => (op === 'sign' ? 'Sign' : op === 'decrypt' ? 'Decrypt' : op);

const clock = (ms: number) => {
  const t = new Date(ms);
  return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
};

/* from when the request arrived - not from each redraw, or the end time creeps */
function until(minutes: number, from: number): string {
  const t = new Date(from + minutes * 60000);
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  const span = minutes < 60 ? `${minutes} min` : minutes % 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes / 60} h`;
  return `${span} (until ${hh}:${mm})`;
}

/*
 * THE COUNTDOWN to whatever runs out next (Brad, 2026-10-03: "a countdown to
 * things that expire"): the two minutes to say Yes, then the key's 25 s press
 * window. Seconds left, redrawn each second; null when nothing is running.
 * Red when the loud sound starts (PressAlert): the question's second minute, the
 * press after its first 10 s - the colour and the sound say the same thing.
 */
function useSecondsLeft(until: number | null): number | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  return until ? Math.max(0, Math.ceil((until - now) / 1000)) : null;
}
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

/*
 * AFTER APPROVE (Brad, 2026-10-07): the new budget's progress card - the Edge tab's
 * own BudgetCard, live: it refreshes on every check of the chain, so its uses and
 * receipts move while the sheet is open - instead of a Close button. Tapped, it
 * opens the budget's details on the Edge tab; Back closes the sheet as before.
 */
function ApprovedBudget({grantId}: {grantId: number}) {
  const [card, setCard] = useState<{b: EdgeBudget; live: boolean; view: EdgeView | null} | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const source = await SoftKeyEdge.open();
      if (!source || !alive) return;
      const live = await source.budgets(true).catch(() => [] as EdgeBudget[]);
      const now = live.find(x => x.grantId === grantId);
      const b = now ?? (await source.pastBudgets().catch(() => [] as EdgeBudget[])).find(x => x.grantId === grantId);
      if (alive && b) setCard({b, live: !!now, view: chainState.current(source.deviceId)?.view ?? null});
    };
    void load();
    const off = chainState.on('checked', () => void load());
    return () => { alive = false; off(); };
  }, [grantId]);
  if (!card) return <Text style={styles.dim}>{`Budget ${grantId}`}</Text>;
  return (
    <BudgetCard
      b={card.b}
      busy={false}
      heading={`Budget ${grantId}`}
      status={budgetStatus(card.b, card.live, card.view)}
      onOpen={() => { closeSheet(); openBudget(grantId); }}
    />
  );
}

export function EdgeRequestSheet() {
  const [s, setS] = useState<SheetState | null>(null);
  /* no second confirm since 2026-10-08: no "yours" mark - the identities asked for are on the sheet (Brad) */
  useEffect(() => onSheet(next => { setS(next); }), []);
  const left = useSecondsLeft(s && (s.phase === 'ask' || s.phase === 'press') ? s.until : null);
  /*
   * NO DOUBLE TAPS (Brad, 2026-10-04: a tap on Approve took a moment to register, the
   * timer ticked, a second tap landed on the next step by accident). The buttons start
   * disabled and wake 1 s after each step appears (the ask, the second confirm, the
   * press); a tap disables them all until the phone has moved to the next step.
   */
  const [ready, setReady] = useState(false);
  const [acting, setActing] = useState(false);
  useEffect(() => {
    setReady(false);
    setActing(false);
    const t = setTimeout(() => setReady(true), 1000);
    return () => clearTimeout(t);
  }, [s?.phase, s?.ask]);
  const off = !ready || acting;
  const act = (fn: () => void) => () => {
    if (off) return;
    setActing(true);
    fn();
  };
  if (!s) return null;
  const a = s.ask;
  /* the budget is open: its card says the rest (Brad, 2026-10-07: "remove the old stuff at the top that is in the card") */
  const opened = s.phase === 'done' && s.result.ok && s.result.grantId !== undefined;
  /*
   * Spec rule 10, the app's lock: the ONE shared check (debugGuard.consentRefusal) for
   * every kind this sheet shows - a budget, a registration, a place that keeps copies.
   * Off only in testing mode (option 1, Brad 2026-10-04); a production build always
   * has it. Asked at render and again on the tap (debugging can be turned on in between).
   */
  const refusal = s.phase === 'ask' || s.phase === 'press' ? consentRefusal() : null;
  const consent = (fn: () => void) => act(() => {
    if (consentRefusal()) return;
    fn();
  });

  return (
    <Modal transparent animationType="slide" visible onRequestClose={() => (s.phase === 'done' ? closeSheet() : undefined)}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <ScrollView contentContainerStyle={styles.body}>
            {/* the testnet (src/net.ts): a throwaway key - said before anything is approved */}
            {currentNet() === 'test' ? <Text style={[styles.title, {color: theme.io}]}>TESTNET</Text> : null}
            {(
              <>
                <Text style={[styles.title, {color: theme.warn}]}>
                  {a.view.continues !== null ? `Continues budget ${a.view.continues}` : 'An agent asks for a budget'}
                </Text>
                <Text style={styles.dim}>
                  {/* who asks: the paired computer (Brad, 2026-10-08: no agent key - the pairing says who) */}
                  {`From ${a.computer ?? 'a paired computer'}`}
                </Text>
                {opened ? null : (<>
                <View style={styles.reason}>
                  <Text style={styles.op}>{a.view.reason}</Text>
                </View>
                {a.view.scopes.map((sc: any, i: number) => (
                  <View key={i} style={[styles.scope, sc.own && styles.scopeOwn]}>
                    <Text style={[styles.op, sc.own && {color: theme.error}]}>
                      {`${opName(sc.op)} · ${sc.identity ? sc.identity : `slot ${sc.slot}`}`}
                    </Text>
                    <Text style={styles.dim}>{`${sc.identity ? `slot ${sc.slot} · ` : ''}up to ${sc.cap} use${sc.cap === 1 ? '' : 's'}`}</Text>
                  </View>
                ))}
                <Text style={styles.dim}>{`${a.view.uses} use${a.view.uses === 1 ? '' : 's'} without a press · for ${until(a.view.lifetime, a.at)}`}</Text>
                {(a.view.covered || []).map((c: any, i: number) => (
                  <Text key={`c${i}`} style={[styles.dim, {color: theme.warn}]}>
                    {`${c.sameComputer ? 'This computer already has' : 'A budget already has'} ${c.usesLeft} use${c.usesLeft === 1 ? '' : 's'} left on ${c.identity || `slot ${c.slot}`}${c.endsAt ? ` until ${clock(c.endsAt)}` : ''} (budget ${c.grantId}).`}
                  </Text>
                ))}
                {a.view.continues !== null ? (
                  <Text style={styles.dim}>{`The same scopes as budget ${a.view.continues}, with new uses and a new lifetime. It opens with a press, like a new budget.`}</Text>
                ) : null}
                </>)}
              </>
            )}

            {s.phase === 'ask' && a.blocked ? (
              <Text style={[styles.dim, {color: theme.error}]}>{`Approve is off: ${a.blocked} Nothing is sent to the key.`}</Text>
            ) : null}
            {s.phase === 'ask' && left !== null ? (
              <Text style={[styles.countdown, left <= 60 && {color: theme.error}]}>{`Answer within ${mmss(left)}`}</Text>
            ) : null}
            {/* the tap registered: say so at once - the phone syncs and checks its copy before the key asks for the press (the 'lag', Brad 2026-10-04) */}
            {s.phase === 'ask' && acting ? (
              <Text style={[styles.op, {color: theme.warn}]}>Approved - getting the key ready…</Text>
            ) : null}
            {s.phase === 'ask' && refusal ? <Text style={[styles.op, {color: theme.error}]}>{refusal}</Text> : null}
            {s.phase === 'ask' && !acting ? (
              <View style={styles.row}>
                <Locate what={`budget ask "${a.view.reason}" - approve`}>
                <Btn
                  large
                  title="Approve"
                  tone="primary"
                  disabled={off || refusal !== null || !!a.blocked}
                  onPress={consent(() => answerSheet('approve'))}
                />
                </Locate>
                <Btn large title="Decline" disabled={off} onPress={act(() => answerSheet('decline'))} />
              </View>
            ) : null}
            {s.phase === 'press' ? (
              <>
                <Text style={[styles.op, {color: theme.warn}]}>Press the key to confirm</Text>
                {left !== null ? (
                  <Text style={[styles.countdown, left <= 15 && {color: theme.error}]}>{`Press within ${mmss(left)}`}</Text>
                ) : null}
                <Text style={styles.dim}>
                  This phone is also the key, so its press proves less than a hard key's.
                </Text>
                {refusal ? <Text style={[styles.op, {color: theme.error}]}>{refusal}</Text> : null}
                <View style={styles.row}>
                  <Locate what={`budget press "${a.view.reason}"`}>
                    <Btn large title="Press the soft key" tone="primary" disabled={off || refusal !== null} onPress={consent(() => void pressFromSheet())} />
                  </Locate>
                </View>
              </>
            ) : null}
            {s.phase === 'pressed' ? (
              <Text style={[styles.op, {color: theme.warn}]}>Processing...</Text>
            ) : null}
            {s.phase === 'done' ? (
              <>
                <Text style={[styles.op, {color: s.result.ok ? theme.ok : theme.error}]}>
                  {s.result.ok ? s.result.text : refusalText(s.result.refusal, a.kind)}
                </Text>
                {!s.result.ok && s.result.detail ? <Text style={styles.dim}>{s.result.detail}</Text> : null}
                {s.result.ok && s.result.grantId !== undefined ? (
                  <>
                    <ApprovedBudget grantId={s.result.grantId} />
                    {/* close it here too, the full width (Brad, 2026-10-07): the card opens the details */}
                    <Btn large wide title="▼" label="Close" onPress={closeSheet} />
                  </>
                ) : (
                  <View style={styles.row}>
                    <Btn large title="Close" onPress={closeSheet} />
                  </View>
                )}
              </>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end'},
  sheet: {
    backgroundColor: theme.surface, borderTopLeftRadius: 14, borderTopRightRadius: 14,
    borderTopWidth: 2, borderColor: theme.warn, maxHeight: '88%',
  },
  /* room under the buttons: in debug builds React Native's warning toasts sit along the bottom and catch taps (2026-10-04) */
  body: {padding: 16, paddingBottom: 64, gap: 8},
  title: {fontWeight: '600', fontSize: 17},
  op: {color: theme.text, fontSize: theme.fontSize, lineHeight: theme.lineHeight},
  dim: {color: theme.textDim, fontSize: 13, lineHeight: 19},
  reason: {backgroundColor: theme.inputBg, borderRadius: theme.radius, padding: 10},
  scope: {borderWidth: 1, borderColor: theme.border, borderRadius: theme.radius, padding: 8, gap: 2},
  scopeOwn: {borderColor: theme.error, borderWidth: 2},
  warning: {borderWidth: 2, borderColor: theme.error, borderRadius: theme.radius, padding: 10, gap: 4, backgroundColor: 'rgba(248,113,113,0.12)'},
  warningTitle: {color: theme.error, fontWeight: '700', fontSize: 16},
  warningText: {color: theme.text, fontSize: 14, lineHeight: 20},
  row: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10},
  countdown: {color: theme.warn, fontSize: 20, fontWeight: '700', marginTop: 6},
  code: {color: theme.warn, fontSize: 120, fontWeight: '700', textAlign: 'center', alignSelf: 'stretch', fontVariant: ['tabular-nums'], marginVertical: 4},
  codeName: {fontSize: 60},
});
