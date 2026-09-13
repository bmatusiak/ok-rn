import React, {createContext, useContext} from 'react';

import {useBtKeyboard, type BtKeyboard} from './useBtKeyboard';

/**
 * THE BLUETOOTH KEYBOARD OUTLIVES ITS SCREEN.
 *
 * `useBtKeyboard` holds the forwarder: a subscription to the active key's
 * IFACE.KEYBOARD frames that turns each one into a HID report over Bluetooth.
 * It was called from BtKeyboardScreen alone, so that subscription existed only
 * while that screen was on top of the stack.
 *
 * Which made the obvious thing impossible. Registering, connecting to a host
 * and arming typing all happen on the Bluetooth screen - and then you go
 * somewhere else to actually press a button, because the buttons are on This
 * Key and the slots are on Slots. Leaving the screen took the forwarder with
 * it, so every keystroke after that went nowhere. Measured: connected to a
 * Windows host, pressed a soft-key button from This Key, nothing arrived.
 *
 * Nothing else about it was screen-scoped. `register()` and `unregister()` are
 * explicit actions on the native module and survive navigation; so does the
 * connection. The listener was the one piece whose lifetime was wrong, and it
 * was the piece that carried the characters.
 *
 * Hoisted to the app so it lives as long as the app does. The screen reads the
 * same instance through this context, so what it shows - state, host, sent
 * count - is the state of the bridge that is actually running, not a second
 * copy of it.
 *
 * Mounting it app-wide costs one `localName()` call, one `isSupported()` call
 * and a status subscription. It does not register, does not ask for
 * permissions, and does not turn typing on: `typing` still has to be armed
 * deliberately, and still disarms itself when the host goes away.
 */
const BtKeyboardContext = createContext<BtKeyboard | null>(null);

export function BtKeyboardProvider({children}: {children: React.ReactNode}) {
  const bt = useBtKeyboard();
  return (
    <BtKeyboardContext.Provider value={bt}>
      {children}
    </BtKeyboardContext.Provider>
  );
}

/**
 * The one bridge, for a screen that drives or describes it.
 *
 * Throws rather than falling back to its own `useBtKeyboard()`: a second
 * instance would forward the same reports twice and report a `sent` count that
 * is not the one on screen, which is exactly the class of bug this replaced.
 */
export function useSharedBtKeyboard(): BtKeyboard {
  const bt = useContext(BtKeyboardContext);
  if (!bt) {
    throw new Error('useSharedBtKeyboard used outside BtKeyboardProvider');
  }
  return bt;
}
