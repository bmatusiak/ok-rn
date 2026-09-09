import React, {useCallback, useState} from 'react';
import {Linking, ScrollView, StyleSheet, Text, View} from 'react-native';
import {Btn, Section} from '../ui/components';
import {theme} from '../ui/theme';

/*
 * The desktop app's Tools tab, which is a link board pointing at the web app.
 *
 * `apps.crp.to/app/*` is the deployed onlykey.github.io - the same WebCrypt
 * pages this app has been porting - and `docs.crp.to` is the manual. Both open
 * in a browser, because the whole point of them is that they run on the
 * computer you are sitting at.
 *
 * ## Where this differs from the desktop's version
 *
 * Some of these are no longer links. The derived-secret generator, the vault and
 * the age identities all run natively here now, and sending someone to a web
 * page to do a thing the app does is worse than not offering it - the web page
 * cannot even reach this key, because it talks to a device over WebAuthn and the
 * key is the phone.
 *
 * So the ones that are done say so and point at the tab. The rest link out.
 *
 * ## Nothing here is allowed to claim a feature is broken when it is not
 *
 * This screen carried "generating a key does not work - the OpenPGP build will
 * not load on the phone" for as long as that was true, and for a while after it
 * stopped being. Composite key generation, signing, decrypting and reading
 * armour all run here now. A stale warning is worse than no warning: it sends
 * someone to a web page for something the app in their hand already does.
 *
 * There is no `blocked` field any more, deliberately. One that nothing sets is
 * one that gets copied with its old text attached, which is exactly how the
 * PGP-PQC entry came to be wrong.
 */

/** apps.crp.to is where onlykey.github.io is deployed. */
const WEB_APP = 'https://apps.crp.to/app';
const DOCS = 'https://docs.crp.to';

type Tool = {
  label: string;
  detail: string;
  /** A page on the web app or the docs. */
  href?: string;
  /** Or the tab in this app that already does it. */
  here?: string;
};

const ALREADY_HERE: Tool[] = [
  {
    label: 'Encrypt and decrypt messages',
    detail:
      'Encrypt text to someone’s public key, and read what was encrypted ' +
      'to yours. Post-quantum composite keys.',
    here: 'Messages',
    href: `${WEB_APP}/encrypt`,
  },
  {
    label: 'Encrypt and decrypt files',
    detail:
      'The same for a file. Picked and shared through Android, and encrypted ' +
      'as BINARY — a file encrypted as text has its line endings ' +
      'rewritten, which is not reversible.',
    here: 'Messages',
    href: `${WEB_APP}/encrypt-file`,
  },
  {
    label: 'Sign and verify',
    detail: 'Sign text so anyone with your public key can check it came from you.',
    here: 'Messages',
  },
  {
    label: 'Derived secrets',
    detail:
      'A per-site secret the key computes from a label. The web app calls this ' +
      'the password generator.',
    here: 'Crypto',
  },
  {
    label: 'Vault',
    detail: 'Notes sealed under a key only this device can derive.',
    here: 'Crypto',
  },
  {
    label: 'age identities',
    detail:
      'Split-custody X-Wing identities: encrypt to one without the key, read ' +
      'it back with it.',
    here: 'Crypto',
  },
  {
    /*
     * CAREFUL WITH THIS ONE. It has been wrong twice.
     *
     * It said key generation was blocked for a long time after it started
     * working. Correcting that, I then said generation "runs on the phone" and
     * pointed here at Messages - which was a second wrong claim an hour after
     * the first, because generation runs in the TEST SUITE and no screen offers
     * it. Messages does the message half, with a pasted key.
     *
     * So this says exactly what a person can reach, and names what they cannot.
     */
    label: 'PGP-PQC',
    detail:
      'Composite post-quantum PGP — Ed25519 with ML-DSA to sign, X25519 with ' +
      'ML-KEM to encrypt. Messages reads and writes these with a key you paste. ' +
      'Generating one runs on the phone but has no screen yet, so for now the ' +
      'web page is where you make the key.',
    here: 'Messages',
    href: `${WEB_APP}/pgp-pqc`,
  },
];

const AGENTS: Tool[] = [
  {
    label: 'OnlyKey GPG Agent',
    detail: 'Use the key as an OpenPGP smartcard on a computer.',
    href: `${DOCS}/gpgagentquickstart.html`,
  },
  {
    label: 'OnlyKey SSH Agent',
    detail: 'Sign SSH logins with a key that never leaves the device.',
    href: `${DOCS}/sshagentquickstart.html`,
  },
];

export function ToolsScreen({onOpenTab}: {onOpenTab?: (tab: string) => void}) {
  const [error, setError] = useState<string | null>(null);

  const open = useCallback(async (href: string) => {
    setError(null);
    try {
      /*
       * canOpenURL is not asking "can this be opened". It is asking "can you
       * SEE anything that opens it", and since Android 11 the answer is no
       * unless the manifest declares a <queries> intent for the scheme - which
       * it now does. Without that this check answered false on a phone with a
       * browser sitting on its home screen, and the guard added to be helpful
       * was the only thing preventing the link from working.
       */
      if (!(await Linking.canOpenURL(href))) {
        setError('Nothing on this phone can open a web page.');
        return;
      }
      await Linking.openURL(href);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }, []);

  const renderTool = (tool: Tool) => (
    <View key={tool.label} style={styles.tool}>
      <Text style={styles.label}>{tool.label}</Text>
      <Text style={styles.detail}>{tool.detail}</Text>
      <View style={styles.row}>
        {tool.here ? (
          <Btn
            title={`Open ${tool.here}`}
            tone="primary"
            onPress={() => onOpenTab?.(tool.here as string)}
          />
        ) : null}
        {tool.href ? (
          <Btn
            title={tool.here ? 'On the web' : 'Open'}
            onPress={() => open(tool.href as string)}
          />
        ) : null}
      </View>
    </View>
  );

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}>
      <Section title="Tools">
        <Text style={styles.body}>
          The OnlyKey web tools, which run on a computer with the key plugged
          into it. They cannot reach THIS key — they talk to a device over
          WebAuthn, and here the device is the phone.
        </Text>
      </Section>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Section title="Already in this app">
        <Text style={styles.note}>
          These were web pages and are now screens. The links are kept for the
          desktop versions, not because you need them here — a web page
          cannot reach this key anyway, because the key is the phone.
        </Text>
        {ALREADY_HERE.map(renderTool)}
      </Section>

      <Section title="On a computer">
        <Text style={styles.note}>
          Agent setup guides. Nothing here runs on a phone at all — they install
          software that talks to a plugged-in key.
        </Text>
        {AGENTS.map(renderTool)}
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  content: {padding: 16, gap: 16, paddingBottom: 48},

  body: {color: theme.textSecondary, fontSize: theme.fontSize, lineHeight: theme.lineHeight},
  note: {color: theme.textDim, fontSize: 12, lineHeight: 18},
  error: {color: theme.error, fontSize: 13, lineHeight: 20},

  tool: {gap: 4, paddingTop: 8},
  label: {color: theme.text, fontSize: 14, fontWeight: '600'},
  detail: {color: theme.textSecondary, fontSize: 13, lineHeight: 19},
  row: {flexDirection: 'row', gap: 8, marginTop: 4, flexWrap: 'wrap'},
});
