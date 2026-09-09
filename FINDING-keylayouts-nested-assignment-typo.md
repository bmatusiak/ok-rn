# A `=+` typo makes twelve layout table entries assign to the accent mask

**Severity:** low — reaches only the ISO-8859-1 tables, and only after the
entries that use the clobbered value
**Status:** open — upstream source; the generator skips the affected lines
**Applies to:** upstream — `core/keylayouts.c`, twelve lines

## The typo

```c
ISO_8859_1_C2=CIRCUMFLEX_BITS=+ KEY_A + SHIFT_MASK;// 194 Â     A CIRCUMFLEX
```

The intent is plainly `CIRCUMFLEX_BITS + KEY_A + SHIFT_MASK`. What C reads is an
assignment nested inside an assignment:

```c
ISO_8859_1_C2 = (CIRCUMFLEX_BITS = (+KEY_A + SHIFT_MASK));
```

so it stores `KEY_A + SHIFT_MASK` **into `CIRCUMFLEX_BITS`** on the way past,
and `ISO_8859_1_C2` gets that value rather than the accented one. It compiles
without a warning at default settings; `-Wparentheses` does not cover it, and
the unary `+` makes the expression well-formed.

Twelve lines in the file are like this (`grep -c '=+'`), across the layouts that
have a circumflex.

## What it reaches, and what it does not

**Not the ASCII table.** Every `ASCII_*` row in a layout block precedes the
`ISO_8859_1_*` rows, and `keycodes_ascii[]` is filled at the end of
`update_keyboard_layout()` from locals that were computed before the clobber. So
printable ASCII — everything a password is made of — is unaffected. This is the
reason the finding is low severity rather than high.

**The ISO-8859-1 table, from that line onward.** `CIRCUMFLEX_BITS` no longer
holds the circumflex bits, so every later entry written as
`CIRCUMFLEX_BITS + KEY_x` gets a wrong keycode, and `deadkey_to_keycode()` will
not recognise the value as an accent either. Accented Latin-1 characters on
those layouts are affected.

`ISO_8859_1_C2` itself also ends up as plain `A`.

## How it surfaced here

`ok-rn/tools/gen-keylayouts.js` parses these tables to build the decoder's
inverse map, and its expression evaluator refuses anything it does not
recognise rather than guessing — which is what turned an unreadable line into an
error instead of a silently wrong number:

```
Error: LAYOUT_CANADIAN_FRENCH: cannot evaluate ISO_8859_1_C2 = CIRCUMFLEX_BITS=+ KEY_A + SHIFT_MASK
```

The generator now collects only `ASCII_*` and the masks those are written in
terms of, so it never reads the affected lines. That is the right scope for it
independently of the typo — the decoder inverts ASCII — but it does mean the
generator would not notice if the same slip appeared in an `ASCII_*` row.

## Not fixed

Firmware source is read-only here. Worth reporting upstream: the fix is deleting
twelve `=` characters, and there is no ambiguity about the intent.
