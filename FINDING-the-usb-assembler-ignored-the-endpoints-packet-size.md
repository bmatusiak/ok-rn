# The USB assembler ignored the endpoint's packet size

## What happened

`UsbHidClient` learned the endpoint's report size on connect and used it to
SEND, but reassembled inbound reports at a size fixed when the object was
constructed:

```ts
private readonly assembler = new FrameAssembler(HID_REPORT_SIZE);  // 64, forever
private packetSize = HID_REPORT_SIZE;

async connect(...) {
  const result = await NativeUsbHid.connect(vendorId, productId);
  this.packetSize = result.packetSize > 0 ? result.packetSize : HID_REPORT_SIZE;
  //                ^ used by sendMessage, never by the assembler
}
```

The two ends therefore disagree about report width against any endpoint that is
not 64 bytes.

## Why it matters

The width decides where a payload begins, not just how much fits:

```
INIT packet:  [CID:4][CMD|0x80:1][BCNTH:1][BCNTL:1][data: n-7]
CONT packet:  [CID:4][SEQ:1]                       [data: n-5]
```

`n` is only the packet length, so a mismatch does not shift the header. What it
gets wrong is how many payload bytes each packet is believed to carry. Reading a
32-byte report as if it were 64 makes the assembler count 57 bytes out of an
init packet that only held 25, so a message is declared complete early, with
whatever followed the real data spliced onto it — from the next packet, or from
uninitialised space.

It fails as wrong bytes, not as an error.

## Why it was never seen

The OnlyKey's HID endpoint is 64 bytes, which is also the default, so the two
values have always agreed on the hardware this has run against. The bug needs an
endpoint that reports something else, and none has been attached.

Note the code had already been written for the general case — `packetSize` is
read from the connect result and threaded into `encodeFrames` — so this is not
an assumption, it is half of a correction.

## Severity

Latent. Nothing shipped has been wrong, because no non-64 endpoint has been
connected. It is recorded because the failure is silent and would present as
corrupt CTAP replies rather than as a framing error, which is a hard thing to
work backwards from.

## Fixed

The assembler is rebuilt in `connect()` at the size the endpoint reported, and
is no longer `readonly` for that reason. The library's `Assembler` and `frame`
both take `packetSize`, and `test/ctaphid.test.js` covers a 32-byte report at
both ends.

Found while consolidating `src/transport/framing.ts` into the library, which is
the point: the app's copy and the library's had drifted, and comparing them is
what surfaced this.
