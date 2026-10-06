/**
 * The VENDOR interface, relayed between the BLE vendor service and the key.
 *
 * ## What this is for
 *
 * The FIDO service carries CTAP, and the firmware serves exactly four OnlyKey
 * operations on that path - OKPING, OKCONNECT, OKSIGN, OKDECRYPT
 * (fido2/solo.cpp:74-81). Slots, labels, preferences, key loading, backup,
 * restore and config mode are all `recvmsg` on the VENDOR interface and cannot
 * be reached from FIDO at all. A host that wants to drive a key the way
 * `python-onlykey` drives a plugged-in one needs that interface over the radio.
 *
 * ## It is a PIPE, not a protocol
 *
 * Nothing here parses a report. A write from the host goes to IFACE.VENDOR
 * unexamined, and every vendor report the device produces WHILE A BLE COMPUTER
 * OWNS THE CONVERSATION is notified back unexamined (see `owner` below - it
 * used to be every report, the app's own answers included). That is
 * deliberate: the vendor protocol is not request/response -
 * OKSETSLOT answers nothing, OKGETLABELS answers with a report per slot - so
 * there is no correlation to maintain and inventing one would drop every report
 * after the first of a multi-report answer.
 *
 * The host correlates, which is exactly what it does over USB: `pipeTransport`
 * subscribes before writing and filters with a predicate, and python's
 * `read_bytes()` polls until its own timeout and returns an empty list when
 * nothing came.
 *
 * ## Removable
 *
 * One file and one call in useFidoGatt. Delete both and nothing listens for
 * `iface: 'vendor'` events; the native side still raises them and a host gets
 * silence, which is the correct answer from a device that does not offer the
 * feature. `fidoBridge` never sees them either way - it ignores any interface
 * that is not its own.
 */
import {bytes as okbytes, protocol, transport as oktransport} from 'node-onlykey-lib';
import {wire as edgeWire, ping as edgePing} from 'node-onlykey-lib/edge';
import NativeFidoGatt from '../specs/NativeFidoGatt';
import FidoGatt, {isFromTarget, type CtapRequestEvent} from './transport/FidoGatt';
import {btTransit, type BtTransit} from './btTransit';
import type {OnlyKeyApp} from './onlykey';
import type {LogLevel} from './hooks/useLog';
import {testingModeOn} from './debugGuard';
import {armedIntent} from './edgeIntent';

/*
 * ONE MEASURING ROUND ON THE A13 (Brad, 2026-10-06): pings are answered in a
 * production build too - still only inside the encrypted session (Part T). The
 * echo returns only what that same paired computer just sent (at most 8 KB),
 * touches no key, budget or storage, and logs counts, times and random ids
 * only. Measured 2026-10-06 (A13: 20 of 20 exact, ~2.2 s per 1 KB); set back to
 * false the same day - testing mode only.
 */
const PING_IN_PRODUCTION = false;

const IFACE_VENDOR = oktransport.IFACE.VENDOR;

/*
 * THE ONE MESSAGE THIS BRIDGE WILL NOT CARRY: OKFWUPDATE.
 *
 * Everything else crosses unexamined, and that is still the design - this is a
 * transport for OPERATING a key, and a transport that second-guesses what it
 * carries is one whose behaviour stops matching a cable. This is the single
 * exception, and it is named rather than generalised into a denylist that
 * would have to stay right about every message the firmware ever adds.
 *
 * Why this one. OKFWUPDATE is the in-firmware update path, and on a physical
 * developer key it "locks the bootloader and permanently converts a developer
 * key into a production key" (onlykey-testing/TODO.md:408, the maintainer's
 * understanding, deliberately never tested). onlykey-testing gates it behind
 * `requires: ['emulated']` so its own hardware adapter can never send it.
 *
 * And this bridge CAN reach a physical key: it relays to whichever key is
 * active in the app (App.tsx passes getActiveKey), and a plugged-in hard key
 * takes priority. So without this a paired computer could send 0xf4 to real
 * hardware over the radio, unattended - the least supervised route there is to
 * an irreversible change.
 *
 * Refused for BOTH keys, not just the hard one, because the bench owner's rule
 * is that "hard key and soft key must work the same" - a feature that behaves
 * differently on the stand-in would stop proving anything about the real one.
 * And refused at all because firmware update is not ok-rn's job on this path:
 * "firmware update for production and development is completely different.
 * ok-rn should not handle doing the developer keys". A developer key is
 * reflashed through its HalfKay bootloader on a build host; a production key
 * takes a signed image through its own flow.
 */
const OK_HEADER: readonly number[] = protocol.okmsg.HEADER;
const OKFWUPDATE: number = protocol.MSG.OKFWUPDATE;

function isFirmwareUpdate(data: Uint8Array): boolean {
  if (data.length <= OK_HEADER.length) return false;
  for (let i = 0; i < OK_HEADER.length; i++) {
    if (data[i] !== OK_HEADER[i]) return false;
  }
  return data[OK_HEADER.length] === OKFWUPDATE;
}

type Options = {
  log: (level: LogLevel, text: string) => void;
  /** The key to relay to, supplied rather than imported - see fidoBridge. */
  getKey: () => Promise<OnlyKeyApp>;
  /**
   * The "API" switch on the Bluetooth tab - this door's gate, separate from
   * WebAuthn's. Read through a function, because the bridge is attached once
   * and the answer changes under it.
   */
  isApi?: () => boolean;
  /** The targeted computer's address, or null for None. See onRequest. */
  getTarget?: () => string | null;
  /**
   * Is the key waiting for a press (or a code) right now? The soft key can
   * say (OkEmu.waiting); a key that cannot answers false, and a computer's
   * conversation then ends on quiet alone. See holdForComputer.
   */
  isKeyWaiting?: () => Promise<boolean>;
  /**
   * An agent's EDGE_REQUEST (or EDGE_REGISTER), whole: the answer to send
   * back, or null to answer nothing. See "THE ONE MESSAGE THIS BRIDGE KEEPS".
   */
  onEdgeRequest?: (message: unknown, from: string) => Promise<unknown | null>;
  /**
   * Part T, the pairing gate (btTransit.ts): opens sealed frames into reports,
   * answers pairing and handshakes, seals what goes back. Injected for tests;
   * the app uses its one gate.
   */
  transit?: BtTransit;
};

/* a computer's conversation holds the key's lane until it has been quiet this long (and nothing waits for a press) */
const COMPUTER_QUIET_MS = 1500;

/*
 * A BLE write we are about to make, as the 'write' event will echo it: the
 * transport pads a vendor report to 64 bytes, so the echo is our bytes and
 * then zeros. See `ours` in startVendorBridge.
 */
function isEchoOf(sent: Uint8Array, echoed: Uint8Array): boolean {
  if (echoed.length < sent.length) return false;
  for (let i = 0; i < sent.length; i++) {
    if (echoed[i] !== sent[i]) return false;
  }
  for (let i = sent.length; i < echoed.length; i++) {
    if (echoed[i] !== 0) return false;
  }
  return true;
}

/*
 * WHEN A COMPUTER LAST USED THE BRIDGE - a write in, or a report out to it.
 * The app's own requests to the soft key (the Edge copy's background sync)
 * must not land in the middle of a computer's conversation: an app write sets
 * owner = null below, and the computer's answer would then go to the app.
 * Callers wait until this has been quiet for a while (useEdgeBackgroundSync).
 */
let lastHostActivity = 0;
export function vendorQuietForMs(): number {
  return Date.now() - lastHostActivity;
}

/*
 * THE ONE MESSAGE THIS BRIDGE KEEPS FOR THE APP: OKEDGE_REQUEST (0xF7,
 * node-onlykey-lib src/edge/wire.js; mcp-service.md 4.7a).
 *
 * A budget request is for the PERSON, not the key: the key only ever sees
 * hashes, so the app must show the reason text and the identity names and make
 * the hashes itself. So its pieces are gathered here, by computer, handed to
 * `onEdgeRequest`, and the answer goes back the same way - nothing of it is
 * written to the key, and no key report goes out with it. The same gates as
 * every other write: API on, and the target only.
 */
function isEdgeRequest(data: Uint8Array): boolean {
  return edgeWire.isEdgeRequestFrame(data);
}

/*
 * Whether a computer's conversation holds the key right now, and a call when it
 * lets go - for the Edge tab, which skips its sync while a computer holds the
 * key and syncs once it is free (Brad, 2026-10-06: its reads only queued behind
 * the agent, 6-7 s each).
 */
let computerHolding = false;
const freeListeners = new Set<() => void>();
export function computerHoldsKey(): boolean {
  return computerHolding;
}
export function onKeyFree(listener: () => void): () => void {
  freeListeners.add(listener);
  return () => {
    freeListeners.delete(listener);
  };
}

export function startVendorBridge({log, getKey, isApi, getTarget, isKeyWaiting, onEdgeRequest, transit = btTransit}: Options): () => void {
  /* EDGE_REQUEST pieces, by the computer sending them */
  const gathering = new Map<string, ReturnType<typeof edgeWire.createAssembler>>();
  /* whether every piece of the message being gathered from that computer came sealed (Part T) */
  const allSealed = new Map<string, boolean>();
  /* when the message being gathered from that computer began (ping timing) */
  const firstPiece = new Map<string, {at: number; pieces: number}>();
  /* pings echoed whose verdict (the computer's receipt) has not come yet */
  const waitingVerdict = new Map<string, ReturnType<typeof setTimeout>>();
  /* this phone's id on the Edge wire (btTransit.deviceId) - read once */
  let myDev = '';
  void Promise.resolve(transit.deviceId?.()).then(d => { myDev = d ?? ''; }).catch(() => undefined);
  /* Which transport the report subscription is attached to, so a key change
   * moves it rather than leaving it listening to the previous device. */
  let boundTo: unknown = null;
  let offReport: (() => void) | null = null;
  let offWrite: (() => void) | null = null;

  /*
   * WHO THE KEY IS ANSWERING: the address of the BLE computer whose request
   * went to the key last, or null when the last vendor write was the APP's.
   *
   * THE LEAK THIS CLOSES. Every IFACE.VENDOR report the key produced used to
   * be notified to the central whenever the switch was on - including the
   * answers to the app's OWN requests. Opening the Slots tab asks the key for
   * its labels over this same interface, so a paired computer, listening,
   * received the slot list without having asked for anything.
   *
   * Why ownership and not "only the reply to that request": the vendor
   * protocol has no correlation. OKSETSLOT answers nothing, OKGETLABELS
   * answers with a report per slot, and a signing request answers only after
   * a button press that may be twenty seconds away - so there is no rule
   * that says which report answers which write, and one invented here would
   * drop the tail of every multi-report answer. What IS knowable is who
   * spoke to the key last. The key answers whoever last addressed it, the
   * same way a single USB host owns the conversation over a cable, so the
   * reports belong to that speaker until someone else speaks.
   *
   * The app's writes are seen on the transport's 'write' event - both keys'
   * pipes report every write, in both directions. Our own BLE writes appear
   * there too, so they are recognised by content (`ours`) and do not hand
   * the conversation back to the app.
   *
   * What it does not cover: an unsolicited report the key volunteers while a
   * BLE computer owns the conversation goes to that computer. That is what
   * the computer would see on a cable too, and it is still only ever the
   * target (the native side sends nowhere else).
   */
  let owner: string | null = null;
  /* BLE writes on their way to the key, so their echo is not read as the
   * app speaking. Bounded: a pipe that never echoes must not grow it. */
  const ours: Uint8Array[] = [];

  /*
   * Sends are SERIALISED through this chain.
   *
   * The notify budget is per LINK - Android allows one outstanding
   * notification on a connection - and sendVendorReport rejects a second call
   * before the first has drained. A multi-report answer arrives as a burst of
   * 'report' events with nothing between them, so without a chain the first
   * would go out and the rest would reject.
   *
   * Ordering matters as much as delivery: the host reassembles a label list by
   * arrival, so reports must reach the wire in the order the device produced
   * them.
   */
  let sending: Promise<void> = Promise.resolve();

  /*
   * A COMPUTER'S CONVERSATION HOLDS THE KEY'S LANE (owner, 2026-10-03: "fix
   * both races"). The lib's lane (node-onlykey-lib src/transport/lane.js)
   * gives the app's own conversations one at a time - Key Chain reads, the
   * background Edge copy, a sign. A computer's writes come through here,
   * raw, so without this an app request could still land in the middle of
   * a computer's push or gpg signature and take its answer (the owner =
   * null rule below would then send it to the app).
   *
   * The bridge cannot see where a computer's conversation ends - no request
   * ids, multi-report answers, a press of up to 20 s - so it holds the lane
   * from the computer's first write until the key has been quiet for
   * COMPUTER_QUIET_MS AND is not waiting for a press. The computer's later
   * writes (a chunked request) go straight in while it holds it.
   */
  let held: {release: () => void; timer: ReturnType<typeof setTimeout> | null; since: number} | null = null;
  let holding: Promise<void> | null = null;
  function armRelease() {
    if (!held) return;
    if (held.timer) clearTimeout(held.timer);
    held.timer = setTimeout(() => {
      void (async () => {
        if (!held) return;
        const waiting = isKeyWaiting ? await isKeyWaiting().catch(() => false) : false;
        if (waiting) return armRelease(); /* a press is pending: the conversation is not over */
        releaseHold('');
      })();
    }, COMPUTER_QUIET_MS);
  }
  function releaseHold(why: string) {
    if (!held) return;
    if (held.timer) clearTimeout(held.timer);
    const h = held;
    held = null;
    holding = null;
    computerHolding = false;
    h.release();
    /* how long the app's own key reads (the Edge tab's sync) could not get in */
    console.log(`[vendor] the key is free again: the computer held it ${Date.now() - h.since} ms${why}`);
    for (const l of [...freeListeners]) l();
  }
  function holdForComputer(transport: any): Promise<void> {
    if (holding) return holding;
    holding = new Promise<void>(ready => {
      const conversation = () => new Promise<void>(release => {
        held = {release, timer: null, since: Date.now()};
        computerHolding = true;
        console.log('[vendor] the computer holds the key');
        ready();
        armRelease();
      });
      if (typeof transport.exclusive === 'function') {
        void transport.exclusive(conversation);
      } else {
        void conversation();
      }
    });
    return holding;
  }

  /*
   * The whole outbound gate: the API door open, and the computer that owns
   * the conversation still the target. This is the first gate and
   * sendVendorReport the last - it sends only to the target's connection,
   * and only with API on.
   */
  function mayForward(): boolean {
    if (isApi && !isApi()) return false;
    if (!owner) return false;
    if (getTarget && !isFromTarget(owner, getTarget())) return false;
    return true;
  }

  /*
   * A report from the key (or an Edge answer) for the computer `to`: sealed
   * for its session by the gate, or plaintext only while testing mode has
   * transit off. Nothing goes out to a computer without a session.
   */
  function push(data: Uint8Array, to: string | null = owner) {
    const out = transit.outgoing(to, data);
    if (!out) {
      log('info', '[vendor] a report was not sent - that computer has no paired session');
      return;
    }
    sendFrame(out.cmd, out.bytes);
  }

  /* every frame leaves through this chain, in order (see `sending`) */
  function sendFrame(cmd: number, bytes: Uint8Array) {
    lastHostActivity = Date.now();
    sending = sending
      .then(() => NativeFidoGatt.sendVendorFrame(cmd, okbytes.toHex(bytes)))
      .catch((err: unknown) => {
        /*
         * Swallowed, and the chain continues. A failed notify is usually the
         * central having gone away mid-answer; letting it reject the chain
         * would leave every later report unsent with no way to recover short
         * of a reconnect.
         */
        log('info', `[vendor] report not delivered: ${String(err)}`);
      });
  }

  async function ensureSubscribed() {
    const {transport} = await getKey();
    if (boundTo === transport) return transport;
    if (offReport) {
      log('info', '[vendor] the active key changed; rebinding');
      offReport();
    }
    if (offWrite) offWrite();
    offWrite = null;
    /* A different key has had no conversation with anyone yet. */
    owner = null;
    ours.length = 0;
    boundTo = transport;
    offReport = transport.on(
      'report',
      ({iface, data}: {iface: number; data: Uint8Array}) => {
        if (iface !== IFACE_VENDOR) return;
        if (held) armRelease(); /* the key is still answering: the conversation goes on */
        if (!mayForward()) return;
        push(data);
      },
    );
    offWrite = transport.on(
      'write',
      ({iface, data}: {iface: number; data: Uint8Array}) => {
        if (iface !== IFACE_VENDOR) return;
        const mine = ours.findIndex(sent => isEchoOf(sent, data));
        if (mine >= 0) {
          ours.splice(mine, 1);
          return;
        }
        /* The app spoke to the key: what comes back is the app's. */
        owner = null;
      },
    );
    return transport;
  }

  async function onRequest(event: CtapRequestEvent) {
    if (event.iface !== 'vendor') return;

    /*
     * THE SECOND GATE. The native side refuses a vendor write from anyone but
     * the target, and with API off, before it ever becomes an event; this
     * asks again because a request can cross a change of target in flight,
     * and a gate that is only in Kotlin is one no test here can see. Dropped
     * rather than answered - the vendor protocol has no refusal report.
     */
    if (getTarget && !isFromTarget(event.address, getTarget())) {
      log('info', `[vendor] refused a write from ${event.address || 'an unknown computer'} - not the target`);
      return;
    }
    if (isApi && !isApi()) {
      log('info', '[vendor] API is off; the write was dropped');
      return;
    }

    try {
      /*
       * THE PAIRING GATE (Part T). Pairing and handshake messages are answered
       * by the gate; a sealed frame becomes the report inside it; plaintext
       * only while testing mode has transit off. Anything else: silence.
       */
      const got = await transit.handle(event.command, okbytes.fromHex(event.hex), event.address);
      if (!got) return;
      /* several reports in one write (btTransit KIND.REPORTS): each on its own, in order, as if it came alone */
      const sealed = (event.command | 0x80) === 0x84; /* came inside the encrypted session (Part T) */
      for (const data of Array.isArray(got) ? got : [got]) await forward(data, event.address, sealed);
    } catch (err) {
      log('error', `[vendor] write failed: ${String(err)}`);
    }
  }

  /** One report from the computer to the key - the checks every report gets, alone or packed. */
  async function forward(data: Uint8Array, address: string, sealed = false) {
    try {
      /*
       * Before ensureSubscribed(), so a refused write never so much as boots
       * the key. Silence rather than a reply, for the same reason as any other
       * write this bridge cannot act on: the vendor protocol has no error
       * report, so the host's own timeout is the faithful answer and the log is
       * where the refusal becomes visible.
       */
      if (isFirmwareUpdate(data)) {
        log('error', '[vendor] OKFWUPDATE refused - firmware update is not carried over Bluetooth');
        return;
      }

      if (isEdgeRequest(data)) {
        keepForApp(data, address, sealed);
        return;
      }

      const transport = await ensureSubscribed();
      /*
       * RULE 8 (Brad, 2026-10-06): a Hold or Revoke the person tapped is waiting
       * at the front of the key's lane (lib lane.js, urgent). This request is the
       * boundary - the computer has its last answer, or it would not be asking
       * again: its hold ends here, the Hold runs, and this request waits behind
       * it (and the key refuses it, if it was the budget's next use).
       */
      if (held && typeof transport.urgentWaiting === 'function' && transport.urgentWaiting()) releaseHold(' (a Hold or Revoke went first)');
      /* the computer's turn on the key: after any app conversation in flight, then held (holdForComputer) */
      await holdForComputer(transport);
      armRelease();
      log('rx', `[vendor] ${data.length} bytes -> the key`);
      /* R13b: an Edge ARM on its way to the key - its 16 intent bytes, for the press prompt */
      if (data.length >= 54 && data[0] === 0xff && data[1] === 0xff && data[2] === 0xff && data[3] === 0xff && data[4] === 0xf8 && data[5] === 0x22) armedIntent(data.slice(38, 54));
      /* Before the write: a fast key answers before write() resolves. */
      owner = address;
      lastHostActivity = Date.now();
      ours.push(data);
      if (ours.length > 8) ours.shift();
      await transport.write(IFACE_VENDOR, data);
    } catch (err) {
      /*
       * Nothing is sent back. There is no error report in the vendor protocol -
       * a real key that cannot act on a write simply does not answer - so the
       * faithful thing is silence and the host's own timeout. The log is where
       * this becomes visible.
       */
      log('error', `[vendor] write failed: ${String(err)}`);
    }
  }

  function keepForApp(data: Uint8Array, from: string, sealed = false) {
    const asm = gathering.get(from) ?? edgeWire.createAssembler();
    gathering.set(from, asm);
    allSealed.set(from, (allSealed.get(from) ?? true) && sealed);
    const fp = firstPiece.get(from) ?? {at: Date.now(), pieces: 0};
    fp.pieces += 1;
    firstPiece.set(from, fp);
    const got = asm.push(data);
    if (!got) return;
    firstPiece.delete(from);
    const wasSealed = allSealed.get(from) === true;
    allSealed.delete(from);
    if ('error' in got) {
      log('info', `[edge] a request from ${from} came in broken (${got.error}); dropped`);
      return;
    }
    if (got.kind !== edgeWire.KIND.REQUEST) return;
    /*
     * PING-PONG (Brad, 2026-10-06): a pure Bluetooth link test - the same id
     * and data straight back, nothing else done. TESTING MODE ONLY, and only
     * inside the encrypted session: otherwise silence, like anything unknown.
     */
    const pingAllowed = wasSealed && (testingModeOn() || PING_IN_PRODUCTION);
    const msgType = (got.message as {type?: unknown} | null)?.type;
    if (msgType === edgePing.RECEIPT_TYPE) {
      /* the computer's verdict on a ping (one-way, nothing goes back) */
      const r = got.message as {re?: string; exact?: boolean; why?: string | null; ms?: number};
      if (pingAllowed && typeof r.re === 'string') {
        const t = waitingVerdict.get(r.re);
        if (t) clearTimeout(t);
        waitingVerdict.delete(r.re);
        console.log(`[edge] ping ${r.re.slice(0, 8)}: ${r.exact ? 'exact' : `FAILED (${r.why ?? '?'})`}, round trip ${r.ms} ms on the computer`);
      }
      return;
    }
    if (msgType === edgePing.PING_TYPE) {
      const rxAt = Date.now();
      const pong = pingAllowed ? edgePing.answerPing(got.message, {firstAt: fp.at, rxAt}) : null;
      if (pong) {
        /* times and counts only: how long the ping took to arrive, and its echo to go out */
        const frames = edgeWire.encode(edgeWire.KIND.ANSWER, edgeWire.answerEnvelope(got.message, pong, {dev: myDev}));
        const t0 = Date.now();
        console.log(`[edge] ping in: ${fp.pieces} pieces in ${t0 - fp.at} ms`);
        for (const frame of frames) push(frame, from);
        void sending.then(() => console.log(`[edge] pong out: ${frames.length} reports in ${Date.now() - t0} ms`));
        /* the computer's receipt should follow; say so if it never does */
        const pid = pong.id;
        waitingVerdict.set(pid, setTimeout(() => {
          waitingVerdict.delete(pid);
          console.log(`[edge] ping ${pid.slice(0, 8)}: no verdict from the computer after 10 s`);
        }, 10000));
      }
      else log('info', `[edge] a ping from ${from} - no answer (${wasSealed ? 'not allowed in this build' : 'not encrypted'})`);
      return;
    }
    if (!onEdgeRequest) return;
    log('rx', `[edge] a request from ${from} - kept for the app, not sent to the key`);
    void onEdgeRequest(got.message, from)
      .then(answer => {
        if (answer === null || answer === undefined) {
          log('info', '[edge] dropped without an answer (not registered, bad signature, or replayed)');
          return;
        }
        /* the gates again: the person may have turned API off, or changed target, while the sheet was up */
        if ((isApi && !isApi()) || (getTarget && !isFromTarget(from, getTarget()))) {
          log('info', '[edge] the answer was not sent - API off or another target now');
          return;
        }
        /* the envelope (Brad, 2026-10-06): this answer names the request it answers */
        for (const frame of edgeWire.encode(edgeWire.KIND.ANSWER, edgeWire.answerEnvelope(got.message, answer, {dev: myDev}))) push(frame, from);
      })
      .catch((err: unknown) => log('error', `[edge] the request failed: ${String(err)}`));
  }

  const off = FidoGatt.on('request', onRequest);
  transit.setSender(sendFrame);
  transit.setLog(log);
  void transit.load().catch((err: unknown) => log('error', `[bt] the pairing store did not load: ${String(err)}`));

  return () => {
    off();
    transit.releaseSender(sendFrame); /* only if still ours: another bridge may have taken over */
    transit.releaseLog(log);
    transit.endSessions();
    if (offReport) offReport();
    if (offWrite) offWrite();
    offReport = null;
    offWrite = null;
    owner = null;
    boundTo = null;
    releaseHold(' (the bridge stopped)');
    for (const t of waitingVerdict.values()) clearTimeout(t);
    waitingVerdict.clear();
  };
}
