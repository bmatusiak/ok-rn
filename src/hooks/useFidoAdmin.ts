/**
 * One CTAPHID channel for the active key, and a FidoAdmin on top of it.
 *
 * ## Why a hook owns this instead of the screen
 *
 * Two reasons, and both are firmware facts rather than tidiness.
 *
 * THE CHANNEL IS SCARCE. CTAPHID_INIT allocates a channel record, the
 * firmware keeps ten, and it frees none (ctaphid.cpp:67). A screen that
 * opened one per operation would exhaust them and then be handed a channel
 * somebody else is using.
 *
 * THE KEY MUST BE UNLOCKED FIRST. FIDO dispatch is gated on
 * `unlocked == true` (okcore.cpp:639,651) and a locked device drops those
 * packets with no answer at all - so an INIT against a locked key times out.
 * Worse, doing exactly that once left the bench key's VENDOR interface
 * refusing writes until it was physically replugged
 * (FINDING-a-ctaphid-channel-on-a-locked-key-wedged-it.md). The causal link
 * is not established, but "do not do the thing that preceded a wedged key"
 * costs nothing, and a person opening a tab must not be able to cause it.
 *
 * So: this refuses to open a channel unless the key says it is unlocked, and
 * it says why rather than producing a timeout.
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import {protocol, device as deviceLib} from 'node-onlykey-lib';
import {useActiveKey} from './KeyContext';

const {CtapHid} = protocol.ctaphid;
const {FidoAdmin} = deviceLib.fido;

export type FidoAdminState = {
  /** Ready to talk, or null with a reason in `blocked`. */
  fido: any | null;
  /** Why there is no channel, in words a person can act on. */
  blocked: string | null;
  busy: boolean;
  /** Open the channel. Safe to call again; it keeps the one it has. */
  open: () => Promise<any | null>;
  /** Forget the channel, e.g. when the key goes away. */
  close: () => void;
};

export function useFidoAdmin(unlocked: boolean): FidoAdminState {
  const getKey = useActiveKey();
  const [fido, setFido] = useState<any | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /*
   * Held in a ref as well as state: `open` must be able to see whether a
   * channel already exists without listing `fido` as a dependency, which
   * would rebuild the callback every time one is opened.
   */
  const held = useRef<any | null>(null);

  const close = useCallback(() => {
    held.current = null;
    setFido(null);
  }, []);

  /* A key that locks, or is swapped, invalidates the channel it granted. */
  useEffect(() => {
    if (!unlocked) close();
  }, [unlocked, close]);
  useEffect(() => close, [getKey, close]);

  const open = useCallback(async () => {
    if (held.current) return held.current;

    if (!unlocked) {
      setBlocked(
        'Unlock the key first. A locked key drops security-key packets without ' +
        'answering, so this would simply wait, and asking anyway is what ' +
        'preceded a key that had to be unplugged to recover.',
      );
      return null;
    }

    setBusy(true);
    setBlocked(null);
    try {
      const {transport} = await getKey();
      const ctap = new CtapHid(transport);
      await ctap.init({timeoutMs: 8000});
      const admin = new FidoAdmin(ctap);
      held.current = admin;
      setFido(admin);
      return admin;
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      setBlocked(
        /no CTAPHID reply/i.test(message)
          ? `The key did not answer on its security-key interface: ${message}`
          : message,
      );
      return null;
    } finally {
      setBusy(false);
    }
  }, [getKey, unlocked]);

  return {fido, blocked, busy, open, close};
}
