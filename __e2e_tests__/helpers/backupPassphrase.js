/**
 * The soft key's backup passphrase, in one place.
 *
 * Three callers need the same string and must not disagree about it: the
 * passphrase never reaches the device - only SHA-256 of its latin1 bytes,
 * written to slot 131 - so two callers with different strings produce two
 * different backup keys and a backup that cannot be restored, with nothing
 * said at the time.
 *
 *   0-provision          sets it on a FRESH device, where it is free
 *   8b-backup            sets it when the device says it has none
 *   8c-backupPassphrase  sets it on demand
 *
 * ## Written down on purpose
 *
 * A backup whose passphrase is lost cannot be restored, and this is an
 * emulated key whose flash lives in the app's own files directory. It is a
 * test fixture, not a secret. Chosen by the bench owner on 2026-09-23; the
 * host-side minimum is 25 characters (BACKUP_PASSPHRASE_MIN), and this is 42.
 *
 * ## CONFIG MODE, EXCEPT ON A FRESH DEVICE
 *
 * OKSETPRIV is accepted when `configmode == true || !initcheck`
 * (okcore.cpp:452). The second half is the useful one: a device that has just
 * been given its PIN has not rebooted yet - `initialized` is recomputed from
 * flash only in setup() - so it is still in first-use state and takes the
 * write with NO config mode and therefore no cost to CTAPHID.
 *
 * That matters because config mode silences CTAPHID until a restart, so a
 * suite that entered it mid-sweep would break every derive suite behind it.
 * Setting the passphrase during provisioning avoids the question entirely.
 */
'use strict';

/** Six repetitions of "onlykey" - 42 characters. */
const BACKUP_PASSPHRASE = 'onlykey'.repeat(6);

/**
 * Write it, and return what the device said.
 *
 * AWAITED by the library, which matters here: OKSETPRIV outside config mode
 * on an initialised device is dropped with nothing said, so a write that is
 * not awaited reports success for a passphrase the device never took. The
 * acknowledgement - "Successfully set Backup Passphrase" - is the only
 * evidence available, because nothing in the protocol reads a backup key back.
 */
async function writeBackupPassphrase(device, log) {
  log(`setting the ${BACKUP_PASSPHRASE.length}-character backup passphrase`);
  const said = await device.setBackupPassphrase(BACKUP_PASSPHRASE);
  const text = typeof said === 'string' ? said : (said && said.response) || '';
  log(`device said: ${text || JSON.stringify(said)}`);
  return String(text);
}

/** Whether the device acknowledged the write, by name. */
function acknowledged(text) {
  return /Successfully set Backup Passphrase/i.test(String(text));
}

module.exports = {BACKUP_PASSPHRASE, writeBackupPassphrase, acknowledged};
