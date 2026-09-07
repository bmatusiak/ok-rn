# Finding: Arduino's `Time` library cannot be built against a non-glibc libc

**Status:** measured with NDK 27 / clang 18 against bionic, on Windows.
Deterministic, compile-time. Two distinct defects, both in the same library.
**Severity:** blocking for a hosted build on Android or macOS. Irrelevant on the
device, which links no libc at all.
**Found by:** porting `node-onlykey-emulator` to Android.
**Whose code:** the stock Arduino `Time` library, not OnlyKey's.

## Defect 1: the `time_t` guard tests a glibc-private macro

`libraries/Time/TimeLib.h:19-22`:

```c
#ifndef __AVR__
#include <sys/types.h> // for __time_t_defined, but avr libc lacks sys/types.h
#endif

#if !defined(__time_t_defined) // avoid conflict with newlib or other posix libc
typedef unsigned long time_t;
#endif
```

The comment says "or other posix libc", but `__time_t_defined` is not a POSIX
macro - it is glibc's own internal guard. bionic defines `time_t` and does not
define it; musl does not define it either. On any of those the guard fails to
fire and the library redefines a type the libc already owns:

```
TimeLib.h:21:23: error: typedef redefinition with different types
                        ('unsigned long' vs '__time_t' (aka 'long'))
```

This is exactly why `node-onlykey-emulator` builds and this did not: glibc is
the one libc where the guard happens to work.

The correct test is `_TIME_T_DECLARED` (the BSD/POSIX spelling), or better, not
declaring `time_t` at all when `<sys/types.h>` was successfully included.

**Worth noting for whoever fixes it:** bionic's `time_t` is *signed*, Teensy's
is unsigned. Both are 32 bits on `armeabi-v7a`, so arithmetic is unaffected
until 2038, but the types are not identical and code comparing a `time_t`
against a large constant could differ.

## Defect 2: `Time.h` collides with `<time.h>` on a case-insensitive filesystem

The library ships two headers. `TimeLib.h` has the content; `Time.h` is one
line:

```c
#include "TimeLib.h"
```

Six firmware files include `"Time.h"`, so the library's directory has to be on
the include path. `-I` directories are searched before the sysroot, so on
Windows or macOS - where the filesystem does not distinguish case - any
`#include <time.h>` anywhere in the translation unit resolves to *this* header
instead of libc's:

```
okemu_pins.cpp:15:10: warning: non-portable path to file '<Time.h>';
                     specified path differs in case from file name on disk
okemu_pins.cpp:64:21: error: variable has incomplete type 'struct timespec'
```

`struct timespec`, `clock_gettime` and `nanosleep` all silently vanish, in every
file that needs them, for a reason the diagnostic does not explain. Linux cannot
reproduce this at all.

## Fix

Defect 1: test `_TIME_T_DECLARED`, or gate the typedef on `__AVR__` only, since
the `#include <sys/types.h>` above it already supplies `time_t` everywhere else.

Defect 2: delete `Time.h` and have the six consumers include `"TimeLib.h"`
directly. The shim exists only for backward compatibility with sketches that
predate the rename, and it is the sole reason a lowercase `time.h` is
unreachable.

## Where the fix currently lives

`ok-rn/android/okemu/scripts/stage.js`:

- Defect 1 is worked around with `-D__time_t_defined` in `CMakeLists.txt`, which
  satisfies the guard and leaves bionic's `time_t` in place. Defining another
  libc's private macro is not a good fix; it is the least invasive one available
  without patching the library.
- Defect 2 is fixed properly - `defuseTimeHeader()` stages the library, deletes
  `Time.h`, and rewrites its consumers to `TimeLib.h`.
