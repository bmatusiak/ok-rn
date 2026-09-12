# The 2019 beta seeded its RNG from whatever was at address 231

## What happens

v0.2-beta.8 builds and links, the app loads the library, and the firmware
thread dies before `setup()` returns:

```
F libc: Fatal signal 11 (SIGSEGV), code 1 (SEGV_MAPERR),
        fault addr 0xe7 in tid 25371 (okemu-firmware), pid 25294 (com.okrn)
Cause: null pointer dereference
backtrace:
  #00 RNGClass::stir(unsigned char const*, unsigned long, unsigned int)+336
  #01 setup+1020
  #02 okemu_firmware_run+116
```

The version script's note recorded `0x2e4` from an earlier run. Both are
right, and the fact that they DIFFER is the answer.

## Why

`OnlyKey_Beta.ino`, in the block headed "Initialize the random number
generator with analog noise":

```cpp
unsigned int analog1 = analogRead(ANALOGPIN1);
RNG.stir((uint8_t *)analog1, sizeof(analog1), sizeof(analog1)*2);
```

`analog1` is the READING, not a buffer. The cast turns a number between 0
and 1023 into a pointer and hands it to `stir`, which reads four bytes from
there. `&analog1` is what was meant.

0xe7 is 231. 0x2e4 is 740. They are ADC samples. The fault address moves
between runs because it is the noise it was trying to collect.

## What it means on real hardware

It does not crash there, which is why it shipped. A Teensy 3.2 has flash
mapped from zero, so address 231 is a readable byte of the interrupt vector
table or the code just past it. The read succeeds, and what comes back is
four bytes of the firmware's own program image.

So on the beta firmware the "analog noise" contribution to the RNG seed is
not the noise. It is the IMAGE, indexed by the reading - four bytes from a
window about a kilobyte wide, chosen by a number an attacker holding the
binary can enumerate. `RNG.begin` also mixes a stored seed and the chip id,
and this claims 8 entropy credits per call on top of them for that.

Not exploitable on its own and not worth a second look at a 2019 beta - it
is recorded because "the RNG seeding was wrong in a way that still returned
plausible bytes" is exactly the failure that survives review.

## Fixed upstream, and when

`OnlyKey-Firmware@926b052` (2020-05-22), the commit that renamed
`OnlyKey_Beta/OnlyKey_Beta.ino` to `OnlyKey/OnlyKey.ino`:

```cpp
RNG.stir((uint8_t *)&analog1, 2, 4);
```

The address-of appears, the length drops from 4 to 2 - `unsigned int` is 4
bytes and the reading is 16-bit after `analogReadResolution(16)` - and the
credit halves with it. Every released firmware in the matrix has the fixed
line. Only the beta line carries this.

## Ten of them, not one

The two in `setup()` are only where it is reached first. `rngloop()` in
`okcore.cpp` stirs both analog pins and all six touch pads on every pass, and
every one of the eight casts the reading:

```cpp
RNG.stir((uint8_t *)touchread1, sizeof(touchread1), sizeof(touchread1));
```

So the address is not fixed either - it tracks the sensor. What gets stirred
is the firmware's own program image indexed by the reading, four bytes at a
time, from a window about a kilobyte wide. That is a function of the sample
rather than nothing at all, which is worse than nothing: it is predictable to
anyone holding the image, and the entropy credited for it is the full width
of the variable.

## What the emulator does about it

A version patch on v0.2-beta.8 that takes the address, matching what the
firmware itself became three commits later. The same class as the null
setter pointers already in `_shared.js`: a dereference the hardware tolerates
because its address happens to be mapped, and Android does not because it
does not.

The patch is version-local rather than shared. No other release contains the
line to patch.

## Measured

The backtrace above, symbolised by the platform - the frames were in
`libokemu.so` and named without `ndk-stack`, because the build ships
unstripped. Two runs, two different fault addresses, both inside the ADC
range, which is what identified the cast rather than a guess about an
unrebased hardware register.
