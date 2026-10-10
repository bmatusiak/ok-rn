/*
 * okplugin_key_chain - see okplugin_key_chain.h and plugin.js.
 *
 * The record handed to the app (little-endian):
 *   [0]      1          record version
 *   [1]      transport  outputmode: 0 the vendor interface, 1 WebAuthn
 *   [2..3]   code       132 v1, 232 v2, 128 the web / X-Wing key
 *   [4]      keytype    as the request named it
 *   [5]      has_rp     1 when [38..69] is the FIDO rpId hash
 *   [6..37]  label      the 32-byte label hash the request carried
 *   [38..69] rp         the rpId hash, or zeros
 *   [70..71] publen
 *   [72..]   the public key, as answered
 *
 * PUBLIC DATA ONLY, by construction: the inputs are the request's own label
 * hash and the bytes the key is about to send back anyway. Nothing here reads
 * ecc_private_key, a seed or a shared secret.
 *
 * Delivery: okemu_plugin_event(), provided by the soft key's JNI layer. It is
 * declared WEAK so a build without a provider (the desktop emulator today) links
 * and simply reports nothing.
 */
#include <string.h>
#include "okplugin_key_chain.h"

#define KC_HEADER 72
#define KC_MAX_PUB 1216 /* XWING_PK_SIZE, the largest public key a derive answers */

#if defined(__GNUC__) || defined(__clang__)
extern "C" void okemu_plugin_event(const char *name, const uint8_t *data, int len) __attribute__((weak));
#define KC_HAVE_SINK 1
#endif

/* the agent key's own size: 32 for Ed25519 / Curve25519, 64 (X||Y) for P-256 and secp256k1 */
static int agent_pub_len(int keytype) {
  return (keytype == 1 || keytype == 4) ? 32 : 64;
}

void okplugin_key_chain_derived(int transport, int code, int keytype, const uint8_t *label32,
                                const uint8_t *pub, int publen, const uint8_t *rpid32) {
#ifdef KC_HAVE_SINK
  static uint8_t rec[KC_HEADER + KC_MAX_PUB];
  if (!okemu_plugin_event || !label32 || !pub) return;
  if (publen <= 0) publen = agent_pub_len(keytype);
  if (publen > KC_MAX_PUB) return;
  memset(rec, 0, KC_HEADER);
  rec[0] = 1;
  rec[1] = (uint8_t)transport;
  rec[2] = (uint8_t)(code & 0xff);
  rec[3] = (uint8_t)((code >> 8) & 0xff);
  rec[4] = (uint8_t)keytype;
  rec[5] = rpid32 ? 1 : 0;
  memcpy(rec + 6, label32, 32);
  if (rpid32) memcpy(rec + 38, rpid32, 32);
  rec[70] = (uint8_t)(publen & 0xff);
  rec[71] = (uint8_t)((publen >> 8) & 0xff);
  memcpy(rec + KC_HEADER, pub, publen);
  okemu_plugin_event("key_chain", rec, KC_HEADER + publen);
#else
  (void)transport; (void)code; (void)keytype; (void)label32; (void)pub; (void)publen; (void)rpid32;
#endif
}

/*
 * The press record: what a sign or decrypt asks for, sent to the app the moment the key starts
 * waiting for its press, so the app can present it beside the press button. Event "press":
 *   [0]      1          record version
 *   [1]      transport  outputmode: 0 the vendor interface, 1 WebAuthn
 *   [2]      opcode     the request waiting (OKSIGN, OKDECRYPT, ...)
 *   [3]      slot       the slot or derivation code it names
 *   [4]      has_label  1 when [37..68] is the identity label of a derived code
 *   [5..36]  subject    SHA-256 of exactly the bytes handed to the press wait
 *   [37..68] label      on a derived code (201-203, 221-223), the request's last 32 bytes: the
 *                       label hash that picks the derived key; zeros otherwise
 * The label is the same 32-byte hash the derive record above carries, so the app names the
 * identity from its Key Chain list. Public data only: the request's own bytes, hashed.
 */
#include "sha256.h"
#define PRESS_BYTES 69

static int derived_code(uint8_t slot) {
  return (slot >= 201 && slot <= 203) || (slot >= 221 && slot <= 223);
}

void okplugin_key_chain_primed(int transport, uint8_t opcode, uint8_t slot, const uint8_t *msg, size_t msg_len) {
#ifdef KC_HAVE_SINK
  uint8_t rec[PRESS_BYTES];
  if (!okemu_plugin_event || !msg) return;
  memset(rec, 0, sizeof(rec));
  rec[0] = 1;
  rec[1] = (uint8_t)transport;
  rec[2] = opcode;
  rec[3] = slot;
  SHA256_CTX ctx;
  sha256_init(&ctx);
  sha256_update(&ctx, msg, msg_len);
  sha256_final(&ctx, rec + 5);
  if (derived_code(slot) && msg_len >= 32) {
    rec[4] = 1;
    memcpy(rec + 37, msg + msg_len - 32, 32);
  }
  okemu_plugin_event("press", rec, PRESS_BYTES);
#else
  (void)transport; (void)opcode; (void)slot; (void)msg; (void)msg_len;
#endif
}
