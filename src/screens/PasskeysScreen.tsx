/**
 * The passkeys a key is carrying: see them, remove one, and the reset.
 *
 * A resident credential went on to the key during a WebAuthn ceremony in
 * somebody's browser and was thereafter invisible. Nothing could say how many
 * there were, which sites they belonged to, or take one off. This is the
 * first screen that can.
 *
 * ## Everything here is bounded by the eight-attempt counter
 *
 * The key allows EIGHT wrong PINs in its lifetime before the FIDO2 side locks
 * PERMANENTLY (PIN_LOCKOUT_ATTEMPTS, ctap.h:170), and three per boot. Nothing
 * restores the lifetime count except a correct PIN, or a reset that destroys
 * every credential on the key. So this screen:
 *
 *   shows the remaining count BEFORE anything is typed, because that is the
 *   number a person needs in order to decide whether to guess;
 *
 *   refuses to spend the last attempt unless the user says so explicitly;
 *
 *   never retries a PIN on its own, and never offers to.
 *
 * A wrong pinAuth on a LISTING costs an attempt too (ctap.cpp:1609-1616) -
 * this is not only about the PIN box.
 *
 * ## Deleting is the part with consequences
 *
 * Removing a credential means the account it belongs to stops recognising
 * this key, and where it was the only second factor that account may be
 * unreachable. So the confirmation names the SITE and the USER, because those
 * are what the person is about to lose, and the descriptor sent is the one
 * from a listing taken immediately before - the enumeration cursors are
 * firmware statics shared by every channel, so anything remembered can point
 * somewhere else by the time it is used.
 */
import React, {useCallback, useState} from 'react';
import {ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {Btn, Section} from '../ui/components';
import {theme} from '../ui/theme';
import {protocol, device as deviceLib} from 'node-onlykey-lib';
import {useFidoAdmin} from '../hooks/useFidoAdmin';
import {useKeyName} from '../hooks/KeyContext';
import type {EmuSession} from '../hooks/useOkEmu';

const {credmgmt} = protocol;
const {RESET_CONFIRMATION, INFO} = deviceLib.fido;

/** Below this, the screen stops offering to spend an attempt on its own. */
const SAFE_FLOOR = 2;

type Site = {
  id: string;
  name: string;
  credentials: any[];
};

/** getInfo, as lines a person can read. Hex for the AAGUID, which is bytes. */
function describeInfo(info: Map<number, any>): {label: string; value: string}[] {
  const hex = (b: Uint8Array) =>
    Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
  const options = info.get(INFO.OPTIONS);
  const out: {label: string; value: string}[] = [];

  const versions = info.get(INFO.VERSIONS);
  if (Array.isArray(versions)) out.push({label: 'Versions', value: versions.join(', ')});

  const extensions = info.get(INFO.EXTENSIONS);
  if (Array.isArray(extensions) && extensions.length) {
    out.push({label: 'Extensions', value: extensions.join(', ')});
  }

  const aaguid = info.get(INFO.AAGUID);
  if (aaguid) out.push({label: 'AAGUID', value: hex(aaguid)});

  if (options instanceof Map) {
    for (const [name, value] of options) {
      out.push({label: name, value: value === true ? 'yes' : value === false ? 'no' : String(value)});
    }
  }

  const max = info.get(INFO.MAX_MSG_SIZE);
  if (max !== undefined) out.push({label: 'Max message', value: `${max} bytes`});

  const protocols = info.get(INFO.PIN_PROTOCOLS);
  if (Array.isArray(protocols)) {
    out.push({label: 'PIN protocols', value: protocols.join(', ')});
  }
  return out;
}

export function PasskeysScreen({emu}: {emu: EmuSession}) {
  const keyName = useKeyName();
  const unlocked = emu.device === 'unlocked';
  const {fido, blocked, busy: opening, open} = useFidoAdmin(unlocked);

  const [pin, setPin] = useState('');
  const [token, setToken] = useState<Uint8Array | null>(null);
  const [retries, setRetries] = useState<number | null>(null);
  const [pinSet, setPinSet] = useState<boolean | null>(null);
  const [sites, setSites] = useState<Site[] | null>(null);
  const [counts, setCounts] = useState<{stored: number; remaining: number} | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [info, setInfo] = useState<Map<number, any> | null>(null);
  const [resetWord, setResetWord] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setError(null);
    setStatus(null);
  };

  /** Open the channel and read the two things that cost nothing. */
  const connect = useCallback(async () => {
    reset();
    setBusy('connect');
    try {
      const admin = await open();
      if (!admin) return;
      const state = await admin.pinState({timeoutMs: 10000});
      setPinSet(state.set);
      /*
       * pinState already fetched getInfo to read the clientPin option, so the
       * whole map comes back with it - showing it costs nothing extra.
       */
      setInfo(state.info ?? null);
      /*
       * getRetries takes no PIN, needs no touch and moves no counter. It is
       * the cheapest true thing this screen can say, so it is said first and
       * without being asked.
       */
      setRetries(await admin.getRetries({timeoutMs: 10000}));
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [open]);

  /** Exchange the PIN for a token. THIS IS THE CALL THAT CAN COST AN ATTEMPT. */
  const unlockFido = useCallback(async () => {
    reset();
    setBusy('pin');
    try {
      if (!fido) throw new Error('no security-key channel; connect first');
      const token_ = await fido.getPinToken(pin, {
        timeoutMs: 10000,
        /*
         * Only when the person has been shown the count and asked again.
         * FidoAdmin refuses the last attempt without this, which is the
         * behaviour worth keeping - a screen that passed it always would be
         * a screen that spent the last life quietly.
         */
        allowLastAttempt: retries !== null && retries <= SAFE_FLOOR,
      });
      setToken(token_);
      setPin('');
      setRetries(await fido.getRetries({timeoutMs: 10000}));
      setStatus('The key accepted the PIN.');
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      setError(message);
      try {
        if (fido) setRetries(await fido.getRetries({timeoutMs: 10000}));
      } catch { /* the count is a nicety; the error above is not */ }
    } finally {
      setBusy(null);
    }
  }, [fido, pin, retries]);

  /**
   * Set a PIN on a key that has none.
   *
   * NO ATTEMPT IS AT RISK HERE. There is no current PIN to be wrong about,
   * and the firmware refuses a second setPin outright (CTAP2_ERR_NOT_ALLOWED,
   * ctap.cpp:2255) rather than treating it as a guess.
   *
   * What IS at risk is the rest of the key's FIDO2 life: from here on, eight
   * wrong entries of whatever is typed below lock it permanently. Hence the
   * confirm field - a typo that becomes the PIN is a key nobody can
   * authenticate to, and only a reset that destroys every passkey clears it.
   */
  const setNewPinOnKey = useCallback(async () => {
    reset();
    if (newPin !== confirmPin) {
      setError('The two PINs do not match.');
      return;
    }
    setBusy('setPin');
    try {
      if (!fido) throw new Error('no security-key channel; connect first');
      await fido.setPin(newPin, {timeoutMs: 10000});
      setPinSet(true);
      setNewPin('');
      setConfirmPin('');
      setStatus('The key now has a security-key PIN. Use it below.');
      setRetries(await fido.getRetries({timeoutMs: 10000}));
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [fido, newPin, confirmPin]);

  /**
   * Change the PIN, proving the current one. THIS SPENDS AN ATTEMPT IF WRONG.
   *
   * Unlike setPin, the device verifies the current PIN, so a mistyped one is
   * a guess and costs one of the eight. The remaining count is beside the
   * field and the last one is refused unless the person has been told.
   */
  const changeThePin = useCallback(async () => {
    reset();
    if (newPin !== confirmPin) {
      setError('The two new PINs do not match.');
      return;
    }
    setBusy('changePin');
    try {
      if (!fido) throw new Error('no security-key channel; connect first');
      await fido.changePin(pin, newPin, {
        timeoutMs: 10000,
        allowLastAttempt: retries !== null && retries <= SAFE_FLOOR,
      });
      setPin('');
      setNewPin('');
      setConfirmPin('');
      /* The old token was minted under the old PIN; it is no longer any use. */
      setToken(null);
      setSites(null);
      setStatus('The PIN was changed. Use the new one below.');
      setRetries(await fido.getRetries({timeoutMs: 10000}));
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      try {
        if (fido) setRetries(await fido.getRetries({timeoutMs: 10000}));
      } catch { /* the count is a nicety; the error above is not */ }
    } finally {
      setBusy(null);
    }
  }, [fido, pin, newPin, confirmPin, retries]);

  const refresh = useCallback(async () => {
    reset();
    setBusy('list');
    try {
      if (!fido || !token) throw new Error('the PIN is needed before listing');
      setCounts(await fido.credentialCount(token, {timeoutMs: 10000}));
      setSites(await fido.listCredentials(token, {timeoutMs: 20000}));
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [fido, token]);

  const remove = useCallback(async (credential: any, siteId: string) => {
    reset();
    setBusy('delete');
    try {
      if (!fido || !token) throw new Error('the PIN is needed before deleting');
      /*
       * The descriptor goes back exactly as it arrived. Rebuilding it, or
       * holding an index, is how a client deletes something the person was
       * not looking at.
       */
      await fido.deleteCredential(token, credential.credentialId, {timeoutMs: 10000});
      setStatus(`Removed the passkey for ${siteId}.`);
      setConfirmDelete(null);
      await refresh();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [fido, token, refresh]);

  const wipeFido = useCallback(async () => {
    reset();
    setBusy('reset');
    try {
      if (!fido) throw new Error('no security-key channel; connect first');
      await fido.reset(RESET_CONFIRMATION, {timeoutMs: 30000});
      setResetWord('');
      setToken(null);
      setSites(null);
      setCounts(null);
      setPinSet(false);
      setStatus(
        'The security-key side was reset. Every passkey is gone and the FIDO2 ' +
        'PIN is unset.',
      );
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [fido]);

  const working = busy !== null || opening;
  const canReset = resetWord.trim() === RESET_CONFIRMATION;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Section title={`Passkeys — ${keyName}`}>
        <Text style={styles.body}>
          The resident credentials this key carries: one per account that chose
          to keep its key on the device rather than on the site. The key holds
          twelve at most.
        </Text>

        {!unlocked ? (
          <Text style={styles.warn}>
            Unlock the key first. A locked key ignores security-key requests
            without answering them, so nothing here would report anything.
          </Text>
        ) : null}

        {blocked ? <Text style={styles.warn}>{blocked}</Text> : null}

        <Btn
          title={opening ? 'Connecting…' : fido ? 'Reconnect' : 'Connect'}
          tone="primary"
          disabled={working || !unlocked}
          onPress={connect}
        />

        {retries !== null ? (
          <Text style={retries <= SAFE_FLOOR ? styles.warn : styles.note}>
            {retries} PIN attempt{retries === 1 ? '' : 's'} left before the
            security-key side locks for good. A correct PIN puts it back to
            eight; nothing else does.
          </Text>
        ) : null}
        {pinSet === false ? (
          <Text style={styles.note}>
            This key has no security-key PIN set, so there is nothing to unlock
            and nothing to list.
          </Text>
        ) : null}
      </Section>

      {fido && pinSet ? (
        <Section title="Unlock with the PIN">
          <Text style={styles.note}>
            This is the security-key PIN, not the one that unlocks the key
            itself. They are different PINs and this one is far less forgiving.
          </Text>
          <TextInput
            style={styles.input}
            value={pin}
            onChangeText={setPin}
            placeholder="security-key PIN"
            placeholderTextColor={theme.textDim}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
          {retries !== null && retries <= SAFE_FLOOR ? (
            <Text style={styles.warn}>
              Only {retries} left. A wrong one now is most of what remains, and
              at zero every passkey on this key stops working for good.
            </Text>
          ) : null}
          <Btn
            title={busy === 'pin' ? 'Checking…' : 'Use this PIN'}
            tone="primary"
            disabled={working || pin.length < 4}
            onPress={unlockFido}
          />
        </Section>
      ) : null}

      {fido && pinSet === false ? (
        <Section title="Set a security-key PIN">
          <Text style={styles.body}>
            This key has none, so nothing can list or manage its passkeys.
            Setting one costs no attempts — there is no current PIN to be
            wrong about.
          </Text>
          <Text style={styles.warn}>
            Choose carefully. From here on, eight wrong entries lock the
            security-key side permanently, and the only way back is a reset
            that erases every passkey on the key.
          </Text>
          <TextInput
            style={styles.input}
            value={newPin}
            onChangeText={setNewPin}
            placeholder="new security-key PIN (4 characters or more)"
            placeholderTextColor={theme.textDim}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TextInput
            style={styles.input}
            value={confirmPin}
            onChangeText={setConfirmPin}
            placeholder="the same PIN again"
            placeholderTextColor={theme.textDim}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text style={styles.note}>
            Any text, 4 to 63 bytes — it is typed here and sent encrypted,
            never pressed on the key, so it is not limited to the six buttons
            the unlock PIN uses.
          </Text>
          <Btn
            title={busy === 'setPin' ? 'Setting…' : 'Set this PIN'}
            tone="primary"
            disabled={working || newPin.length < 4 || confirmPin.length < 4}
            onPress={setNewPinOnKey}
          />
        </Section>
      ) : null}

      {fido && pinSet ? (
        <Section title="Change the security-key PIN">
          <Text style={styles.note}>
            The current PIN is checked, so getting it wrong SPENDS ONE of the
            attempts above. The new one replaces it everywhere at once.
          </Text>
          <TextInput
            style={styles.input}
            value={pin}
            onChangeText={setPin}
            placeholder="current security-key PIN"
            placeholderTextColor={theme.textDim}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TextInput
            style={styles.input}
            value={newPin}
            onChangeText={setNewPin}
            placeholder="new PIN"
            placeholderTextColor={theme.textDim}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TextInput
            style={styles.input}
            value={confirmPin}
            onChangeText={setConfirmPin}
            placeholder="the new PIN again"
            placeholderTextColor={theme.textDim}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Btn
            title={busy === 'changePin' ? 'Changing…' : 'Change it'}
            disabled={working || pin.length < 4 || newPin.length < 4 || confirmPin.length < 4}
            onPress={changeThePin}
          />
        </Section>
      ) : null}

      {info ? (
        <Section title="What this authenticator says it is">
          <Text style={styles.note}>
            Straight from the key's own getInfo, which is the first thing any
            browser asks it. Read once when connecting; it costs nothing.
          </Text>
          {describeInfo(info).map(row => (
            <View key={row.label} style={styles.infoRow}>
              <Text style={styles.infoLabel}>{row.label}</Text>
              <Text style={styles.infoValue}>{row.value}</Text>
            </View>
          ))}
        </Section>
      ) : null}

      {token ? (
        <Section title="What is on the key">
          <Btn
            title={busy === 'list' ? 'Reading…' : 'List the passkeys'}
            tone="primary"
            disabled={working}
            onPress={refresh}
          />
          {counts ? (
            <Text style={styles.note}>
              {counts.stored} stored, room for {counts.remaining} more.
            </Text>
          ) : null}

          {sites && sites.length === 0 ? (
            <Text style={styles.note}>
              Nothing stored. That is an answer, not a failure — this key has
              never been asked to keep a passkey.
            </Text>
          ) : null}

          {(sites ?? []).map(site => (
            <View key={site.id} style={styles.site}>
              <Text style={styles.siteName}>{site.id}</Text>
              {site.credentials.map((c: any, i: number) => {
                const who = credmgmt.describeUser(c.user) || '(no user name)';
                const id = `${site.id}:${i}`;
                return (
                  <View key={id} style={styles.cred}>
                    <Text style={styles.who}>{who}</Text>
                    {confirmDelete === id ? (
                      <>
                        <Text style={styles.warn}>
                          Remove {who}’s passkey for {site.id}? That site stops
                          recognising this key. If it is the only second factor
                          on the account, you may not be able to get back in.
                        </Text>
                        <View style={styles.row}>
                          <Btn
                            title={busy === 'delete' ? 'Removing…' : 'Remove it'}
                            tone="danger"
                            disabled={working}
                            onPress={() => remove(c, site.id)}
                          />
                          <Btn title="Keep it" onPress={() => setConfirmDelete(null)} />
                        </View>
                      </>
                    ) : (
                      <Btn
                        title="Remove"
                        disabled={working}
                        onPress={() => setConfirmDelete(id)}
                      />
                    )}
                  </View>
                );
              })}
            </View>
          ))}
        </Section>
      ) : null}

      {fido ? (
        <Section title="Reset the security-key side">
          <Text style={styles.body}>
            This erases every passkey on the key and unsets the security-key
            PIN. Each account that trusted this key stops recognising it, and
            there is no undo and no backup of what was here.
          </Text>
          <Text style={styles.note}>
            The key asks for one button press and nothing else — no PIN, no
            delay. The typed word below is the only other thing in the way.
          </Text>
          <Text style={styles.label}>Type {RESET_CONFIRMATION} to enable it</Text>
          <TextInput
            style={styles.input}
            value={resetWord}
            onChangeText={setResetWord}
            placeholder={RESET_CONFIRMATION}
            placeholderTextColor={theme.textDim}
            autoCapitalize="characters"
            autoCorrect={false}
          />
          <Btn
            title={busy === 'reset' ? 'Resetting…' : 'Erase every passkey'}
            tone="danger"
            disabled={working || !canReset}
            onPress={wipeFido}
          />
        </Section>
      ) : null}

      {status ? <Text style={styles.status}>{status}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: theme.bg},
  content: {padding: 14, paddingBottom: 48},
  body: {color: theme.text, fontSize: theme.fontSize, lineHeight: theme.lineHeight},
  note: {color: theme.textDim, fontSize: 12, lineHeight: 18, marginTop: 8},
  warn: {color: theme.warn, fontSize: 12, lineHeight: 18, marginTop: 8},
  label: {color: theme.textDim, fontSize: 12, marginTop: 10},
  status: {color: theme.ok, fontSize: 13, lineHeight: 20, marginTop: 8},
  error: {color: theme.error, fontSize: 13, lineHeight: 20, marginTop: 8},
  input: {
    backgroundColor: theme.surfaceAlt,
    borderRadius: 8,
    color: theme.text,
    fontFamily: theme.mono,
    fontSize: 13,
    marginTop: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  infoRow: {flexDirection: 'row', justifyContent: 'space-between', marginTop: 6},
  infoLabel: {color: theme.textDim, fontSize: 12},
  infoValue: {color: theme.text, fontFamily: theme.mono, fontSize: 12},
  site: {marginTop: 12},
  siteName: {color: theme.text, fontSize: 14, fontWeight: '700'},
  cred: {marginTop: 8, paddingLeft: 10},
  who: {color: theme.textDim, fontSize: 13, marginBottom: 4},
  row: {flexDirection: 'row', gap: 8, marginTop: 6},
});
