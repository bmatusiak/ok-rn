# Finding: `uECC.c` calls `uECC_point_mult()` before declaring it

**Status:** measured with NDK 27 / clang 18, every ABI. Deterministic,
compile-time.
**Severity:** blocking for any modern toolchain, **including the device one**.
This is the finding here most likely to bite a build nobody is thinking about:
it is not conditional on hosting, on 64-bit, or on Android. It is conditional on
compiler version, and the compilers moved.
**Found by:** porting `node-onlykey-emulator` to Android.

## Summary

`libraries/uECC/uECC.c` calls `uECC_point_mult()` eleven lines before it is
defined, and the only prototype is behind an `#if` this build does not set:

```c
/* uECC.c:1098, inside uECC_shared_secret() */
    uECC_point_mult(_public, _public, _private, curve);
...
/* uECC.c:1109 */
void uECC_point_mult(uECC_word_t *result,
                     const uECC_word_t *point,
                     const uECC_word_t *scalar,
                     uECC_Curve curve) {
```

`uECC_vli.h:156` does declare it, but the declaration sits inside
`#if uECC_ENABLE_VLI_API`, and `uECC.c:10-14` shows that flag being *off* is the
normal case - it is what makes `uECC_VLI_API` expand to `static`.

So the call site sees no declaration. C's implicit-declaration rule invents
`int uECC_point_mult()`, and the real definition then conflicts with it:

```
uECC.c:1109:6: error: conflicting types for 'uECC_point_mult'
uECC.c:1098:5: note: previous implicit declaration is here
```

## Why this has not been noticed

Implicit function declarations were removed from the language in C99. GCC
nevertheless accepted them with a warning for twenty-five years, which is why
this file has built everywhere until now.

That default changed. **GCC 14 turned `-Wimplicit-function-declaration` into an
error**, and clang did the same in clang 16. The Arduino 1.6.5 toolchain this
firmware ships with is old enough not to care - but the moment the device
toolchain is updated, this stops building, with no source change of any kind.

## Not fixable with a flag

`-Wno-implicit-function-declaration` silences the *first* diagnostic and does
not help: the implicit `int()` declaration is still created, and the
`conflicting types` error at the definition is a separate, unsuppressable
error. The declaration has to exist.

## Fix

Forward-declare it above the first use, or move the prototype in `uECC_vli.h`
out of the `#if uECC_ENABLE_VLI_API` block. The former is the smaller change:

```c
#include "uECC.h"
#include "uECC_vli.h"

void uECC_point_mult(uECC_word_t *result,
                     const uECC_word_t *point,
                     const uECC_word_t *scalar,
                     uECC_Curve curve);
```

Note the definition at `uECC.c:1109` is *not* marked `uECC_VLI_API`, unlike its
neighbours - so it has external linkage even when the VLI API is disabled. That
asymmetry is what left it without a visible prototype, and is worth a look on
its own: if the symbol is meant to be internal in that configuration it should
be `static`, and if it is meant to be public the prototype should not be behind
the flag.

## Where the fix currently lives

`ok-rn/android/okemu/scripts/stage.js`, applied to the staged copy. uECC is
vendored third-party code inside `libraries/`, which is outside that project's
write scope.

## Reproducing

Build `libokemu.so` for any ABI with clang 16+ or GCC 14+ after removing the
`libraries/uECC/uECC.c` entry from `stage.js` `PATCHES`.
