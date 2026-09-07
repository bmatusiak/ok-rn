# Finding: `Print::printf()` passes `this` as a file descriptor

**Status:** measured with NDK 27 / clang 18 on `arm64-v8a` and `x86_64`.
Compile-time on 64-bit; would be a wild pointer at runtime on any host libc.
**Severity:** low in practice - nothing in the compiled firmware calls it. Filed
because the failure mode if anyone ever does is a store through a truncated
pointer, which is a bad way to find out.
**Found by:** porting `node-onlykey-emulator` to Android.
**Whose code:** the vendored Teensy core, not OnlyKey's.

## Summary

`cores/teensy3/Print.cpp` implements `printf()` by handing `this` to
`vdprintf()` in the descriptor slot:

```cpp
extern "C" {
int _write(int file, char *ptr, int len)
{
	((class Print *)file)->write((uint8_t *)ptr, len);
	return 0;
}
}

int Print::printf(const char *format, ...)
{
	va_list ap;
	va_start(ap, format);
	return vdprintf((int)this, format, ap);
}
```

The trick is that newlib's `vdprintf` calls the application's `_write()` with
whatever integer it was given, and `_write()` casts it straight back to a
`Print *`. A pointer laundered through an `int`.

Two things are wrong with it off the device.

**It does not compile at 64 bits.** `(int)this` is a narrowing pointer cast;
clang rejects it. Four instances, across the two `printf` overloads.

**Widening the cast would not fix it.** The round trip depends on the libc's
`vdprintf` dispatching through the *application's* `_write`. bionic's does not -
it takes a real file descriptor and writes to it. glibc's does not either. So on
any hosted build the integer is interpreted as a genuine descriptor: at best
`EBADF`, at worst output written to whatever fd that pointer's low bits happen
to name. The cast is the symptom; the design is the defect.

## Fix

Format into a buffer and call `write()` directly - which is what the function is
trying to do, without routing through the libc's descriptor table:

```cpp
static int okemu_vprint(Print *out, const char *format, va_list ap)
{
	char buf[256];
	int n = vsnprintf(buf, sizeof buf, format, ap);
	va_end(ap);
	if (n > 0) {
		size_t len = (size_t)n < sizeof buf ? (size_t)n : sizeof buf - 1;
		out->write((const uint8_t *)buf, len);
	}
	return n;
}
```

with both overloads calling it. This truncates at 256 bytes where the original
did not, which is a deliberate trade: a stack buffer is the only way to avoid
the descriptor round trip without an allocator.

Note the original never calls `va_end()` either.

## Reachability

Nothing in the compiled set calls `Print::printf`. The only callers are under
`libraries/flashkinetis/examples/`, which `gen-sources.js` excludes along with
every other `examples/` directory. `Serial.printf` *is* used inside the OnlyKey
firmware's `#ifdef DEBUG` blocks - but `Serial` on this build is a `usb_seremu`
stream whose `printf` comes from elsewhere, not this `Print::printf`.

That is why this is filed as low severity rather than as a live bug. It is
latent, and it is latent in a way that a 32-bit device build will never reveal.

## Where the fix currently lives

`ok-rn/android/okemu/scripts/stage.js`, applied to the staged copy. The Teensy
core is vendored third-party code; `node-onlykey-emulator` already patches it
there for the same reason (its Cortex-M inline assembly), on the stated grounds
that the core "is not OnlyKey code and should not carry emulator knowledge".
