# Finding: pointers narrowed to `uint32_t` break the firmware on a 64-bit host

**Status:** measured while building `libokemu.so` for `arm64-v8a` and `x86_64`
with NDK 27 / clang 18. Deterministic - 194 diagnostics, all compile-time.
**Severity:** blocking for a 64-bit host build. Harmless on the MK20DX256, where
`uint32_t` and a pointer are the same width. **One site is worse than the rest**
and is called out below: it feeds a truncated length into a bounds check.
**Found by:** porting `node-onlykey-emulator` to Android. The Node emulator does
not surface any of this - it targets x86_64 but builds with GCC, which demotes a
narrowing pointer cast to a warning, *and* passes `-w`.

## Summary

Six sites cast a pointer to `uint32_t` (or `int`). clang rejects every one of
them outright:

```
error: cast from pointer to smaller type 'uint32_t' (aka 'unsigned int') loses information
```

Three of the six are macros expanded once per peripheral register, which is why
the raw count is 194 rather than 6.

| where | what | count | ours? |
|---|---|---|---|
| `cores/teensy3/avr_emulation.h:40,50,51` | `GPIO_BITBAND_ADDR`, `GPIO_SETBIT_ATOMIC`, `GPIO_CLRBIT_ATOMIC` - `(uint32_t)&(reg)` | 190 | Teensy core |
| `libraries/ADC/ADC_Module.h:807` | `ADC_BITBAND_ADDR` - `(uint32_t)(reg)` | 4 | Arduino ADC |
| `libraries/onlykey/okcrypto.cpp:1158,1250` | `Serial.println((uint32_t)&ret)` under `#ifdef DEBUG` | 2 | **OnlyKey** |
| `libraries/fido2/ctap_parse.cpp:1088` | `(uint32_t)end_byte - (uint32_t)start_byte` | 2 | **OnlyKey** |

The bit-band macros and the debug print are benign: the arithmetic is unchanged
by widening the cast, and the peripheral window really is mapped at
`0x40000000` whatever the pointer width.

## The one that is not benign

`libraries/fido2/ctap_parse.cpp`, `ctap_parse_cred_mgmt`:

```c
const uint8_t * start_byte = cbor_value_get_next_byte(&map);
...
const uint8_t * end_byte = cbor_value_get_next_byte(&map);

uint32_t length = (uint32_t)end_byte - (uint32_t)start_byte;
if (length > sizeof(CM->hashed.subCommandParamsCborCopy))
{
    return CTAP2_ERR_LIMIT_EXCEEDED;
}
```

Both pointers are narrowed *before* the subtraction, and the result is then
bounds-checked against a fixed buffer. On the device this is exactly correct -
pointers are 32 bits, so the truncation is a no-op. Hosted at 64 bits it is a
different shape of bug from the others: not a compile error you cannot miss, but
a length that can be wrong in a check guarding a copy. Two pointers into the
same buffer that straddle a 2^32 boundary yield a difference that is not the
real span.

Casting the *difference* rather than the operands is correct everywhere:

```c
uint32_t length = (uint32_t)((uintptr_t)end_byte - (uintptr_t)start_byte);
```

## Fix

`uintptr_t` at all six sites. This is not an emulator accommodation and does not
want an `#ifdef OK_EMULATOR`: `uintptr_t` is a 32-bit type on the MK20DX256, so
the device build is byte-identical. It is an unconditional correction that
happens to also make a hosted 64-bit build possible.

## Where the fix currently lives

`ok-rn/android/okemu/scripts/stage.js`, as patches applied to the staged copies,
because `OnlyKey-Firmware` and `libraries/` are outside that project's write
scope. The two OnlyKey-source entries are marked in that file as belonging
upstream; the Teensy and ADC ones would stay as staging patches either way,
since neither is OnlyKey code.

## Reproducing

```sh
cd ok-rn/android/okemu
node scripts/stage.js && node scripts/gen-sources.js
cmake -S . -B build -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE=$ANDROID_HOME/ndk/27.1.12297006/build/cmake/android.toolchain.cmake \
  -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-24
cmake --build build
```

Revert any of the `uintptr_t` entries in `stage.js` `PATCHES` to see the
corresponding diagnostics return.
