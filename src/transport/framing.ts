/**
 * Message framing over fixed-size HID reports.
 *
 * HID gives you a stream of fixed-width packets, not messages. Anything longer
 * than one report arrives split across several, so a message layer has to
 * reassemble them. This implements the U2F/CTAPHID framing that OnlyKey and
 * most FIDO tokens speak, and which EXPLAINER/!.md section 2 calls out.
 *
 *   INIT packet:  [CID:4][CMD|0x80:1][BCNTH:1][BCNTL:1][data: n-7]
 *   CONT packet:  [CID:4][SEQ:1 (0..0x7f)][data: n-5]
 *
 * `n` is the report size (64 for full-speed USB HID).
 */

export const HID_REPORT_SIZE = 64;
export const BROADCAST_CID = 0xffffffff;

export const CTAPHID = {
  PING: 0x01,
  MSG: 0x03,
  LOCK: 0x04,
  INIT: 0x06,
  WINK: 0x08,
  CBOR: 0x10,
  CANCEL: 0x11,
  KEEPALIVE: 0x3b,
  ERROR: 0x3f,
} as const;

export type Frame = {
  channelId: number;
  command: number;
  data: Uint8Array;
};

/** Split a message into INIT + CONT packets of exactly `reportSize` bytes. */
export function encodeFrames(
  frame: Frame,
  reportSize: number = HID_REPORT_SIZE,
): Uint8Array[] {
  const {channelId, command, data} = frame;
  const initCapacity = reportSize - 7;
  const contCapacity = reportSize - 5;

  if (data.length > 0xffff) {
    throw new Error(`encodeFrames: payload ${data.length} exceeds 65535 bytes`);
  }

  const packets: Uint8Array[] = [];

  const init = new Uint8Array(reportSize);
  writeUint32(init, 0, channelId);
  init[4] = command | 0x80;
  init[5] = (data.length >> 8) & 0xff;
  init[6] = data.length & 0xff;
  init.set(data.subarray(0, initCapacity), 7);
  packets.push(init);

  let offset = initCapacity;
  let seq = 0;
  while (offset < data.length) {
    if (seq > 0x7f) {
      throw new Error('encodeFrames: sequence overflow (payload too large)');
    }
    const cont = new Uint8Array(reportSize);
    writeUint32(cont, 0, channelId);
    cont[4] = seq;
    cont.set(data.subarray(offset, offset + contCapacity), 5);
    packets.push(cont);
    offset += contCapacity;
    seq += 1;
  }

  return packets;
}

/**
 * Accumulates inbound packets and emits whole messages.
 *
 * Stateful on purpose: a CONT packet is meaningless without the INIT that
 * preceded it, so the reassembly buffer has to outlive a single callback.
 */
export class FrameAssembler {
  private channelId = 0;
  private command = 0;
  private expected = 0;
  private buffer: Uint8Array = new Uint8Array(0);
  private received = 0;
  private nextSeq = 0;
  private inProgress = false;

  constructor(private readonly reportSize: number = HID_REPORT_SIZE) {}

  reset(): void {
    this.inProgress = false;
    this.received = 0;
    this.nextSeq = 0;
    this.buffer = new Uint8Array(0);
  }

  /** Returns a complete Frame once the last CONT packet lands, else null. */
  push(packet: Uint8Array): Frame | null {
    if (packet.length < 5) {
      return null;
    }
    const cid = readUint32(packet, 0);
    const byte4 = packet[4];
    const isInit = (byte4 & 0x80) !== 0;

    if (isInit) {
      this.channelId = cid;
      this.command = byte4 & 0x7f;
      this.expected = (packet[5] << 8) | packet[6];
      this.buffer = new Uint8Array(this.expected);
      this.received = 0;
      this.nextSeq = 0;
      this.inProgress = true;

      const chunk = packet.subarray(7, Math.min(packet.length, 7 + this.expected));
      this.buffer.set(chunk, 0);
      this.received = chunk.length;
    } else {
      if (!this.inProgress) {
        // CONT with no INIT - a stale packet from a previous message. Drop it.
        return null;
      }
      if (cid !== this.channelId || byte4 !== this.nextSeq) {
        // Out-of-order or wrong-channel continuation: abandon the message
        // rather than silently splicing corrupt bytes together.
        this.reset();
        return null;
      }
      this.nextSeq += 1;
      const remaining = this.expected - this.received;
      const chunk = packet.subarray(5, Math.min(packet.length, 5 + remaining));
      this.buffer.set(chunk, this.received);
      this.received += chunk.length;
    }

    if (this.inProgress && this.received >= this.expected) {
      const frame: Frame = {
        channelId: this.channelId,
        command: this.command,
        data: this.buffer.subarray(0, this.expected),
      };
      this.reset();
      return frame;
    }
    return null;
  }
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function readUint32(source: Uint8Array, offset: number): number {
  return (
    ((source[offset] << 24) >>> 0) +
    (source[offset + 1] << 16) +
    (source[offset + 2] << 8) +
    source[offset + 3]
  );
}
