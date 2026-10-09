/**
 * AGENTS ASKING FOR BUDGETS (onlykey-edge build/mcp-service.md 4.7a, step 2).
 *
 * A computer's agent service sends an EDGE_REQUEST over Bluetooth; the vendor
 * bridge KEEPS it for this file (it never reaches the key) and sends back what
 * this file answers. The key only ever sees hashes, so the person approves the
 * TEXT and the NAMES here, on the sheet (EdgeRequestSheet), and the library's
 * one implementation makes every hash from them (approve.approveRequest).
 *
 * WHO ASKS is the Bluetooth pairing (Brad, 2026-10-08: "so the claude key thing is
 * overkill"; "lets cut it out"): the vendor bridge hands over only what came inside a paired
 * computer's encrypted session, and `from` names that link - btTransit.computer() gives the
 * pairing's id and name. No agent key, no registration, no agent-add link.
 *
 * What this phone keeps (AsyncStorage): the nonces already taken (a replay is dropped), and
 * the Requests switch.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {approve as approveLib, chain, note as noteLib, request as requestLib, sync as syncLib} from 'node-onlykey-lib/edge';
import {SoftKeyEdge} from './edgeSoftKey';
import {addNote, keepOffered, loadMirror, mergeOffered, sync as syncCopy} from './edgeStore';
import {ensureNametag, holdLog, loadHeld} from './edgeDevices';
import NativeEdgeAlert from '../specs/NativeEdgeAlert';
import NativeBtKeyboard from '../specs/NativeBtKeyboard';
import {btTransit} from './btTransit';
import NativeOkEmu from '../specs/NativeOkEmu';
import {edgeKey} from './net';

const SEEN = (): string => edgeKey('seenNonces');
const ON = (): string => edgeKey('agentRequests');
const SEEN_KEPT = 2000;
/* how long the sheet waits for the person before the agent is told 'timeout' -
 * two minutes to read the request and say Yes (Brad, 2026-10-03; was 90 s) */
const SHEET_WAIT_MS = 120000;
/*
 * The key's press window is 20 s, not the Edge plugin's 25: the core firmware
 * closes every wait at 20 s (okcore.cpp Usertimeout) and clears what it waited
 * for, so a press after that is refused ("Error button press was not
 * accepted"). MEASURED ON THE PIXEL (2026-10-05, the firmware console): a
 * press at 20.5 s, with this sheet still showing time left, was refused - the
 * A13's "invalid" registration of 2026-10-04.
 */
export const PRESS_WAIT_MS = 20000;

export async function agentRequestsOn(): Promise<boolean> {
  return (await AsyncStorage.getItem(ON())) !== 'off';
}
export async function setAgentRequestsOn(on: boolean) {
  await AsyncStorage.setItem(ON(), on ? 'on' : 'off');
}

async function loadSeen(): Promise<Set<string>> {
  return new Set(JSON.parse((await AsyncStorage.getItem(SEEN())) || '[]'));
}
async function saveSeen(seen: Set<string>) {
  await AsyncStorage.setItem(SEEN(), JSON.stringify([...seen].slice(-SEEN_KEPT)));
}

/* ---------------------------------------------------------------- the sheet */

export type SheetAsk =
  /* no peer, sync, sibling or anchor sheet since 2026-10-08: a sync is HELD and answered from the Edge tab's banner (MergeSheet) */
  /* blocked: why Approve is off - this phone's copy does not verify (R27); Decline still answers */
  | {kind: 'request'; computer: string | null; view: any; blocked: string | null; at: number};
/* until: when this phase runs out (ms since epoch) - the sheet counts down to it */
export type SheetState =
  | {phase: 'ask'; ask: SheetAsk; until: number}
  | {phase: 'press'; ask: SheetAsk; until: number}
  /* the press is in: no more countdown, the key's answer is on its way (Brad: "when i press the button, the timer still counts down") */
  | {phase: 'pressed'; ask: SheetAsk}
  | {phase: 'done'; ask: SheetAsk; result: {ok: true; text: string; grantId?: number} | {ok: false; refusal: string; detail?: string}};

type Listener = (s: SheetState | null) => void;
const listeners = new Set<Listener>();
let current: SheetState | null = null;
let answer: ((a: 'approve' | 'decline' | 'timeout') => void) | null = null;
let soft: SoftKeyEdge | null = null;

/*
 * AFTER THE ANSWER (Brad, 2026-10-04): a DECLINE closes itself after 30 s - the
 * person was there and saw it. A TIMEOUT stays open, and while it is open every
 * new budget request is refused at once with no sheet: nobody
 * is at the phone to press anyway, until someone checks and closes it.
 */
const DECLINED_CLOSE_MS = 30_000;
let declinedTimer: ReturnType<typeof setTimeout> | null = null;
export const UNATTENDED_DETAIL = 'nobody is at the phone - an earlier request timed out and nobody has checked yet';
function unattended(): boolean {
  return current?.phase === 'done' && !current.result.ok && current.result.refusal === 'timeout';
}

function show(s: SheetState | null) {
  if (s?.phase === 'press' && approvedAt) {
    console.log(`[edge] approve -> press asked ${Date.now() - approvedAt} ms`);
    approvedAt = 0;
  }
  current = s;
  if (declinedTimer) { clearTimeout(declinedTimer); declinedTimer = null; }
  if (s?.phase === 'done' && !s.result.ok && s.result.refusal === 'declined') {
    declinedTimer = setTimeout(() => { declinedTimer = null; if (current === s) show(null); }, DECLINED_CLOSE_MS);
  }
  attention(s);
  for (const l of listeners) l(s);
}

/*
 * THE SOUND while the sheet waits for a Yes (Brad, 2026-10-03: "we need to add
 * sound to that because its important"). The press already sounds - the
 * firmware's confirm state drives PressAlert - but the question before it is
 * the app's, not the firmware's, so nothing rang and a request timed out
 * unseen. The app tells PressAlert itself: the same soft/loud repeat and the
 * same notification, until the person answers or the window runs out. The
 * press phase hands back to the firmware's own state.
 */
function attention(s: SheetState | null) {
  try {
    if (s && s.phase === 'ask') {
      NativeOkEmu.setAttention('An agent asks for a budget', s.until);
    } else {
      NativeOkEmu.setAttention('', 0);
    }
  } catch {
    /* no native side (jest, an old build): the sheet still shows */
  }
}
export function onSheet(l: Listener): () => void {
  listeners.add(l);
  l(current);
  return () => listeners.delete(l);
}
/** the person's answer on the sheet */
/* when Approve was tapped: the log times Approve -> the key asked for the press (Brad, 2026-10-06: presses lag) */
let approvedAt = 0;
export function answerSheet(a: 'approve' | 'decline') {
  if (a === 'approve') approvedAt = Date.now();
  const f = answer;
  answer = null;
  f?.(a);
}
export function closeSheet() {
  if (current?.phase === 'done') show(null);
}
/** the soft key's press, from the sheet's own button */
export async function pressFromSheet() {
  try {
    NativeOkEmu.hushPress();
  } catch {
    /* no native side (jest, an old build) */
  }
  await soft?.press();
  if (current?.phase === 'press') show({phase: 'pressed', ask: current.ask});
}

function askPerson(a: SheetAsk): Promise<'approve' | 'decline' | 'timeout'> {
  show({phase: 'ask', ask: a, until: Date.now() + SHEET_WAIT_MS});
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      answer = null;
      resolve('timeout');
    }, SHEET_WAIT_MS);
    answer = v => {
      clearTimeout(timer);
      resolve(v);
    };
  });
}

/* one at a time: messages run in order */
let queue: Promise<unknown> = Promise.resolve();
/*
 * ONE REQUEST ON THE PHONE AT A TIME (Brad, 2026-10-04: "need to reject multi attempts if 1
 * is being requested"): while a budget request is on the sheet, another is
 * refused at once - 'busy' - instead of waiting behind it, where its 2 minutes would run out
 * unseen and a stack of sheets would follow.
 */
let inFlight = false;
let stepLog: {t0: number; at: number; parts: string[]} | null = null;
function step(name: string) {
  if (!stepLog) return;
  const n = Date.now();
  stepLog.parts.push(`${name} ${n - stepLog.at}`);
  stepLog.at = n;
}
function stepsDone(what: string) {
  if (!stepLog) return;
  console.log(`[edge] ${what} ${Date.now() - stepLog.t0} ms after it arrived: ${stepLog.parts.join(', ')}`);
  stepLog = null;
}

/**
 * The vendor bridge's hand-off: an assembled message from computer `from`.
 * -> the answer to send back, or null to answer nothing (dropped).
 */
export function handleEdgeMessage(msg: any, from: string): Promise<unknown | null> {
  /* B7 stage 2: a note changes nothing, so it never waits behind a sheet */
  if (msg?.type === noteLib.TYPE) return handleNote(msg, from).catch(() => null);
  /* a sheet the person answers: a budget (a sync is held, never asked - 2026-10-08) */
  const asks = msg?.type === requestLib.TYPE;
  if (asks && inFlight) {
    return Promise.resolve({ok: false, refusal: 'busy', detail: 'another request is on the phone - ask again when it is answered'});
  }
  if (asks) inFlight = true;
  /* the time a request spends on the phone, step by step (Brad, 2026-10-06: the A13's slow answers) - times only */
  const arrived = Date.now();
  stepLog = {t0: arrived, at: arrived, parts: []};
  const run = queue.then(() => { step('queue'); return handle(msg, from); }).catch((e: unknown) => {
    /*
     * Never leave the sheet stuck (it sat on "Press" for good when a press
     * timeout came back as a garbled answer, 2026-10-03): end it with the
     * reason, and tell the agent rather than leaving it to its own timeout.
     */
    const detail = String((e as any)?.message || e);
    if (current) show({phase: 'done', ask: current.ask, result: {ok: false, refusal: 'invalid', detail: `the phone failed: ${detail}`}});
    return {ok: false, refusal: 'invalid', detail: `the phone failed: ${detail}`};
  });
  queue = run.catch(() => undefined);
  if (asks) run.finally(() => { inFlight = false; }).catch(() => undefined);
  return run;
}

/*
 * EDGE_NOTE (spec 2026-10-04): from a PAIRED computer, well formed, new; anything else is dropped
 * unanswered. Kept in the copy of this phone's key with that computer's pairing id; whether its
 * seq is a budget of that computer's is the tab's check. Answered at once - a note is never worth
 * a wait (the agent holds its key lane until the phone answers) - and the copy synced after, in
 * the background, so alarms still come within seconds.
 */
const notesSeen = new Set<string>();
async function handleNote(msg: any, from: string): Promise<unknown | null> {
  const computer = await btTransit.computer(from).catch(() => null);
  if (!computer) return null;
  if (!noteLib.verify(msg, {seen: notesSeen}).ok) return null;
  notesSeen.add(String(msg.nonce).toLowerCase());
  if (notesSeen.size > 1000) notesSeen.delete(notesSeen.values().next().value as string);
  /* the shared one, not a fresh open per note (each open probes the key and reads its public key) */
  soft = soft ?? (await SoftKeyEdge.open());
  const s = soft;
  if (!s) return null; /* locked, or no Edge: nothing to keep it with */
  void (async () => {
    await addNote(s.deviceId, {computer: computer.id, seq: msg.seq, reason: msg.reason, receiptMsg: msg.receiptMsg, txRefused: msg.txRefused}).catch(() => undefined);
    await syncCopy(s).catch(() => undefined); /* the sync, and its alarms */
  })();
  return {ok: true};
}

/*
 * okedge sync phase 2 (Brad, 2026-10-05): a place that keeps copies fills this
 * phone's copy. Only a place on the KEY's list (R20) is answered at all - the
 * rest is silence, like an unpaired computer. HAVE is a read (what this copy
 * holds); LINKS parts are staged in memory, changing nothing; after the last
 * part the links are merged into a candidate and checked (R27), then the sheet,
 * Yes, the press, and the key's sync link - and only then is the copy kept.
 */
const syncNames = new Map<string, string>(); /* the name each place gave in its HAVE */
/* one sync's parts, by sid, in memory only (nothing changes until the press) */
const syncStaged = new Map<string, {peer: string; links: Map<number, any[]>; linkParts: number; chain: string | null}>();
async function handleSync(msg: any, seen: Set<string>): Promise<unknown | null> {
  const checked = syncLib.verify(msg, {seen});
  /* one line per sync message: a message dropped here gets no answer, and the computer waits */
  console.log(`[edge] sync message ${msg?.type}${msg?.payload?.chain ? ` (device ${String(msg.payload.chain).slice(0, 8)})` : ''}: ${checked.ok ? 'checked' : `dropped (${checked.reason})`}`);
  if (!checked.ok) return null;
  seen.add(String(msg.nonce).toLowerCase());
  soft = soft ?? (await SoftKeyEdge.open());
  if (!soft) return {ok: false, refusal: 'invalid', detail: "this phone's key has no Edge"};
  /*
   * Which computer: its own sync key signed this (msg.peer), and the message came over a
   * Bluetooth link the person approved with its 6-digit code - no peer list since
   * 2026-10-08 (Brad: peers dropped). What it brings of another device is HELD.
   */
  const peer = String(msg.peer).toLowerCase();
  if (String(msg.payload.deviceId).toLowerCase() !== toHexId(soft.deviceId)) {
    return {ok: false, refusal: 'invalid', detail: "those links are another chain's, not this phone's key"};
  }
  const p = msg.payload;
  if (msg.type === syncLib.GIVE_TYPE) {
    /*
     * This phone's copy of its OWN chain - history only, no press (a computer keeps
     * copies anyway). From the copy as it is NOW (the key's newest included), BATCH at
     * a time.
     */
    const {mirror} = await syncCopy(soft);
    const from = mirror.links.filter((r: any) => seqOfLink(r) >= p.from);
    const batch = from.slice(0, syncLib.BATCH);
    const hex = (b: Uint8Array) => toHexId(b);
    const next = from.length > batch.length ? seqOfLink(from[batch.length]) : null;
    /*
     * BLOCKS (BLOCKS.md §3, Brad 2026-10-07): with the last batch, the key's seals
     * (the checkpoints that close each block) - what a computer needs to cut its copy
     * into JSON blocks, each checked there against the key's own public key - and this
     * phone's own latest statement (its NAMETAG, 2026-10-08): what lets that computer
     * offer this phone's log to your other devices.
     */
    /* this phone's nametag - its device name until you set one (Brad, 2026-10-08) */
    const own = next === null ? await ensureNametag(soft) : null;
    const blocks = next === null ? {
      seals: (mirror.seals ?? []).map(s => [s.seq, hex(s.head), hex(s.signature)]),
      ...(own ? {statement: {deviceId: own.deviceId, publicKey: own.publicKey, seq: own.seq, nametag: own.nametag, signature: own.signature}} : {}),
    } : {};
    return {ok: true, links: batch.map((r: any) => [hex(r.link), hex(r.head), r.reveal ? hex(r.reveal) : null]), next, ...blocks};
  }
  /* HAVE / LINKS / OFFER for ANOTHER device's chain: what this phone holds of it (merged or held) */
  const other = p.chain ? String(p.chain).toLowerCase() : null;
  if (other && other === toHexId(soft.deviceId)) return {ok: false, refusal: 'invalid', detail: "that is this phone's own chain"};
  if (msg.type === syncLib.HAVE_TYPE && other) {
    syncNames.set(peer, p.name);
    const merged = (await loadMirror(fromHexId(other))).links.map((r: any) => seqOfLink(r));
    const heldOne = (await loadHeld()).find(h => h.deviceId === other);
    const heldSeqs = heldOne ? heldOne.records.map(([l]) => seqOfLink({link: fromHexId(l)})) : [];
    return {ok: true, ranges: syncLib.rangesOf([...new Set([...merged, ...heldSeqs])].sort((a, b) => a - b))};
  }
  if (msg.type === syncLib.HAVE_TYPE) {
    syncNames.set(peer, p.name);
    const {mirror} = await syncCopy(soft); /* what this copy holds NOW, the key's newest included */
    return {ok: true, ranges: syncLib.rangesOf(mirror.links.map((r: any) => seqOfLink(r)))};
  }
  /*
   * THE KEY CHAIN LIST IS NOT EDGE'S (Brad, 2026-10-08: "Move it out of Edge"): it is the Key
   * Chain plugin's, and syncs on its own. Edge's sync carries device logs only.
   */
  if (msg.type === syncLib.TAKE_TYPE || msg.type === syncLib.KEYCHAIN_TYPE) {
    return {ok: false, refusal: 'invalid', detail: "the Key Chain list is not part of Edge's sync"};
  }
  let st = syncStaged.get(p.sid);
  if (!st) {
    st = {peer, links: new Map(), linkParts: 0, chain: null};
    syncStaged.set(p.sid, st);
  }
  if (st.peer !== peer) return {ok: false, refusal: 'invalid', detail: 'a part of another sync'};
  if ((st.chain ?? null) !== (p.chain ?? null) && st.links.size) return {ok: false, refusal: 'invalid', detail: 'a part of another chain'};
  st.chain = p.chain ?? null;
  if (msg.type === syncLib.LINKS_TYPE) {
    st.links.set(p.part, syncLib.recordsOf(msg));
    st.linkParts = p.parts;
    return {ok: true, staged: st.links.size};
  }
  if (msg.type === syncLib.OFFER_TYPE) {
    /*
     * ANOTHER DEVICE'S LOG, HELD (Brad, 2026-10-08: "we should hold these blocks in the app
     * until approved and merged"): kept in edgeDevices' held area with its checkpoint and
     * statement - no sheet, nothing merged. The Edge tab's banner opens the Approve sheet.
     */
    syncStaged.delete(p.sid);
    if (st.links.size !== p.linkParts) return {ok: false, refusal: 'invalid', detail: `parts missing (links ${st.links.size}/${p.linkParts}) - sync again`};
    const offered = [...st.links.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, r]) => r);
    /* what this phone already holds of that chain (merged, or held before), with what came now */
    const before = [...(await loadMirror(fromHexId(String(p.chain)))).links];
    const heldBefore = (await loadHeld()).find(h => h.deviceId === String(p.chain).toLowerCase());
    if (heldBefore) for (const [l, hd, r] of heldBefore.records) before.push({link: fromHexId(l), head: fromHexId(hd), reveal: r ? fromHexId(r) : null});
    const all = syncLib.merge(syncLib.merge([], before).links, offered);
    const c = p.checkpoint;
    const st2 = p.statement;
    const r = await holdLog({
      deviceId: fromHexId(String(p.chain)), publicKey: fromHexId(st2.publicKey), records: all.links,
      checkpoint: {seq: c.seq, head: fromHexId(c.head), signature: fromHexId(c.signature)},
      statement: {deviceId: fromHexId(String(p.chain)), publicKey: fromHexId(st2.publicKey), seq: st2.seq ?? null, nametag: st2.nametag, signature: fromHexId(st2.signature)},
      from: syncNames.get(peer) ?? 'a computer',
    });
    return {ok: true, held: r.held, count: offered.length};
  }
  if (st.chain) return {ok: false, refusal: 'invalid', detail: "another device's links end with an offer, not a commit"};
  /* COMMIT: every part here; this phone's own links merge (its own key's, nothing new to trust) */
  syncStaged.delete(p.sid);
  if (p.keychainParts) return {ok: false, refusal: 'invalid', detail: "the Key Chain list is not part of Edge's sync"};
  if (st.links.size !== p.linkParts) return {ok: false, refusal: 'invalid', detail: `parts missing (links ${st.links.size}/${p.linkParts}) - sync again`};
  const offered = [...st.links.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, r]) => r);
  const m = await mergeOffered(soft, offered);
  if (m.conflicts.length) {
    return {ok: false, refusal: 'invalid', detail: `a fork: this phone's copy holds different links at #${m.conflicts.join(', #')} - nothing taken; settle it on the phone`};
  }
  if (m.added.length && m.view.verdict.kind !== 'verified' && m.view.verdict.kind !== 'gap') {
    return {ok: false, refusal: 'copy_unverified', detail: `with those links this phone's copy would not verify (${m.view.verdict.kind}) - nothing taken`};
  }
  /* Brad, 2026-10-08 ("Own links direct"): this phone's OWN links merge at once - its own key's, checked against its signature */
  if (m.added.length) {
    await keepOffered(soft.deviceId, m.added);
    await syncCopy(soft).catch(() => undefined);
  }
  return {ok: true, count: m.added.length, seq: null};
}
/*
 * R30 (P2c): a place brings this phone a SIBLING's chain up to the sibling's
 * signed checkpoint. Checked first, with no one asked (sync.anchorCheck): the
 * sibling's key from the KEY's list, its checkpoint signature, the links up to
 * it, and against every checkpoint this phone anchored it at before - a
 * rollback or a changed head is the spec's ALARM (one device's tampering
 * proven by the other): the phone posts it and nothing is anchored. Then one
 * sheet, Yes, a press; the key checks the checkpoint again and links the anchor;
 * only then are the sibling's links kept.
 */
const toHexId = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const fromHexId = (h: string) => Uint8Array.from((String(h).match(/../g) ?? []).map(x => parseInt(x, 16)));
const seqOfLink = (r: any) => chain.decodeLink(r.link).seq;

async function handle(msg: any, from: string): Promise<unknown | null> {
  const seen = await loadSeen();
  try {
    if ([syncLib.HAVE_TYPE, syncLib.LINKS_TYPE, syncLib.KEYCHAIN_TYPE, syncLib.COMMIT_TYPE, syncLib.TAKE_TYPE, syncLib.GIVE_TYPE, syncLib.OFFER_TYPE].includes(msg?.type)) return await handleSync(msg, seen);
    if (msg?.type !== requestLib.TYPE) return null;
    /* the Requests switch is off: refused unread */
    if (!(await agentRequestsOn())) return null;
    /* who asks: the paired computer behind this link - none, no answer (the bridge already took only encrypted traffic) */
    const computer = await btTransit.computer(from).catch(() => null);
    if (!computer) return null;
    step('computer');
    /* a timed-out sheet nobody has closed: nobody is there to press - refused at once, no new sheet */
    if (unattended()) return {ok: false, refusal: 'timeout', detail: UNATTENDED_DETAIL};
    soft = soft ?? (await SoftKeyEdge.open());
    if (!soft) return {ok: false, refusal: 'invalid', detail: 'this phone\'s key has no Edge'};
    await soft.loadAgentBudgets();
    step('budgets');
    /*
     * R27 BEFORE the sheet: a copy that does not verify cannot open a budget,
     * so Approve is greyed out with the reason (Brad, 2026-10-03). Decline
     * still answers, and the agent is told copy_unverified - the reason.
     */
    /* the copy first brought up to the key's head: links made since the last sync (a register, a direct ssh use) are not a gap */
    /* the copy brought to the key's head once, here (Brad, 2026-10-06: it synced twice before the sheet) */
    await syncCopy(soft).catch(() => undefined);
    step('sync');
    const copy: any = await soft.check().catch((e: unknown) => ({ok: false, reason: String(e)}));
    step('check');
    const blocked = copy.ok
      ? null
      : `this phone's copy of the chain does not verify (${copy.reason}${copy.seq !== undefined ? ` at #${copy.seq}` : ''}). Sync or settle it on the Edge tab.`;
    let asked: SheetAsk | null = null;
    const r: any = await soft.answerAgent(msg, {
      seen,
      from: computer.name,
      computer: computer.id,
      ask: async view => {
        asked = {kind: 'request', computer: computer.name, view, blocked, at: Date.now()};
        step('answerAgent');
        stepsDone('sheet shown');
        const a = await askPerson(asked);
        return blocked ? 'copy_unverified' : a;
      },
      onPress: () => asked && show({phase: 'press', ask: asked, until: Date.now() + PRESS_WAIT_MS}),
    });
    if (r.dropped) return null;
    if (r.ok) await syncCopy(soft).catch(() => undefined); /* the opening link, into the tab's copy */
    if (asked) {
      show({
        phase: 'done',
        ask: asked,
        result: r.ok ? {ok: true, text: `Budget ${r.budget.grantId} is open: ${r.budget.uses} uses for ${msg.lifetime} minutes`, grantId: r.budget.grantId} : r,
      });
    }
    return r;
  } finally {
    await saveSeen(seen);
  }
}
