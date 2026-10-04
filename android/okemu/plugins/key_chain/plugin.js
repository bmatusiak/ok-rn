'use strict';
/*
 * key_chain - the soft key tells the app about every derived PUBLIC key it
 * answers (spec session + Brad, 2026-10-03), so ok-rn can keep it in the
 * phone's Key Chain list. Only the firmware sees every transport in the clear:
 * the FIDO derive (the web page path) is transit-encrypted before the app could
 * read it. So the record is made here and handed to the app as an event.
 *
 * What a record carries (src/okplugin_key_chain.cpp): the transport
 * (outputmode: the vendor interface or WebAuthn), the derivation code (132 v1,
 * 232 v2, 128 the web/X-Wing key), the keytype, the 32-byte label hash the
 * request named, the rpId hash on the FIDO path, and the public key. NEVER a
 * private key, a seed or a shared secret.
 *
 * A derive is not a use: no Edge link, no ticket, no budget is touched. A
 * firmware derive LINK (for hard keys too) is a later spec proposal.
 *
 * Hooks (each anchor occurs exactly once in the 3.1.0 tree):
 *   1 okcrypto.cpp       include the plugin header
 *   2 okcrypto.cpp       OKGETPUBKEY agent derivation v1 (code 132)
 *   3 okcrypto.cpp       OKGETPUBKEY agent derivation v2 (code 232)
 *   4 okcrypto.cpp       OKGETPUBKEY derived X-Wing recipient (code 128)
 *   5 ok_extension.cpp   include the plugin header
 *   6 ok_extension.cpp   the FIDO derive (web page path): ed25519/x25519, P-256, secp256k1
 *   7 ok_extension.cpp   the FIDO derived X-Wing recipient
 *
 * The app side: okemu_plugin_event() (jni/okemu_jni.cpp) -> NativeOkEmu
 * onPluginEvent -> src/keyChainRecorder.ts.
 */
const INC = '#include "plugins/key_chain/okplugin_key_chain.h"\n';
module.exports = {
  name: 'key_chain',
  minBase: '3.1.0',
  notes: 'reports each derived public key the soft key answers (transport, code, keytype, label hash, rpId hash, public key) to the app for its Key Chain list; never private data; not a use',
  backup: false,
  /* keeps nothing in flash or EEPROM: the soft key's storage slot is not named after it (firmware-plugins slotPlugins) */
  stateless: true,
  hooks: [
    { file: 'okcrypto.cpp', anchor: '#include "onlykey.h"\n', insert: 'after', text: INC },
    {
      file: 'okcrypto.cpp',
      anchor: '        okcrypto_derive_key(buffer[6], buffer + 7, 0);\n',
      insert: 'after',
      text: '        okplugin_key_chain_derived(outputmode, RESERVED_KEY_DERIVATION, buffer[6], buffer + 7, ecc_public_key, 0, NULL);\n',
    },
    {
      file: 'okcrypto.cpp',
      anchor: '        okcrypto_derive_key(buffer[6], buffer + 7, RESERVED_KEY_DERIVATION);\n',
      insert: 'after',
      text: '        okplugin_key_chain_derived(outputmode, DERIVATION_V2_PUBKEY_CODE, buffer[6], buffer + 7, ecc_public_key, 0, NULL);\n',
    },
    {
      file: 'okcrypto.cpp',
      anchor: '        okcrypto_xwing_derive_getpubkey(buffer + 7, large_resp_buffer);\n',
      insert: 'after',
      text: '        okplugin_key_chain_derived(outputmode, RESERVED_KEY_WEB_AGENT_DERIVATION, KEYTYPE_XWING, buffer + 7, large_resp_buffer, XWING_PK_SIZE, NULL);\n',
    },
    { file: 'libraries/fido2/ok_extension.cpp', anchor: '#include "onlykey.h"\n', insert: 'after', text: INC },
    {
      file: 'libraries/fido2/ok_extension.cpp',
      anchor: '                memcpy(temp + 32 + sizeof(UNLOCKED) + 1, ecc_public_key, pubsize); // Copy derived public key to temp\n',
      insert: 'after',
      text: '                okplugin_key_chain_derived(outputmode, RESERVED_KEY_WEB_AGENT_DERIVATION, opt2, additional_data + 1, ecc_public_key, pubsize, _appid); /* [0] is a prefix byte; the label hash follows */\n',
    },
    {
      file: 'libraries/fido2/ok_extension.cpp',
      anchor: '                    okcrypto_xwing_derive_getpubkey(label32, large_resp_buffer + hdr);\n',
      insert: 'after',
      text: '                    okplugin_key_chain_derived(outputmode, RESERVED_KEY_WEB_AGENT_DERIVATION, KEYTYPE_XWING, label32, large_resp_buffer + hdr, XWING_PK_SIZE, _appid);\n',
    },
  ],
};
