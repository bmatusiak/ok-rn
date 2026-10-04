/**
 * AGENTS ASKING FOR BUDGETS (onlykey-edge build/mcp-service.md 4.7a, step 2).
 *
 * A computer's agent service sends an EDGE_REQUEST over Bluetooth; the vendor
 * bridge KEEPS it for this file (it never reaches the key) and sends back what
 * this file answers. The key only ever sees hashes, so the person approves the
 * TEXT and the NAMES here, on the sheet (EdgeRequestSheet), and the library's
 * one implementation makes every hash from them (approve.approveRequest).
 *
 * What this phone keeps (AsyncStorage):
 * - the registered agents: an agent's key is registered ONCE, on the sheet;
 *   before that its requests are dropped without being read;
 * - the nonces already taken (a replay is dropped);
 * - the person's OWN identities - a request naming one gets the red warning
 *   and a second confirm (Brad, 2026-10-03), starting with
 *   ssh://bmatusiak@localhost.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {approve as approveLib, request as requestLib} from 'node-onlykey-lib/edge';
import {SoftKeyEdge} from './edgeSoftKey';
import {sync as syncCopy} from './edgeStore';
import NativeOkEmu from '../specs/NativeOkEmu';

const AGENTS = 'okrn.edge.agents';
const SEEN = 'okrn.edge.seenNonces';
const OWN = 'okrn.edge.ownIdentities';
const LAST = 'okrn.edge.agentLast';
const ON = 'okrn.edge.agentRequests';
const SEEN_KEPT = 2000;
export const DEFAULT_OWN_IDENTITIES = ['ssh://bmatusiak@localhost'];
/* how long the sheet waits for the person before the agent is told 'timeout' -
 * two minutes to read the request and say Yes (Brad, 2026-10-03; was 90 s) */
const SHEET_WAIT_MS = 120000;
/* the firmware's own press window: the key stops waiting after 25 s */
export const PRESS_WAIT_MS = 25000;

/* seq: the key's AGENT_ADD link for it - registered with a press */
export type Agent = {key: string; name: string; registered: number; seq?: number};

export async function loadAgents(): Promise<Agent[]> {
  return JSON.parse((await AsyncStorage.getItem(AGENTS)) || '[]');
}
/*
 * The agents that COUNT (R15c): those whose AGENT_ADD link - made at a press -
 * is in this phone's VERIFIED copy of the chain. The stored list is only a
 * convenience (names, when); an entry without its link (planted in storage,
 * or kept from before the press existed) is refused unread. `inCopy` is the
 * seq of the link the copy verified.
 */
export async function verifiedAgents(): Promise<(Agent & {inCopy: number | null})[]> {
  soft = soft ?? (await SoftKeyEdge.open());
  const stored = await loadAgents();
  if (!soft) return stored.map(a => ({...a, inCopy: null}));
  const view = await syncCopy(soft).then(r => r.view).catch(() => null);
  const rows = view?.rows ?? [];
  return stored.map(a => ({...a, inCopy: approveLib.agentInCopy(rows, a.key)}));
}
async function pressedAgents(): Promise<Agent[]> {
  return (await verifiedAgents()).filter(a => a.inCopy !== null);
}
export async function forgetAgent(key: string) {
  await AsyncStorage.setItem(AGENTS, JSON.stringify((await loadAgents()).filter(a => a.key !== key)));
}
export async function loadOwnIdentities(): Promise<string[]> {
  const raw = await AsyncStorage.getItem(OWN);
  return raw ? JSON.parse(raw) : [...DEFAULT_OWN_IDENTITIES];
}
export async function saveOwnIdentities(names: string[]) {
  await AsyncStorage.setItem(OWN, JSON.stringify(names));
}

/* the Agents card's "Requests" switch: off = every agent request is refused unread (a quick "stop all agents") */
export async function agentRequestsOn(): Promise<boolean> {
  return (await AsyncStorage.getItem(ON)) !== 'off';
}
export async function setAgentRequestsOn(on: boolean) {
  await AsyncStorage.setItem(ON, on ? 'on' : 'off');
}

/* each agent's last request, for the Agents card: when, its reason, what it got */
export type LastRequest = {at: number; reason: string; result: string};
export async function loadLastRequests(): Promise<Record<string, LastRequest>> {
  return JSON.parse((await AsyncStorage.getItem(LAST)) || '{}');
}
async function noteLast(agent: string, reason: string, result: string) {
  const all = await loadLastRequests();
  all[agent] = {at: Date.now(), reason, result};
  await AsyncStorage.setItem(LAST, JSON.stringify(all));
}

/**
 * Remove an agent (4.7a: no press): ok-rn forgets it - its requests are then
 * refused unread - and every budget it holds on the key is ended (a revoke).
 */
export async function removeAgent(key: string): Promise<number[]> {
  soft = soft ?? (await SoftKeyEdge.open());
  const ended: number[] = [];
  if (soft) {
    const held = (await soft.liveAgentBudgets())[key] ?? [];
    for (const b of held) {
      await soft.revoke(b.grantId);
      ended.push(b.grantId);
    }
    if (ended.length) await syncCopy(soft).catch(() => undefined);
  }
  await forgetAgent(key);
  return ended;
}

/** The agent budgets live on the key right now, by agent key (the Agents card). */
export async function liveAgentBudgets() {
  soft = soft ?? (await SoftKeyEdge.open());
  return soft ? soft.liveAgentBudgets() : {};
}

async function loadSeen(): Promise<Set<string>> {
  return new Set(JSON.parse((await AsyncStorage.getItem(SEEN)) || '[]'));
}
async function saveSeen(seen: Set<string>) {
  await AsyncStorage.setItem(SEEN, JSON.stringify([...seen].slice(-SEEN_KEPT)));
}

/* ---------------------------------------------------------------- the sheet */

export type SheetAsk =
  | {kind: 'register'; agent: string; name: string; fingerprint: string}
  /* blocked: why Approve is off - this phone's copy does not verify (R27); Decline still answers */
  | {kind: 'request'; agentName: string; view: any; blocked: string | null; at: number};
/* until: when this phase runs out (ms since epoch) - the sheet counts down to it */
export type SheetState =
  | {phase: 'ask'; ask: SheetAsk; until: number}
  | {phase: 'press'; ask: SheetAsk; until: number}
  | {phase: 'done'; ask: SheetAsk; result: {ok: true; text: string} | {ok: false; refusal: string; detail?: string}};

type Listener = (s: SheetState | null) => void;
const listeners = new Set<Listener>();
let current: SheetState | null = null;
let answer: ((a: 'approve' | 'decline' | 'timeout') => void) | null = null;
let soft: SoftKeyEdge | null = null;

function show(s: SheetState | null) {
  current = s;
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
      NativeOkEmu.setAttention(s.ask.kind === 'register' ? 'An agent asks to register' : 'An agent asks for a budget', s.until);
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
export function answerSheet(a: 'approve' | 'decline') {
  const f = answer;
  answer = null;
  f?.(a);
}
export function closeSheet() {
  if (current?.phase === 'done') show(null);
}
/** the soft key's press, from the sheet's own button */
export async function pressFromSheet() {
  await soft?.press();
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

/* one at a time: a second request waits for the first sheet */
let queue: Promise<unknown> = Promise.resolve();

/**
 * The vendor bridge's hand-off: an assembled message from computer `from`.
 * -> the answer to send back, or null to answer nothing (dropped).
 */
export function handleEdgeMessage(msg: any, from: string): Promise<unknown | null> {
  const run = queue.then(() => handle(msg, from)).catch((e: unknown) => {
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
  return run;
}

async function handle(msg: any, from: string): Promise<unknown | null> {
  const seen = await loadSeen();
  try {
    if (msg?.type === requestLib.REGISTER_TYPE) {
      /* the press is the KEY's (AGENT_ADD), so registering needs this phone's key with Edge */
      if (!requestLib.verifyRegister(msg, {seen}).ok) return null;
      soft = soft ?? (await SoftKeyEdge.open());
      if (!soft) return {ok: false, refusal: 'invalid', detail: "this phone's key has no Edge"};
      const agents = await pressedAgents();
      let asked: SheetAsk | null = null;
      const r: any = await soft.registerAgent(msg, {
        registered: agents.map(a => a.key),
        seen,
        ask: async (v: {agent: string; name: string; fingerprint: string}) => {
          asked = {kind: 'register', ...v};
          return askPerson(asked);
        },
        onPress: () => asked && show({phase: 'press', ask: asked, until: Date.now() + PRESS_WAIT_MS}),
      });
      if (r.dropped) return null;
      if (r.ok && !r.already) {
        await syncCopy(soft).catch(() => undefined); /* the agent-add link, into the tab's copy */
        const others = (await loadAgents()).filter(a => a.key !== r.agent);
        await AsyncStorage.setItem(AGENTS, JSON.stringify([...others, {key: r.agent, name: r.name, registered: Date.now(), seq: r.seq}]));
      }
      if (asked) show({phase: 'done', ask: asked, result: r.ok ? {ok: true, text: `${r.name} is registered (the key linked it as #${r.seq})`} : r});
      return r;
    }
    if (msg?.type !== requestLib.TYPE) return null;
    /* the Agents card's switch is off: refused unread, like an unregistered agent */
    if (!(await agentRequestsOn())) return null;

    const agents = await pressedAgents();
    /* not registered: refused before anything in it is read - no sheet, no answer */
    if (!agents.some(a => a.key === String(msg.agent).toLowerCase())) return null;
    soft = soft ?? (await SoftKeyEdge.open());
    if (!soft) return {ok: false, refusal: 'invalid', detail: 'this phone\'s key has no Edge'};
    await soft.loadAgentBudgets();
    const agentName = agents.find(a => a.key === String(msg.agent).toLowerCase())?.name ?? 'an agent';
    /*
     * R27 BEFORE the sheet: a copy that does not verify cannot open a budget,
     * so Approve is greyed out with the reason (Brad, 2026-10-03). Decline
     * still answers, and the agent is told copy_unverified - the reason.
     */
    /* the copy first brought up to the key's head: links made since the last sync (a register, a direct ssh use) are not a gap */
    await syncCopy(soft).catch(() => undefined);
    const copy: any = await soft.check().catch((e: unknown) => ({ok: false, reason: String(e)}));
    const blocked = copy.ok
      ? null
      : `this phone's copy of the chain does not verify (${copy.reason}${copy.seq !== undefined ? ` at #${copy.seq}` : ''}). Sync or settle it on the Edge tab.`;
    let asked: SheetAsk | null = null;
    const r: any = await soft.answerAgent(msg, {
      registered: agents.map(a => a.key),
      seen,
      ownIdentities: await loadOwnIdentities(),
      from: agentName,
      ask: async view => {
        asked = {kind: 'request', agentName, view, blocked, at: Date.now()};
        const a = await askPerson(asked);
        return blocked ? 'copy_unverified' : a;
      },
      onPress: () => asked && show({phase: 'press', ask: asked, until: Date.now() + PRESS_WAIT_MS}),
    });
    if (r.dropped) return null;
    if (r.ok) await syncCopy(soft).catch(() => undefined); /* the opening link, into the tab's copy */
    await noteLast(String(msg.agent).toLowerCase(), msg.reason, r.ok ? `budget ${r.budget.grantId} opened` : r.refusal);
    if (asked) {
      show({
        phase: 'done',
        ask: asked,
        result: r.ok ? {ok: true, text: `Budget ${r.budget.grantId} is open: ${r.budget.uses} uses for ${msg.lifetime} minutes`} : r,
      });
    }
    return r;
  } finally {
    await saveSeen(seen);
  }
}
