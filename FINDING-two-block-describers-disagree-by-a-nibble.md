# Two firmware block describers, disagreeing by one nibble

## What is wrong

The library reads a signed firmware block's header in two places, and they do
not agree.

`src/device/firmware.js`, `describeBlock`:

```js
signature:     line.slice(0, 64),
info:          line.slice(64, 66),
nextSignature: line.slice(66, 130),
```

`src/device/parsers.js`, `describeFirmwareBlock`:

```js
signature:     block.slice(0, 64),
info:          block.slice(64, 65),
nextSignature: block.slice(65, 129),
```

One says the header is 65 bytes and the info field is a byte. The other says
64 and a half bytes and the info field is a nibble. Every field after the
signature is shifted by one hex character between them.

## Which is right

The 65-byte one, and the release images prove it rather than argue it.

`ok-rn/signed_firmware/` holds eight signed releases. Their block lines are
33026 and 32898 hex characters. Take the header off each way and see what is
left for the block's data:

| header | 33026 leaves | 32898 leaves |
|---|---|---|
| 129 chars (`parsers`) | 32897 | 32769 |
| 130 chars (`firmware`) | 32896 | 32768 |

An odd number of hex characters is not a whole number of bytes, so the 129
reading cannot be right for any real file. The 130 reading leaves 16448 and
16384 bytes, and 16384 is exactly a 16 KB flash page.

A second, independent check. The block data is stored word-swapped: reverse
every four bytes and the firmware's string table appears in the clear. Doing
that at each candidate offset, only 130 produces clean text:

```
off 126  "RPaacphp sessucrass"
off 128  " PaasphpasesSucress"
off 130  "Rr?ackup Passphrase"   <- readable
off 132  "Rraackhp Pesspcrass"
```

Any offset that is not a multiple of four bytes from the true start shuffles
the words. 130 is the one that lands.

## Why nobody saw it

`describeFirmwareBlock` has exactly one caller, and it is a test:

```js
const block = 'a'.repeat(64) + '1' + 'b'.repeat(64);
const out = parsers.describeFirmwareBlock(block);
assert.equal(out.info, '1');
```

The block is synthetic and 129 characters long, built to the same wrong shape
the function assumes, so the test and the code agree with each other and
neither has ever met a firmware file. Nothing else calls it: the app's
`src/firmwareFile.ts` goes through `firmware.describeBlock`, which is correct,
so the screen has always shown the right signatures.

The comment above it says "per the loader's own comments", which is where the
nibble came from - the loader describes the field as a nibble of block info,
and that is true of its CONTENTS. It occupies a whole byte on the wire.

## Fixed

`describeFirmwareBlock` now reads the same offsets as `describeBlock`, and its
test is rebuilt from a block with a realistic 65-byte header and an even number
of data characters, so a block that could not exist no longer passes.

The duplicate is left in place rather than collapsed into one function: they
return different shapes for different callers, and merging them is a separate
change from making them agree.

## Measured

`test/pin.test.js`, against a block whose data length is asserted even, plus
the eight release files in `ok-rn/__tests__/firmwareFile.test.ts` where the
version string only decodes at offset 130.
