/*
 * config - OKGETCONFIG (DESIGN.md, AUDIT.md).
 *
 * WHY: the firmware lets a host WRITE every setting and read none back, so no
 * app could show the key's real values, and no CLI could say whether a sign
 * will want a 3-digit code, a press, or nothing (the ssh agent printed a code
 * in single-press mode, 2026-10-02). This prints them as INI text, with key
 * names that are the library's own preference names - so an exported file
 * imports with no translation, through the setting writes the firmware already
 * has. Nothing here writes.
 *
 * WHO MAY ASK (owner, 2026-10-02): the vendor API only, after PIN entry.
 *   - locked (or never set up): no answer, as every vendor request then;
 *   - over CTAP (outputmode WEBAUTHN, the WebAuthn tunnel): refused;
 *   - soft key only: a hard key is not emulated, so the app is not in the
 *     middle - this plugin never goes into a hard-key build.
 *
 * WHAT IT NEVER PRINTS: keys, PINs, passwords, nonces, the failed-login count,
 * CTAP state, slot contents.
 *
 * VALUES are what writing them back reproduces (okcore.cpp set_slot undoes):
 *   typeSpeed  stored as 11 - value (field 13);
 *   lockButton one nibble per profile, this profile's (field 25);
 *   webcryptPolicy stored as value | OKWC_WRITTEN; unwritten = the default.
 */
#include "onlykey.h"
#include "okcore.h"
#include "okeeprom.h"
#include "okplugin_config.h"
#include <string.h>

extern int outputmode;
extern uint8_t profilemode;

/* the whole INI, padded to whole reports: 11 reports is twice what v1 prints */
#define OUT_MAX (64 * 11)
static char out[OUT_MAX];
static int at;

static void put(const char *s) {
  while (*s && at < OUT_MAX - 1) out[at++] = *s++;
}

static void put_u8(unsigned v) {
  char d[4];
  int n = 0;
  do { d[n++] = (char)('0' + v % 10); v /= 10; } while (v && n < 3);
  while (n && at < OUT_MAX - 1) out[at++] = d[--n];
}

static void line(const char *key, unsigned value) {
  put(key);
  put("=");
  put_u8(value & 0xff);
  put("\n");
}

/*
 * 0 means NEVER SET for these - the firmware's own rule: its backup writer
 * saves them only when non-zero (okcore.cpp, the settings part of the
 * backup), and at boot a 0 keeps the default (touch sense 0 -> 12, LED 0 ->
 * the brightness it already has). Printing "unset" keeps an import from
 * writing a 0 the key treats as "default" (touch sense even refuses it).
 */
static void line_or_unset(const char *key, uint8_t value) {
  if (value) { line(key, value); return; }
  put("; ");
  put(key);
  put(" unset (the firmware default)\n");
}

/* the firmware's own resolution - the same function a sign asks (okcore.cpp) */
static const char *mode_word(uint8_t mode) {
  return mode == USER_INPUT_CHALLENGE ? "code" : mode == USER_INPUT_PRESS ? "press" : "none";
}

static void moded(const char *key, uint8_t mode) {
  put(key);
  put("=");
  put(mode_word(mode));
  put("\n");
}

static uint8_t get(int (*getter)(uint8_t *)) {
  uint8_t v = 0;
  getter(&v);
  return v;
}

void okplugin_config_recv(uint8_t *buffer) {
  (void)buffer;
  if (!(initialized == true && unlocked == true)) return; /* after PIN entry only (config mode never reaches here: its allow-list, recvmsg) */
  if (outputmode != RAW_USB) { hidprint("Error OKGETCONFIG is vendor API only"); return; }

  at = 0;
  memset(out, 0, sizeof out);
  put("; OnlyKey soft key config - OKGETCONFIG v");
  put_u8(OKGETCONFIG_VERSION);
  put("\n[input]\n; resolved: what the key will ask for (code | press | none) - read-only\n");
  moded("derived_keys", okcore_user_input_mode_for_slot(201));
  moded("stored_keys", okcore_user_input_mode_for_slot(1));
  moded("web_derive", okcore_user_input_mode_for_slot(RESERVED_KEY_WEB_AGENT_DERIVATION));
  put("hmac=");
  put(get(okeeprom_eeget_hmac_challengemode) == 1 ? "none" : "press");
  put("\n");

  put("\n[preferences]\n");
  {
    uint8_t ts = 0;
    okeeprom_eeget_typespeed(&ts, 0);
    if (ts >= 1 && ts <= 11) line("typeSpeed", 11 - ts);
    else put("; typeSpeed unset (the firmware default)\n");
  }
  line_or_unset("keyboardLayout", get(okeeprom_eeget_keyboardlayout));
  line_or_unset("ledBrightness", get(okeeprom_eeget_ledbrightness));
  line("lockout", get(okeeprom_eeget_timeout));
  {
    uint8_t lb = get(okeeprom_eeget_autolockslot);
    line("lockButton", profilemode ? (lb >> 4) : (lb & 0x0f));
  }
  line_or_unset("touchSense", get(okeeprom_eeget_touchoffset));
  line("modKeyMode", get(okeeprom_eeget_modkey));
  line("hmacChallengeMode", get(okeeprom_eeget_hmac_challengemode));
  line("derivedChallengeMode", get(okeeprom_eeget_derived_key_challenge_mode));
  line("storedChallengeMode", get(okeeprom_eeget_stored_key_challenge_mode));
  line("webAgentDeriveMode", get(okeeprom_eeget_web_agent_derive_mode));
  line("secProfileMode", get(okeeprom_eeget_2ndprofilemode));

  put("\n[advanced]\n; one-way: an import changes these only when asked to\n");
  {
    uint8_t wc = get(okeeprom_eeget_webcrypt_policy);
    if (OKWC_IS_WRITTEN(wc)) line("webcryptPolicy", wc & OKWC_VALID_MASK);
    else put("; webcryptPolicy unset (the firmware default)\n");
  }
  line("wipeMode", get(okeeprom_eeget_wipemode));
  line("backupKeyMode", get(okeeprom_eeget_backupkeymode));

  /*
   * NUL-terminated and padded to whole reports: send_transport_response copies
   * only the bytes it is given into a buffer it never clears, so a short last
   * report would carry the previous reply's tail (held finding c).
   */
  int total = ((at + 1 + 63) / 64) * 64;
  send_transport_response((uint8_t *)out, total, false, false);
}
