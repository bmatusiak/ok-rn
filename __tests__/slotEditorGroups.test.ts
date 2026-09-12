import {GROUPS, TFA_FIELDS} from '../src/screens/SlotEditorScreen';
import {device as okdevice} from 'node-onlykey-lib';

const names = (okdevice.slotConfig.SLOT_FIELDS as {name: string}[]).map(f => f.name);

test('every field the library can write has somewhere to be edited', () => {
  /*
   * The guard on a second copy of the field table. A field added to
   * SLOT_FIELDS is written by the library and read back by the editor; if no
   * group claims it, it has nowhere to appear and looks like it does not
   * exist. The catch-all group means this passes by picking the field up,
   * and the 'Other' assertion below is what makes that visible rather than
   * silent.
   */
  const shown = new Set([...GROUPS.flatMap(g => g.fields), ...TFA_FIELDS]);
  const missing = names.filter(n => !shown.has(n));
  expect(missing).toEqual([]);
});

test('nothing is offered twice, so no field has two editors', () => {
  const all = [...GROUPS.flatMap(g => g.fields), ...TFA_FIELDS];
  expect(all.length).toBe(new Set(all).size);
});

test('no group names a field the library does not have', () => {
  const known = new Set(names);
  const invented = GROUPS.flatMap(g => g.fields).filter(n => !known.has(n));
  expect(invented).toEqual([]);
});

test('the catch-all is empty, so every field has a deliberate home', () => {
  /*
   * Fails when the table grows, naming the field. That is the point: the
   * catch-all keeps a new field reachable, and this says where it went so
   * somebody decides whether 'Other' is really where it belongs.
   */
  const other = GROUPS.find(g => g.title === 'Other');
  expect(other?.fields ?? []).toEqual([]);
});
