/*
 * The two sentences a grayed panel says, and the only two.
 *
 * Config mode splits the app in half. Writing to the key needs it; using the
 * key is refused during it - the firmware answers eleven message types in
 * config mode and silently drops the rest (okcore.cpp:347), which puts
 * OKSETPRIV, OKRESTORE and the wipes on one side and OKSIGN, OKDECRYPT and the
 * whole of CTAPHID on the other.
 *
 * So a panel is grayed for one of exactly two reasons, and they are opposites.
 * Both are visible at once on the Backup tab - capture needs config mode OFF,
 * the two panels under it need it ON - which is why each says which it is
 * rather than just dimming.
 *
 * Constants because fifteen panels share them. The wording drifting between
 * screens is a smaller problem than it sounds until you are the one reading
 * two different explanations of the same state on one screen.
 */

/** Grayed because config mode is OFF and this writes to the key. */
export const NEEDS_CONFIG_MODE = 'Needs config mode';

/** Grayed because config mode is ON and the firmware refuses this in it. */
export const NOT_IN_CONFIG_MODE = 'Not while in config mode';

/*
 * THE FOUR STATES, and why it is not a boolean.
 *
 * Getting into config mode is not one event. The key has to be held, it locks
 * itself on the way in, the PIN has to go back in, and the unlock that follows
 * is never announced - so the app passes through three distinguishable waits
 * before it can honestly say a key is in config mode.
 *
 *   -1 WANTED  the hold was asked for; watching for the lock
 *    0 OFF
 *    1 PRE     the key locked. This IS the app's locked view: the PIN screen,
 *              with "Check config mode" beside the pad.
 *    2 ON      the check came back
 *
 * A boolean forced every one of those waits to be guessed at, and the guesses
 * are what went wrong - a button that set the flag on the tap, over a key that
 * had never been touched. Each transition now has one cause and one writer.
 */
export type ConfigState = -1 | 0 | 1 | 2;

/** The hold was asked for. Nothing is true about the key yet. */
export const WANTED: ConfigState = -1;
/** The ordinary state. */
export const OFF: ConfigState = 0;
/** The key locked: the PIN view, where the check button lives. */
export const PRE: ConfigState = 1;
/** Confirmed. The only state that changes what a panel offers. */
export const ON: ConfigState = 2;
