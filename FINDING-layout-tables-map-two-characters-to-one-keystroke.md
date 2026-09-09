# Two layout tables give different characters identical keystrokes

**Severity:** low for us, medium upstream — on real hardware the key types the
wrong character
**Status:** open — upstream tables; the library detects and reports the clashes
rather than guessing
**Applies to:** upstream — `core/keylayouts.c`

Found by round-tripping every printable character through every layout while
testing the keystroke decoder. Both cases are in the shipped tables, and neither
is something a decoder can resolve: the information is not on the wire.

## 1. Canadian French types `|` as `#`

```c
keylayouts.c:1372   ASCII_23=KEY_TILDE + SHIFT_MASK;// 35 #
keylayouts.c:1462   ASCII_7C=KEY_TILDE + SHIFT_MASK;// 124 |
```

The same keycode for both. A slot containing `|` types `#`, and a decoder
reading it back has no way to know which was meant.

On a real Canadian French keyboard `|` is AltGr, so the entry looks like a
missing `+ ALTGR_MASK`. Both characters appear in passwords.

## 2. Portuguese types `^` as `~` and `` ` `` as `´`

```c
keylayouts.c:3374   DEADKEY_CIRCUMFLEX=KEY_BACKSLASH;
keylayouts.c:3375   DEADKEY_ACUTE_ACCENT=KEY_RIGHT_BRACE + SHIFT_MASK;
keylayouts.c:3376   DEADKEY_GRAVE_ACCENT=KEY_RIGHT_BRACE + SHIFT_MASK;
keylayouts.c:3377   DEADKEY_TILDE=KEY_BACKSLASH;
```

Two pairs, each pair identical. On a Portuguese keyboard these are shifted
variants of one physical key — `~` unshifted and `^` shifted, `´` unshifted and
`` ` `` shifted — so one of each pair is missing its `SHIFT_MASK`.

This is worse than the Canadian French case, because it is not only a decoding
ambiguity. The firmware types the dead key it was given, so on real hardware
with a real host, a slot containing `^` produces `~`. The wrong character
reaches the window, and it is wrong before anything reads it back.

Other layouts get the same accents right — one at `keylayouts.c:4897-4898` gives
acute and grave distinct keys — which is what makes this look like a
transcription slip rather than a deliberate simplification.

## What the library does about it

Nothing clever, deliberately. `keystrokes.js` keys its table on the **keystroke
sequence** rather than on the character or the accent, so identical sequences
collide visibly instead of the second silently overwriting the first. The
clashes are reported:

```js
keystrokes.layouts().find(l => l.name === 'CANADIAN_FRENCH').ambiguous
  // [ '#|' ]
```

and a caller displaying a decoded password can say the value is ambiguous rather
than showing a confident wrong answer. `USA_ENGLISH` — the only layout a debug
build can type at all, see
`FINDING-only-us-english-types-on-a-debug-build.md` — reports none.

Keying on the sequence rather than on the accent is what made case 2 visible.
An earlier version keyed on the accent bits, where `DEADKEY_TILDE` simply
overwrote `DEADKEY_CIRCUMFLEX` in the lookup and `^` decoded as `~` with no
indication anything was wrong. That is exactly the failure the whole decoder is
supposed to avoid, and it took the 28-layout sweep to catch it.

## Not fixed

Correcting the tables means editing firmware source, and staging exists to make
the firmware run rather than to change what it does. Neither case can be
confirmed without a real device and a real Portuguese or Canadian French host,
which is also why the diagnosis above is stated as what the tables say rather
than as measured behaviour.
