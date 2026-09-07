/*
 * okemu_compat.c - libc functions bionic does not provide.
 *
 * The Teensy core's nonstd.c implements dtostrf() - the AVR float-to-string
 * helper that WString.cpp uses for String(float) - in terms of fcvt(). fcvt()
 * was marked obsolete in POSIX.1-2001 and removed in POSIX.1-2008; glibc still
 * ships it for compatibility, bionic never did. So this links under the Node
 * emulator and not on Android.
 *
 * Implemented here rather than patched into nonstd.c so the staged core stays
 * as close to upstream as possible: this is a missing libc function, not a
 * firmware defect.
 */
#include <stdio.h>
#include <string.h>
#include <math.h>

#if defined(__ANDROID__)

/*
 * Convert `value` to a string of exactly `ndigit` digits after the decimal
 * point, with no decimal point in the output.
 *
 *   *decpt - position of the decimal point relative to the start of the
 *            returned digits. Zero or negative means it sits to the left of
 *            them, i.e. the value is less than 1.
 *   *sign  - non-zero if `value` is negative.
 *
 * Returns a pointer to static, per-thread storage, overwritten by the next
 * call - which is what callers of the real fcvt() already expect.
 */
char *fcvt(double value, int ndigit, int *decpt, int *sign) {
  /* Enough for DBL_MAX's 309 integer digits, ndigit decimals, sign and NUL. */
  static _Thread_local char formatted[512];
  static _Thread_local char digits[512];

  if (ndigit < 0) ndigit = 0;
  if (ndigit > 320) ndigit = 320;

  *sign = (value < 0.0 || (value == 0.0 && signbit(value))) ? 1 : 0;

  const double magnitude = *sign ? -value : value;
  snprintf(formatted, sizeof formatted, "%.*f", ndigit, magnitude);

  /* Split at the decimal point. snprintf omits it entirely when ndigit == 0. */
  char *point = strchr(formatted, '.');
  const size_t int_len = point ? (size_t)(point - formatted) : strlen(formatted);

  /*
   * A lone "0" integer part is not part of the result: fcvt(0.05, 2) yields
   * "05" with *decpt == 0, not "005" with *decpt == 1. Any other integer part
   * is kept, and its length is where the point sits.
   */
  const int drop_leading_zero = (int_len == 1 && formatted[0] == '0');
  *decpt = drop_leading_zero ? 0 : (int)int_len;

  size_t out = 0;
  for (size_t i = drop_leading_zero ? 1 : 0; formatted[i] != '\0'; i++) {
    if (formatted[i] == '.') continue;
    if (out + 1 >= sizeof digits) break;
    digits[out++] = formatted[i];
  }
  digits[out] = '\0';
  return digits;
}

#endif /* __ANDROID__ */
