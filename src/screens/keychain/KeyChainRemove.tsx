import React, {useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Btn, Section} from '../../ui/components';
import {theme} from '../../ui/theme';
import {type Job, type RemoveTarget, Choice, KIND_TITLE, PGP_ROLE, slotName} from './shared';

/*
 * REMOVING A KEY GOES THROUGH QUESTIONS TOO (owner, 2026-10-01). A plain
 * "Remove from the list" dialog only took the public key off the phone, and
 * left the private key it stood for sitting on the OnlyKey - the half that
 * matters. Removing is also where the costly mistakes are: wipe the OnlyKey's
 * key and everything encrypted to it is unreadable, every server or person
 * that trusted it stops. So, like making a key, removing one asks only what
 * applies to THIS key:
 *
 *   1. what goes - the public key kept in the App, or the key itself from the
 *      OnlyKey (asked only when there is both);
 *   2. for the OnlyKey's key: is anything still using it - with what breaks,
 *      in plain words for this key's use - and "not sure" stops so a backup
 *      can be made first (a device backup carries the key);
 *   3. an encrypted copy in the App: keep it (the key can come back) or
 *      delete it too (then it is gone for good);
 *   4. the review, saying exactly what goes.
 *
 * Wiping is a write to the OnlyKey: it joins "Waiting to be written" (config
 * mode, the Write confirmation), and the App's entry and copies go only when
 * the wipe is written - a wipe that never happens takes nothing with it.
 */

type Answers = {what?: 'app' | 'key'; depends?: 'none' | 'unsure'; copy?: 'keep' | 'delete'};

type Q =
  | {kind: 'choice'; ask: string; why?: string; list?: string[]; options: {label: string; info: string; set: Answers; recommended?: boolean}[]}
  | {kind: 'stop'}
  | {kind: 'review'};

/* What stops working when the OnlyKey's key is destroyed, by what it was for. */
function breaks(t: RemoveTarget): string[] {
  const kind = t.kind || (t.slots.some(s => PGP_ROLE[s.slot]) ? 'pgp' : null);
  switch (kind) {
    case 'pgp':
      return [
        'Email and files encrypted to you can no longer be opened.',
        'People who have your PGP public key need your new one; signatures you made still check out.',
      ];
    case 'ssh':
      return ['Servers that let you in with this key refuse you until you add a new key on each of them.'];
    case 'age':
    case 'xwg':
    case 'mlk':
    case 'enc':
      return ['Files encrypted to it can no longer be opened - by anyone, ever.'];
    case 'sig':
      return [
        'It can never sign again. An Android app signed with it can never be updated, a release can never carry the same signer.',
      ];
    default:
      return ['Anything that used it - logins, encrypted files, signatures - stops working with it.'];
  }
}

function slotsText(t: RemoveTarget): string {
  return t.slots.map(s => `${slotName(s.slot)}${s.label ? ` ("${s.label}")` : ''}`).join(' and ');
}

function nextQuestion(a: Answers, t: RemoveTarget): Q {
  const hasSlots = t.slots.length > 0;
  const what = a.what ?? (hasSlots && t.entryId ? undefined : hasSlots ? 'key' : 'app');
  if (!what) {
    return {
      kind: 'choice',
      ask: 'What do you want to remove?',
      why: `"${t.title}" is a key on the OnlyKey (${slotsText(t)}), and the App keeps its public key. These are different things.`,
      options: [
        {
          label: 'Only the public key kept in the App',
          info: 'The key stays on the OnlyKey and keeps working. Key Chain can read its public key again any time.',
          set: {what: 'app'},
          recommended: true,
        },
        {
          label: 'The key itself, from the OnlyKey',
          info: 'The private key is destroyed for good. Its public key leaves the App with it.',
          set: {what: 'key'},
        },
      ],
    };
  }
  if (what === 'key' && !a.depends) {
    return {
      kind: 'choice',
      ask: 'Is anything still using this key?',
      why: `Destroying the key in ${slotsText(t)} cannot be undone. What stops working:`,
      list: breaks(t),
      options: [
        {label: 'Nothing uses it any more — destroy it', info: 'Go on to the next question.', set: {depends: 'none'}},
        {
          label: 'It might — let me make a backup first',
          info: 'A backup of the OnlyKey carries this key, so it can be restored if something turns out to need it.',
          set: {depends: 'unsure'},
          recommended: true,
        },
      ],
    };
  }
  if (what === 'key' && a.depends === 'unsure') return {kind: 'stop'};
  if (t.copies.length && !a.copy) {
    const names = t.copies.map(c => c.title).join(', ');
    return {
      kind: 'choice',
      ask: 'There is an encrypted copy of this key in the App. What about it?',
      why: `${names}. It is the private key, locked by the passphrase chosen when it was made.`,
      options: what === 'key'
        ? [
            {label: 'Keep the copy', info: 'The key can be loaded back onto an OnlyKey later, with its passphrase.', set: {copy: 'keep'}, recommended: true},
            {label: 'Delete the copy too', info: 'Then there is nothing left to restore it from: the key is gone for good.', set: {copy: 'delete'}},
          ]
        : [
            {label: 'Keep the copy', info: 'Only the public key leaves the App.', set: {copy: 'keep'}, recommended: true},
            {label: 'Delete the copy too', info: 'The key on the OnlyKey is not touched; only the copy in the App goes.', set: {copy: 'delete'}},
          ],
    };
  }
  return {kind: 'review'};
}

function reviewLines(a: Answers, t: RemoveTarget): string[] {
  const hasSlots = t.slots.length > 0;
  const what = a.what ?? (hasSlots ? 'key' : 'app');
  const l: string[] = [];
  if (what === 'key') {
    l.push(`Destroys the key in ${slotsText(t)}. It is wiped in config mode, with the rest of "Waiting to be written", after you confirm Write.`);
    if (t.entryId) l.push('Its public key leaves "On this App" when the wipe is written.');
  } else {
    l.push(`Removes "${t.title}" from "On this App".`);
    if (t.derived) l.push('It can be derived again from the same label any time - nothing on the OnlyKey changes.');
    else if (hasSlots) l.push(`The key on the OnlyKey (${slotsText(t)}) is not touched.`);
  }
  if (t.copies.length) {
    l.push(a.copy === 'delete'
      ? `The encrypted copy is deleted${what === 'key' ? ' too - after this, the key exists nowhere' : ''}.`
      : 'The encrypted copy stays in the App.');
  }
  return l;
}

export function KeyChainRemove({
  target,
  busy,
  onClose,
  removeNow,
  addJobs,
}: {
  target: RemoveTarget;
  busy: string | null;
  onClose: () => void;
  /* Phone-side only: the list entry and/or encrypted copies, straight away. */
  removeNow: (entryId: string | null, copyIds: string[]) => Promise<void>;
  /* Wipes go to "Waiting to be written"; the screen closes this when they are queued. */
  addJobs: (jobs: Job[]) => void;
}) {
  const [answers, setAnswers] = useState<Answers>({});
  const [history, setHistory] = useState<Answers[]>([]);
  const q = nextQuestion(answers, target);
  const answer = (set: Answers) => {
    setHistory(h => [...h, answers]);
    setAnswers(a => ({...a, ...set}));
  };
  const back = () => {
    if (!history.length) return onClose();
    setAnswers(history[history.length - 1]);
    setHistory(h => h.slice(0, -1));
  };

  const what = answers.what ?? (target.slots.length ? 'key' : 'app');
  const copyIds = answers.copy === 'delete' ? target.copies.map(c => c.id) : [];
  const finish = async () => {
    if (what === 'key') {
      addJobs(target.slots.map(s => ({
        slot: s.slot, type: s.kind as Job['type'], tag: s.label || null,
        op: 'wipe' as const, removeEntry: target.entryId, removeCopies: copyIds,
      })));
      onClose();
      return;
    }
    await removeNow(target.entryId, copyIds);
    onClose();
  };

  return (
    <Section title={q.kind === 'review' ? 'Here is what will go' : q.kind === 'stop' ? 'Make a backup first' : `Remove — question ${history.length + 1}`}>
      <Text style={styles.trail}>Removing: {target.title}</Text>

      {q.kind === 'choice' ? (
        <>
          <Text style={styles.ask}>{q.ask}</Text>
          {q.why ? <Text style={styles.why}>{q.why}</Text> : null}
          {q.list ? q.list.map((l, i) => <Text key={i} style={styles.warn}>•  {l}</Text>) : null}
          {q.options.map(o => (
            <Choice key={o.label} title={o.recommended ? `${o.label}  (recommended)` : o.label} info={o.info} selected={false} onPress={() => answer(o.set)} />
          ))}
        </>
      ) : null}

      {q.kind === 'stop' ? (
        <>
          <Text style={styles.line}>
            Open Backup/Restore and back up the OnlyKey: the backup carries this key, so it can be put back if something
            turns out to need it. Then come back here and remove it. Nothing has been changed.
          </Text>
          <Btn title="Close" tone="primary" onPress={onClose} />
        </>
      ) : null}

      {q.kind === 'review' ? (
        <>
          <Text style={styles.ask}>
            {what === 'key' ? `Destroy "${target.title}" on the OnlyKey` : `Remove "${target.title}" from the App`}
          </Text>
          {reviewLines(answers, target).map((l, i) => <Text key={i} style={styles.line}>•  {l}</Text>)}
          <Btn
            title={what === 'key' ? 'Add the wipe to the list to write' : 'Remove it'}
            tone="danger"
            disabled={busy !== null}
            onPress={() => void finish()}
          />
        </>
      ) : null}

      <View style={styles.nav}>
        <Btn title="Back" onPress={back} />
        <Btn title="Cancel" onPress={onClose} />
      </View>
      {target.kind && KIND_TITLE[target.kind] ? <Text style={styles.why}>Used for: {KIND_TITLE[target.kind]}</Text> : null}
    </Section>
  );
}

const styles = StyleSheet.create({
  trail: {color: theme.accent, fontSize: 12, lineHeight: 18},
  ask: {color: theme.text, fontSize: 17, fontWeight: '600', lineHeight: 24},
  why: {color: theme.textSecondary, fontSize: 13, lineHeight: 19},
  line: {color: theme.text, fontSize: 14, lineHeight: 20},
  warn: {color: theme.warn, fontSize: 13, lineHeight: 19},
  nav: {flexDirection: 'row', gap: 8, flexWrap: 'wrap'},
});
