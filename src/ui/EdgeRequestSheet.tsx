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
import {request as requestLib} from 'node-onlykey-lib/edge';
import {Btn} from './components';
import {theme} from './theme';

/* what each typed refusal means, in the person's words (the agent gets the code) */
const REFUSAL_TEXT: Record<string, string> = {
  declined: 'You declined. The agent was told "declined".',
  timeout: 'Nobody answered in time. The agent was told "timeout".',
  copy_unverified: 'This phone\'s copy of the chain does not verify, so nothing was sent to the key. The agent was told "copy_unverified".',
  ticket_owed: 'A ticket is owed for an earlier use. The agent was told "ticket_owed".',
  restoring: 'The key is finishing a restore. The agent was told "restoring".',
  invalid: 'The request could not be a budget. The agent was told "invalid".',
};

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

export function EdgeRequestSheet() {
  const [s, setS] = useState<SheetState | null>(null);
  /* the second confirm, for a request naming the person's own identity */
  const [confirming, setConfirming] = useState(false);
  useEffect(() => onSheet(next => {
    setS(next);
    if (!next || next.phase !== 'ask') setConfirming(false);
  }), []);
  const left = useSecondsLeft(s && s.phase !== 'done' ? s.until : null);
  if (!s) return null;
  const a = s.ask;

  return (
    <Modal transparent animationType="slide" visible onRequestClose={() => (s.phase === 'done' ? closeSheet() : undefined)}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <ScrollView contentContainerStyle={styles.body}>
            {a.kind === 'register' ? (
              <>
                <Text style={[styles.title, {color: theme.warn}]}>Register an agent?</Text>
                <Text style={styles.op}>{a.name}</Text>
                <Text style={styles.op}>{`Key ${a.fingerprint}`}</Text>
                <Text style={styles.dim}>
                  Check the computer prints the same key. Registering takes a press on the key, which records it in the chain. Once registered it may ask for budgets; each budget still shows here and needs your press. Until then its requests are refused unread.
                </Text>
              </>
            ) : (
              <>
                <Text style={[styles.title, {color: theme.warn}]}>
                  {a.view.continues !== null ? `Continues budget ${a.view.continues}` : 'An agent asks for a budget'}
                </Text>
                <Text style={styles.dim}>{`Asked by ${a.agentName} · key ${requestLib.fingerprint(a.view.agent)}`}</Text>
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
                    {`${c.sameAgent ? 'This agent already has' : 'A budget already has'} ${c.usesLeft} use${c.usesLeft === 1 ? '' : 's'} left on ${c.identity || `slot ${c.slot}`}${c.endsAt ? ` until ${clock(c.endsAt)}` : ''} (budget ${c.grantId}).`}
                  </Text>
                ))}
                {a.view.continues !== null ? (
                  <Text style={styles.dim}>{`The same scopes as budget ${a.view.continues}, with new uses and a new lifetime. It opens with a press, like a new budget.`}</Text>
                ) : null}
                {a.view.ownWarning ? (
                  <View style={styles.warning}>
                    <Text style={styles.warningTitle}>This would let an agent sign as you</Text>
                    <Text style={styles.warningText}>
                      {`It names your own identity: ${a.view.scopes.filter((sc: any) => sc.own).map((sc: any) => sc.identity).join(', ')}. Anything signed with it looks like you signed it.`}
                    </Text>
                  </View>
                ) : null}
              </>
            )}

            {s.phase === 'ask' && !confirming && a.kind === 'request' && a.blocked ? (
              <Text style={[styles.dim, {color: theme.error}]}>{`Approve is off: ${a.blocked} Nothing is sent to the key.`}</Text>
            ) : null}
            {s.phase === 'ask' && left !== null ? (
              <Text style={[styles.countdown, left <= 60 && {color: theme.error}]}>{`Answer within ${mmss(left)}`}</Text>
            ) : null}
            {s.phase === 'ask' && !confirming ? (
              <View style={styles.row}>
                <Btn
                  title={a.kind === 'register' ? 'Register' : 'Approve'}
                  tone={a.kind === 'request' && a.view.ownWarning ? 'danger' : 'primary'}
                  disabled={a.kind === 'request' && !!a.blocked}
                  onPress={() => (a.kind === 'request' && a.view.ownWarning ? setConfirming(true) : answerSheet('approve'))}
                />
                <Btn title="Decline" onPress={() => answerSheet('decline')} />
              </View>
            ) : null}
            {s.phase === 'ask' && confirming ? (
              <>
                <Text style={[styles.op, {color: theme.error}]}>Are you sure? The agent could sign as you until this budget ends.</Text>
                <View style={styles.row}>
                  <Btn title="Yes, let it sign as me" tone="danger" onPress={() => answerSheet('approve')} />
                  <Btn title="Back" onPress={() => setConfirming(false)} />
                  <Btn title="Decline" onPress={() => answerSheet('decline')} />
                </View>
              </>
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
                <View style={styles.row}>
                  <Btn title="Press the soft key" tone="primary" onPress={() => void pressFromSheet()} />
                </View>
              </>
            ) : null}
            {s.phase === 'done' ? (
              <>
                <Text style={[styles.op, {color: s.result.ok ? theme.ok : theme.error}]}>
                  {s.result.ok ? s.result.text : REFUSAL_TEXT[s.result.refusal] ?? `Refused: ${s.result.refusal}`}
                </Text>
                {!s.result.ok && s.result.detail ? <Text style={styles.dim}>{s.result.detail}</Text> : null}
                <View style={styles.row}>
                  <Btn title="Close" onPress={closeSheet} />
                </View>
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
  body: {padding: 16, gap: 8},
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
});
