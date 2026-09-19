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
