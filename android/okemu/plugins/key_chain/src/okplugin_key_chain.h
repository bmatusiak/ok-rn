/*
 * okplugin_key_chain - every derived PUBLIC key the soft key answers, reported
 * to the app for its Key Chain list (plugin.js says why and where it hooks).
 * Soft key / emulator only; never private data; not an Edge use.
 */
#ifndef OKPLUGIN_KEY_CHAIN_H
#define OKPLUGIN_KEY_CHAIN_H

#include <stdint.h>

/* okcore.cpp's: 0 = the vendor interface (RAW_USB), 1 = WebAuthn (okcore.h) */
extern int outputmode;

/*
 * One derive answered. transport: outputmode at the time. code: the derivation
 * (132 v1, 232 v2, 128 the web / X-Wing key). keytype: as the request named it.
 * label32: the 32-byte label hash the request carried. pub, publen: the public
 * key as answered (publen 0 = the agent key's own size from keytype). rpid32:
 * the FIDO rpId hash, NULL on the vendor path.
 */
void okplugin_key_chain_derived(int transport, int code, int keytype, const uint8_t *label32,
                                const uint8_t *pub, int publen, const uint8_t *rpid32);

#endif
