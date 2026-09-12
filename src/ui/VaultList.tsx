import React, {useCallback, useEffect, useState} from 'react';
import {StyleSheet, Text, TextInput, View} from 'react-native';
import {Btn, Segmented} from './components';
import {theme} from './theme';
import {useActiveKey} from '../hooks/KeyContext';
import NativeSecrets from '../../specs/NativeSecrets';

/**
 * What is in the vault, and what can be done to it without opening anything.
 *
 * THE LIST NEVER TOUCHES THE DEVICE. `deviceVault.list()` is device-free by
 * design and the library says why: a screen showing twelve saved credentials
 * would otherwise ask for twelve button presses to draw itself. So this renders
 * on mount, and only "Copy secret" costs a touch.
 *
 * Modelled on the web app's vault pane (onlykey.github.io/src/plugins/vault),
 * the only reference that implements any of this. Rows are
 * `serviceId - policy - session active`, and the plaintext is NEVER DISPLAYED:
 * it leaves by clipboard or not at all. The footer is theirs too - lock every
 * session, export, import.
 */

/**
 * The policies the reference offers, in its order.
 *
 * Not the whole vocabulary - parsePolicy takes any `session:<n><m|h>` - but
 * four named choices are what a person can reason about, and matching the
 * reference means a vault configured on one client reads the same on the other.
 * node-onlykey-lib/test/vault.test.js pins that the two agree.
 */
const POLICIES = ['always', 'session:30m', 'session:8h', 'startup'] as const;

type Policy = (typeof POLICIES)[number];

/** How long a copied secret stays on the clipboard. CryptoScreen's figure. */
const CLIPBOARD_TTL_MS = 45000;

type Row = {
  serviceId: string;
  encrypted: string;
  policy?: string;
  active: boolean;
};

export function VaultList({
  onOpen,
  onError,
  onStatus,
  busy = false,
  reloadKey = 0,
}: {
  /**
   * Open one credential. Owned by the SCREEN, not by this list.
   *
   * Opening derives a key, deriving needs a touch, and raising the keypad is
   * the screen's job - it already does that for seal and open. Passing the work
   * up keeps one keypad rather than two that can both be on screen at once.
   */
  onOpen: (serviceId: string) => Promise<string | null>;
  onError: (message: string) => void;
  onStatus: (message: string) => void;
  busy?: boolean;
  /** Bump to re-read the list after the screen seals something new. */
  reloadKey?: number;
}) {
  /* The ACTIVE key, not whichever one this file used to assume. */
  const getKey = useActiveKey();

  const [rows, setRows] = useState<Row[] | null>(null);
  const [canPersist, setCanPersist] = useState(true);
  const [working, setWorking] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState('');
  /* Two taps to delete everything: the first arms, the second does it. */
  const [armedForgetAll, setArmedForgetAll] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const {okcrypto} = await getKey();
      const vault = okcrypto.deviceVault;

      /*
       * Asked rather than discovered by a failed save, which is what the
       * library's canPersist exists for: hide the controls instead of offering
       * ones that throw.
       */
      if (!vault.canPersist) {
        setCanPersist(false);
        setRows([]);
        return;
      }
      setCanPersist(true);

      const stored = await vault.list();
      setRows(
        stored.map(
          (r: {serviceId: string; encrypted: string; policy?: string}) => ({
            serviceId: r.serviceId,
            encrypted: r.encrypted,
            policy: r.policy,
            /*
             * Asked per row rather than inferred: isUnlocked reads the cache
             * and does NOT derive, so marking a live session costs nothing.
             */
            active: vault.isUnlocked(r.serviceId),
          }),
        ),
      );
    } catch (e) {
      onError(String((e as Error)?.message ?? e));
    }
  }, [getKey, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh, reloadKey]);

  const copyBlob = useCallback(
    async (row: Row) => {
      /*
       * Sealed, so this is safe to keep in a normal file - but it still goes
       * through the sensitive path, which keeps it off the Android 13 preview
       * chip and clears it afterwards.
       */
      try {
        await NativeSecrets.copySensitive(row.encrypted, CLIPBOARD_TTL_MS);
        onStatus(`Sealed blob for ${row.serviceId} copied.`);
      } catch (e) {
        onError(String((e as Error)?.message ?? e));
      }
    },
    [onError, onStatus],
  );

  const copySecret = useCallback(
    async (row: Row) => {
      setWorking(row.serviceId);
      try {
        const plaintext = await onOpen(row.serviceId);
        if (plaintext === null) {
          onError(`Nothing is stored under ${row.serviceId}.`);
          return;
        }
        await NativeSecrets.copySensitive(plaintext, CLIPBOARD_TTL_MS);
        onStatus(
          `Copied. It clears in ${Math.round(CLIPBOARD_TTL_MS / 1000)} seconds.`,
        );
        /* Opening caches the key, so the session marker has moved. */
        await refresh();
      } catch (e) {
        onError(String((e as Error)?.message ?? e));
      } finally {
        setWorking(null);
      }
    },
    [onOpen, onError, onStatus, refresh],
  );

  const forget = useCallback(
    async (row: Row) => {
      try {
        const {okcrypto} = await getKey();
        await okcrypto.deviceVault.forget(row.serviceId);
        onStatus(`${row.serviceId} deleted. The blob is gone from this phone.`);
        await refresh();
      } catch (e) {
        onError(String((e as Error)?.message ?? e));
      }
    },
    [getKey, onError, onStatus, refresh],
  );

  const setPolicy = useCallback(
    async (row: Row, policy: Policy) => {
      try {
        const {okcrypto} = await getKey();
        /*
         * AWAITED, because the call now writes the policy to the STORED record
         * as well as the live cache. It used to set only the live one, so the
         * refresh below read the policy the credential was saved with and the
         * control snapped back to it while the status line said otherwise.
         * ok-rn/FINDING-a-vault-policy-change-was-never-stored.md
         */
        await okcrypto.deviceVault.setPolicy(row.serviceId, policy);
        /*
         * TIGHTENING TO "always" EVICTS the cached key immediately - the
         * library's behaviour, not this screen's - so the session marker has to
         * be re-read rather than assumed unchanged.
         */
        await refresh();
        onStatus(`${row.serviceId} policy is now ${policy}.`);
      } catch (e) {
        onError(String((e as Error)?.message ?? e));
      }
    },
    [getKey, onError, onStatus, refresh],
  );

  const lockAll = useCallback(async () => {
    try {
      const {okcrypto} = await getKey();
      okcrypto.deviceVault.lockAll();
      await refresh();
      onStatus('Every cached key forgotten, and its bytes overwritten.');
    } catch (e) {
      onError(String((e as Error)?.message ?? e));
    }
  }, [getKey, onError, onStatus, refresh]);

  /**
   * Delete every stored credential. The library's forgetAll() existed and
   * nothing offered it; deleting twelve rows one at a time is not a control.
   * Armed by one tap and done by the next, like the soft key's wipe.
   */
  const forgetAll = useCallback(async () => {
    if (!armedForgetAll) {
      setArmedForgetAll(true);
      return;
    }
    setArmedForgetAll(false);
    try {
      const {okcrypto} = await getKey();
      await okcrypto.deviceVault.forgetAll();
      onStatus('Every stored credential deleted from this phone.');
      await refresh();
    } catch (e) {
      onError(String((e as Error)?.message ?? e));
    }
  }, [armedForgetAll, getKey, onError, onStatus, refresh]);

  const exportAll = useCallback(async () => {
    try {
      const {okcrypto} = await getKey();
      const json = await okcrypto.deviceVault.exportJSON();
      await NativeSecrets.copySensitive(json, CLIPBOARD_TTL_MS);
      onStatus(
        `Exported ${rows?.length ?? 0} credential(s) to the clipboard. The ` +
          'blobs stay sealed, but the service names are in the clear.',
      );
    } catch (e) {
      onError(String((e as Error)?.message ?? e));
    }
  }, [getKey, onError, onStatus, rows]);

  const importAll = useCallback(async () => {
    try {
      const {okcrypto} = await getKey();
      const result = await okcrypto.deviceVault.importJSON(importText);
      setImportText('');
      setImporting(false);
      await refresh();
      onStatus(
        `Imported ${result.imported}, skipped ${result.skipped} of ` +
          `${result.total}. A name already here is kept, not overwritten.`,
      );
    } catch (e) {
      onError(String((e as Error)?.message ?? e));
    }
  }, [getKey, importText, onError, onStatus, refresh]);

  if (!canPersist) {
    return (
      <Text style={styles.note}>
        Nothing can be saved on this device - the library was built without
        somewhere to put it, so sealing still works but the blob is yours to
        keep.
      </Text>
    );
  }

  if (rows === null) {
    return <Text style={styles.note}>Reading what is stored...</Text>;
  }

  return (
    <View style={styles.root}>
      {rows.length === 0 ? (
        <Text style={styles.note}>
          Nothing stored yet. Seal something below and it appears here.
        </Text>
      ) : (
        rows.map(row => (
          <View key={row.serviceId} style={styles.row}>
            <View style={styles.rowHead}>
              <Text style={styles.service}>{row.serviceId}</Text>
              {row.active ? (
                <Text style={styles.active}>session active</Text>
              ) : null}
            </View>

            {/*
             * The policy STRINGS are the labels, deliberately. They are the
             * reference's own vocabulary, they are what an export carries, and
             * a friendly alias would be one more thing that can disagree with
             * the value underneath it.
             */}
            <Segmented
              value={(row.policy as Policy) ?? 'session:30m'}
              options={POLICIES}
              onChange={p => setPolicy(row, p)}
            />

            <View style={styles.actions}>
              <Btn
                title="Copy blob"
                onPress={() => copyBlob(row)}
                disabled={busy}
              />
              <Btn
                title={working === row.serviceId ? 'Touch the key...' : 'Copy secret'}
                tone="primary"
                disabled={busy || working !== null}
                onPress={() => copySecret(row)}
              />
              <Btn title="Delete" onPress={() => forget(row)} disabled={busy} />
            </View>
          </View>
        ))
      )}

      <View style={styles.footer}>
        <Btn title="Lock all sessions" onPress={lockAll} disabled={busy} />
        <Btn
          title="Export"
          onPress={exportAll}
          disabled={busy || !rows.length}
        />
        <Btn
          title={importing ? 'Cancel import' : 'Import'}
          onPress={() => {
            setImporting(v => !v);
            setImportText('');
          }}
          disabled={busy}
        />
        <Btn
          title={armedForgetAll ? 'Really delete all' : 'Delete all'}
          tone={armedForgetAll ? 'danger' : undefined}
          onPress={forgetAll}
          disabled={busy || !rows.length}
        />
        {armedForgetAll ? (
          <Btn title="Keep them" onPress={() => setArmedForgetAll(false)} />
        ) : null}
      </View>

      {importing ? (
        <>
          <TextInput
            value={importText}
            onChangeText={setImportText}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            placeholder="paste a vault export"
            placeholderTextColor={theme.textDim}
            style={styles.input}
          />
          <Btn
            title="Import it"
            tone="primary"
            onPress={importAll}
            disabled={busy || !importText.trim()}
          />
          <Text style={styles.note}>
            Each blob stays sealed by whichever key made it, so an import from
            another phone only opens with the OnlyKey that sealed it.
          </Text>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {gap: 12},
  row: {
    gap: 8,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.surfaceAlt,
  },
  rowHead: {flexDirection: 'row', alignItems: 'center', gap: 8},
  service: {color: theme.text, fontSize: 15, fontWeight: '600', flex: 1},
  active: {color: theme.ok, fontSize: 12},
  actions: {flexDirection: 'row', gap: 8, flexWrap: 'wrap'},
  footer: {flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 4},
  note: {color: theme.textDim, fontSize: 12, lineHeight: 18},
  input: {
    backgroundColor: theme.surfaceAlt,
    borderRadius: 8,
    color: theme.text,
    fontSize: 13,
    minHeight: 96,
    padding: 10,
    textAlignVertical: 'top',
  },
});
