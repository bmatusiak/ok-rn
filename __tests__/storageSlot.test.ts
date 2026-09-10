/**
 * Which device state a build boots against.
 *
 * flash.bin and eeprom.bin ARE the device. A firmware version reading another
 * version's flash is not a measurement of either one, so a pinned build
 * (OKEMU_VERSION) gets its own slot - and the working tree must keep the
 * unnamed one, or every phone that already has a provisioned soft key loses it
 * at the next install and nothing re-provisions itself.
 *
 * Both halves are asserted. "A pinned build gets a slot" passing while "the
 * working tree keeps none" quietly broke is the expensive direction.
 */
describe('storage slot', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('is empty for a working-tree build, so existing device state stays put', () => {
    jest.doMock(
      '../src/generated/firmware.json',
      () => ({digest: 'abc', version: null}),
      {virtual: true},
    );
    const {storageSlot, buildInfo} = require('../src/buildInfo');
    expect(storageSlot).toBe('');
    expect(buildInfo.version).toBeNull();
  });

  it('is the release name for a pinned build', () => {
    jest.doMock(
      '../src/generated/firmware.json',
      () => ({digest: 'abc', version: 'v3.0.2', production: true}),
      {virtual: true},
    );
    const {storageSlot, buildInfo} = require('../src/buildInfo');
    expect(storageSlot).toBe('v3.0.2');
    expect(buildInfo.version).toBe('v3.0.2');
    expect(buildInfo.production).toBe(true);
  });

  it('survives a build that has never been staged', () => {
    /*
     * src/generated/ is not committed, so a fresh checkout genuinely has no
     * file here. Reporting no version is right; throwing at import time would
     * take the whole app down before anything could say why.
     */
    jest.doMock('../src/generated/firmware.json', () => {
      throw new Error('module not found');
    }, {virtual: true});
    const {storageSlot, buildInfo} = require('../src/buildInfo');
    expect(storageSlot).toBe('');
    expect(buildInfo.firmware).toBe('unknown');
  });

  it('is what start() actually boots against', async () => {
    /*
     * The wiring, not just the value. The slot could be derived perfectly and
     * never reach the native module, and the firmware would then boot against
     * the default directory looking entirely healthy.
     */
    jest.doMock(
      '../src/generated/firmware.json',
      () => ({digest: 'abc', version: 'v2.1.0'}),
      {virtual: true},
    );
    const NativeOkEmu = require('../specs/NativeOkEmu').default;
    const OkEmuModule = require('../src/transport/OkEmu');
    const OkEmu = OkEmuModule.default || OkEmuModule.OkEmu;

    await OkEmu.start();
    expect(NativeOkEmu.start).toHaveBeenCalledWith('v2.1.0');
  });
});

/*
 * A DUO is a different DEVICE, not a setting.
 *
 * It has 24 slots across 4 profiles where a classic has 12 across 2, and its
 * PIN travels in the message body rather than on the buttons. Emulating one is
 * a build option (OKEMU_MODEL=duo), which makes it exactly the hazard the slot
 * exists to prevent: the same firmware version, two incompatible flash images.
 */
describe('the DUO gets a slot of its own', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('separates a DUO working tree from the classic one', () => {
    jest.doMock(
      '../src/generated/firmware.json',
      () => ({digest: 'abc', version: null, model: 'duo'}),
      {virtual: true},
    );
    const {storageSlot, buildInfo} = require('../src/buildInfo');
    expect(storageSlot).toBe('duo');
    expect(buildInfo.model).toBe('duo');
  });

  it('separates a DUO release from the same release as a classic', () => {
    jest.doMock(
      '../src/generated/firmware.json',
      () => ({digest: 'abc', version: 'v3.0.2', model: 'duo'}),
      {virtual: true},
    );
    expect(require('../src/buildInfo').storageSlot).toBe('v3.0.2-duo');
  });

  it('treats anything but "duo" as a classic, including a missing field', () => {
    // A build staged before the model was recorded must not become a DUO by
    // accident - that would point it at an empty slot and look like a wipe.
    jest.doMock(
      '../src/generated/firmware.json',
      () => ({digest: 'abc', version: 'v3.0.2'}),
      {virtual: true},
    );
    const {storageSlot, buildInfo} = require('../src/buildInfo');
    expect(storageSlot).toBe('v3.0.2');
    expect(buildInfo.model).toBe('classic');
  });
});
