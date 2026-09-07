/**
 * @format
 */

import {
  CTAPHID,
  FrameAssembler,
  HID_REPORT_SIZE,
  encodeFrames,
} from '../src/transport/framing';

const CID = 0x11223344;

function payload(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = i & 0xff;
  }
  return bytes;
}

describe('encodeFrames', () => {
  test('a short message is a single INIT packet of exactly the report size', () => {
    const packets = encodeFrames({channelId: CID, command: CTAPHID.INIT, data: payload(8)});

    expect(packets).toHaveLength(1);
    expect(packets[0]).toHaveLength(HID_REPORT_SIZE);
    // [CID:4][CMD|0x80][BCNTH][BCNTL]
    expect(Array.from(packets[0].subarray(0, 7))).toEqual([
      0x11, 0x22, 0x33, 0x44, CTAPHID.INIT | 0x80, 0x00, 0x08,
    ]);
  });

  test('a message longer than one packet spills into numbered CONT packets', () => {
    // 57 bytes fit in the INIT packet (64 - 7), so 60 needs one continuation.
    const packets = encodeFrames({channelId: CID, command: CTAPHID.CBOR, data: payload(60)});

    expect(packets).toHaveLength(2);
    expect(packets[1][4]).toBe(0); // first CONT carries sequence 0
    expect(packets.every(p => p.length === HID_REPORT_SIZE)).toBe(true);
  });

  test('sequence numbers increment across continuations', () => {
    const packets = encodeFrames({channelId: CID, command: CTAPHID.MSG, data: payload(400)});
    const seqs = packets.slice(1).map(p => p[4]);

    expect(seqs).toEqual(seqs.map((_, i) => i));
  });

  test('rejects a payload that cannot fit in a 16-bit length field', () => {
    expect(() =>
      encodeFrames({channelId: CID, command: CTAPHID.MSG, data: new Uint8Array(0x10000)}),
    ).toThrow(/exceeds 65535/);
  });
});

describe('FrameAssembler', () => {
  test('round-trips a message that spans many packets', () => {
    const data = payload(1000);
    const packets = encodeFrames({channelId: CID, command: CTAPHID.CBOR, data});
    const assembler = new FrameAssembler();

    const results = packets.map(p => assembler.push(p));
    const completed = results.filter(Boolean);

    expect(completed).toHaveLength(1);
    expect(completed[0]!.channelId).toBe(CID);
    expect(completed[0]!.command).toBe(CTAPHID.CBOR);
    expect(Array.from(completed[0]!.data)).toEqual(Array.from(data));
  });

  test('a single-packet message completes on the INIT packet alone', () => {
    const assembler = new FrameAssembler();
    const [init] = encodeFrames({channelId: CID, command: CTAPHID.PING, data: payload(4)});

    const frame = assembler.push(init);

    expect(frame).not.toBeNull();
    expect(Array.from(frame!.data)).toEqual([0, 1, 2, 3]);
  });

  test('drops a continuation that arrives with no preceding INIT', () => {
    const assembler = new FrameAssembler();
    const stray = new Uint8Array(HID_REPORT_SIZE);
    stray[4] = 0x00; // looks like sequence 0

    expect(assembler.push(stray)).toBeNull();
  });

  test('abandons the message when a continuation arrives out of order', () => {
    const packets = encodeFrames({channelId: CID, command: CTAPHID.CBOR, data: payload(400)});
    const assembler = new FrameAssembler();

    assembler.push(packets[0]);
    assembler.push(packets[1]);
    // Skip packets[2]; feeding packets[3] would splice corrupt bytes together.
    expect(assembler.push(packets[3])).toBeNull();

    // The buffer is reset, so the rest of the stale message yields nothing.
    expect(assembler.push(packets[4])).toBeNull();
  });

  test('abandons the message when a continuation carries the wrong channel', () => {
    const packets = encodeFrames({channelId: CID, command: CTAPHID.CBOR, data: payload(200)});
    const assembler = new FrameAssembler();

    assembler.push(packets[0]);
    const wrongChannel = Uint8Array.from(packets[1]);
    wrongChannel[0] = 0x99;

    expect(assembler.push(wrongChannel)).toBeNull();
  });

  test('a fresh INIT resets state left over from an abandoned message', () => {
    const assembler = new FrameAssembler();
    const abandoned = encodeFrames({channelId: CID, command: CTAPHID.CBOR, data: payload(400)});
    assembler.push(abandoned[0]); // start a long message, then walk away

    const data = payload(10);
    const [init] = encodeFrames({channelId: CID, command: CTAPHID.PING, data});
    const frame = assembler.push(init);

    expect(frame).not.toBeNull();
    expect(Array.from(frame!.data)).toEqual(Array.from(data));
  });

  test('honours a non-default report size on both ends', () => {
    const data = payload(100);
    const packets = encodeFrames({channelId: CID, command: CTAPHID.CBOR, data}, 32);
    const assembler = new FrameAssembler(32);

    expect(packets.every(p => p.length === 32)).toBe(true);

    const completed = packets.map(p => assembler.push(p)).filter(Boolean);
    expect(Array.from(completed[0]!.data)).toEqual(Array.from(data));
  });
});
