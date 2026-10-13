/**
 * ONE SWAP, END TO END (GUEST-BOOK-SPEC.md, the QR + Bluetooth key swap; Brad, 2026-10-12): the
 * Bluetooth link (specs/NativeContactLink.ts) carrying the lib's handshake
 * (node-onlykey-lib guestbook/src/swap.js), framed (guestbook/src/frames.js), with this phone's
 * OnlyKey doing the one private step.
 *
 * The two roles run the same code:
 *   host   shows the invite QR and waits; the other phone connects and opens.
 *   join   scanned the QR; connects, opens, checks the key the QR named.
 * Both end on the same "linked" view, then each sends the keys the person picked (once) and
 * receives the other's. The sheet (ExchangeSheet) only draws `view`; nothing here is UI.
 *
 * Everything is passed in (the link, the OnlyKey, randomness) so a test can run two phones
 * against each other in one process - the swap's whole path, minus the radio.
 */
const {invite: inv, swap, frames} = require('node-onlykey-lib/guestbook');
const {toHex, fromHex} = require('node-onlykey-lib').bytes;

/* The contact identity: the derived X-Wing key under this label on the person's own OnlyKey. */
export const CONTACT_LABEL = 'okrn-contact:v1';

export type Link = {
  host(linkHex: string): Promise<void>;
  join(linkHex: string, timeoutMs: number): Promise<number>;
  send(hex: string): Promise<void>;
  close(): Promise<void>;
  /** subscribe to {type: 'connected'|'data'|'closed', hex, mtu, message}; returns unsubscribe */
  listen(fn: (e: {type: string; hex: string; mtu: number; message: string}) => void): () => void;
};

export type Card = {name: string; keys: {format: string; label: string; text: string}[]};

export type SwapView =
  | {step: 'waiting'; url: string}
  | {step: 'connecting'}
  | {step: 'press'; digits: number[] | null}
  /*
   * link: 'open' while cards can still cross; 'done' both crossed and the link was ended with a
   * goodbye; 'left' they closed without giving keys; 'dropped' the radio went with no goodbye.
   * Only 'open' can still bring their keys - the sheet stops promising them otherwise.
   */
  /* receiving: how much of their card has arrived, while a large one is on its way (null otherwise) */
  | {step: 'linked'; peerId: string; sent: boolean; received: Card | null; receiving: {have: number; want: number} | null; sending: {have: number; want: number} | null; link: 'open' | 'done' | 'left' | 'dropped'}
  | {step: 'failed'; message: string};

export type Deps = {
  link: Link;
  /** this phone's OnlyKey: its contact key, and opening a seal sent to it (the press) */
  identity: () => Promise<{publicKey: Uint8Array; decapsulate: (ct: Uint8Array, onDigits: (d: number[]) => void) => Promise<Uint8Array>}>;
  randomBytes: (n: number) => Uint8Array;
  onView: (v: SwapView) => void;
  joinTimeoutMs?: number;
  /** the clock (tests move it): the rotating QR and the token check read it */
  now?: () => number;
};

/** A short readable form of the other phone's contact id, to say who you are linked with. */
/*
 * ONE WRITE CARRIES AT MOST 512 BYTES, whatever the MTU says: Android's stack caps an attribute
 * value at 512 (GATT_MAX_ATTR_LEN). On a 517 link the Pixel sent 514 and the A13 refused it -
 * "data to indicate is too long 514" - and the swap sat there (2026-10-12).
 */
const fragmentSize = (mtu: number) => Math.max(20, Math.min(512, mtu));

export const shortId = (id: Uint8Array) => toHex(id).slice(0, 16).toUpperCase().replace(/(.{4})(?=.)/g, '$1 ');

export function createSwap(deps: Deps) {
  const asm = frames.createAssembler();
  let size = 20;
  let state: any = null;
  let session: any = null;
  let unlisten: (() => void) | null = null;
  let ended = false;
  const clock = deps.now ?? (() => Date.now());
  let rotate: ReturnType<typeof setTimeout> | null = null;
  /* the radio is closed but the sheet still shows what crossed (saving needs no link) */
  let linkClosed = false;
  let view: SwapView = {step: 'connecting'};
  const show = (v: SwapView) => {
    view = v;
    if (!ended || v.step === 'failed') deps.onView(v);
  };

  /* one message out: fragments one after another, each acknowledged before the next */
  const sendMsg = async (msg: Uint8Array, onProgress?: (have: number, want: number) => void) => {
    let have = 0;
    for (const f of frames.fragment(msg, size)) {
      await deps.link.send(toHex(f));
      have += f.length;
      onProgress?.(have, msg.length);
    }
  };

  const fail = (e: unknown) => {
    if (ended) return;
    const message = String((e as any)?.message ?? e);
    ended = true;
    show({step: 'failed', message});
    void deps.link.close();
    unlisten?.();
  };

  /* the device, wrapped so the sheet can say "press" while it waits */
  const identityFor = async () => {
    const id = await deps.identity();
    return {
      publicKey: id.publicKey,
      decapsulate: async (ct: Uint8Array) => {
        show({step: 'press', digits: null});
        return id.decapsulate(ct, digits => show({step: 'press', digits}));
      },
    };
  };

  let onMessage: (msg: Uint8Array) => Promise<void> = async () => {};
  const linked = (peer: {id: Uint8Array}) => show({step: 'linked', peerId: shortId(peer.id), sent: false, received: null, receiving: null, sending: null, link: 'open'});

  /*
   * NO LINK LONGER THAN IT IS USED (Brad, 2026-10-12: "there is no reason to keep a link open if
   * nothing will be send"). The radio ends here; the sheet stays to read and save what came.
   */
  const closeLink = (why: 'done' | 'left' | 'dropped') => {
    if (linkClosed) return;
    linkClosed = true;
    unlisten?.();
    void deps.link.close().catch(() => {});
    if (view.step === 'linked') show({...view, link: why});
  };
  /* this phone has sent and received: say goodbye ("done") and end the link */
  const finishIfDone = async () => {
    if (view.step !== 'linked' || !view.sent || !view.received || linkClosed) return;
    await sendMsg(swap.sealBye(session, 'done')).catch(() => {});
    closeLink('done');
  };
  const onSealed = async (msg: Uint8Array) => {
    const m = swap.openMessage(session, msg);
    if (view.step !== 'linked') return;
    if (m.kind === 'card') {
      show({...view, received: m.card, receiving: null});
      return finishIfDone();
    }
    /* their goodbye: "done" - both cards crossed; "leaving" - they closed, nothing more will come */
    closeLink(m.reason === 'done' ? 'done' : 'left');
  };

  /*
   * THEIR CARD COMING IN (Brad, 2026-10-13: "can we add progress bar for recieving a key? the data
   * is sent in chunks because its key is large in size"). Only for a card big enough to take a
   * while (a +PQC certificate is ~15 KB), and in 10% steps - a screen redrawn on every chunk would
   * never give the UI tools a quiet moment.
   */
  let lastTenth = -1;
  const reportProgress = () => {
    const p = asm.progress();
    if (!p || p.want < 4096 || view.step !== 'linked') return;
    const tenth = Math.floor((p.have * 10) / p.want);
    if (tenth === lastTenth) return;
    lastTenth = tenth;
    show({...view, receiving: p});
  };

  const listen = () => {
    unlisten = deps.link.listen(e => {
      if (ended) return;
      if (e.type === 'closed') {
        /* once linked, a radio that goes without a goodbye ends the link, not the sheet */
        if (view.step === 'linked') return closeLink('dropped');
        return fail(new Error(e.message || 'the other phone left'));
      }
      if (e.type === 'connected') {
        size = fragmentSize((e.mtu || 23) - 3);
        return;
      }
      if (e.type !== 'data') return;
      let msg: Uint8Array | null;
      try {
        msg = asm.push(fromHex(e.hex));
      } catch (err) {
        return fail(err);
      }
      if (msg) return void onMessage(msg).catch(fail);
      reportProgress();
    });
  };

  return {
    get view() {
      return view;
    },

    /** Show the invite QR and wait for the other phone. */
    async host() {
      try {
        listen();
        const identity = await identityFor();
        /* a rotating invite: the QR's token turns over every 30 s (invite.js), so a photo of it goes stale */
        const made = inv.makeRotatingInvite({publicKey: identity.publicKey, randomBytes: deps.randomBytes});
        state = swap.showerStart({identity, invite: made, randomBytes: deps.randomBytes});
        onMessage = async msg => {
          if (!state) return onSealed(msg);
          if (state.step === 'open') {
            const r = swap.showerOnOpen(state, msg);
            state = r.state;
            return sendMsg(r.msg);
          }
          if (state.step === 'reveal') {
            const r = await swap.showerOnReveal(state, msg, clock());
            state = r.state;
            return sendMsg(r.msg);
          }
          const done = swap.showerOnConfirm(state, msg);
          state = null;
          session = done.session;
          linked(done.peer);
        };
        await deps.link.host(toHex(made.link));
        /* redraw the QR as its token turns over, for as long as it is waiting to be scanned */
        const redraw = () => {
          if (ended || (view.step !== 'waiting' && view.step !== 'connecting')) return;
          const at = inv.inviteUrlAt(made, clock());
          show({step: 'waiting', url: at.url});
          rotate = setTimeout(redraw, Math.max(250, at.nextAt - clock()));
        };
        redraw();
      } catch (e) {
        fail(e);
      }
    },

    /** The other phone's invite (a QR's text or an okrn:// link): connect and open. */
    async join(inviteText: string) {
      try {
        const invite = inv.readInvite(inviteText);
        show({step: 'connecting'});
        listen();
        const identity = await identityFor();
        const start = swap.scannerStart({identity, invite, randomBytes: deps.randomBytes});
        state = start.state;
        onMessage = async msg => {
          if (!state) return onSealed(msg);
          if (state.step === 'keys') {
            const r = swap.scannerOnKeys(state, msg);
            state = r.state;
            return sendMsg(r.msg);
          }
          const done = await swap.scannerOnDone(state, msg);
          state = null;
          session = done.session;
          await sendMsg(done.msg);
          linked(done.peer);
        };
        size = fragmentSize(await deps.link.join(toHex(invite.link), deps.joinTimeoutMs ?? 30000));
        await sendMsg(start.msg);
      } catch (e) {
        fail(e);
      }
    },

    /** Send the keys the person picked - once. */
    async send(card: Card) {
      if (view.step !== 'linked' || view.sent || !session || linkClosed) return;
      try {
        /*
         * YOUR CARD GOING OUT (Brad, 2026-10-13: "i also want progress bar for sending"): the bytes
         * the other phone has acknowledged, for a card big enough to take a while, in 10% steps.
         */
        let sentTenth = -1;
        await sendMsg(swap.sealCard(session, card), (have, want) => {
          if (want < 4096 || view.step !== 'linked') return;
          const tenth = Math.floor((have * 10) / want);
          if (tenth === sentTenth) return;
          sentTenth = tenth;
          show({...view, sending: {have: Math.min(have, want), want}});
        });
        if (view.step === 'linked') show({...view, sent: true, sending: null});
        await finishIfDone();
      } catch (e) {
        fail(e);
      }
    },

    /** Close: nothing is kept, the link and its advertising stop; a link still open gets a goodbye first. */
    async close() {
      if (rotate) clearTimeout(rotate);
      if (session && !linkClosed && view.step === 'linked') {
        /* "leaving": the other phone stops waiting for keys that will never come - but never hang a close on it */
        await Promise.race([sendMsg(swap.sealBye(session, 'leaving')), new Promise<void>(r => setTimeout(r, 2000))]).catch(() => {});
      }
      ended = true;
      linkClosed = true;
      unlisten?.();
      await deps.link.close().catch(() => {});
    },
  };
}
