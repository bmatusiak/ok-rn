/*
 * config - the soft key's settings as INI (DESIGN.md): OKGETCONFIG prints
 * them; OKSETCONFIG imports a file, in config mode only, through the
 * firmware's own setting write.
 */
#ifndef OKPLUGIN_CONFIG_H
#define OKPLUGIN_CONFIG_H

#include <stdint.h>

#define OK_PLUGIN_CONFIG 1

/* the read, 0xF9 on the wire (CHOSEN: free in 3.1.0, next to edge's 0x78) */
#define OKGETCONFIG (TYPE_INIT | 0x79)

/*
 * the import, 0xFA (CHOSEN): the INI text in chunks - byte 5 is 0xFF for
 * "more" or the length (1..58) of the last chunk, the text from byte 6.
 * Config mode only.
 */
#define OKSETCONFIG (TYPE_INIT | 0x7A)
#define OKSETCONFIG_CHUNK 58

/* the INI's layout version, printed in its first line */
#define OKGETCONFIG_VERSION 1

void okplugin_config_recv(uint8_t *buffer);
/*
 * OKSETCONFIG exists only in DEBUG builds (owner, 2026-10-02): a release soft
 * key reads its settings (OKGETCONFIG) but never imports.
 *
 * OKSETCONFIG_UNLISTED(c) is this plugin's term in the config-mode allow-list
 * (recvmsg refuses a command when every term is true - "not on the list").
 * DEBUG: true unless c is the import, so the import passes. Release: always
 * true, so OKSETCONFIG is refused in config mode like any unlisted command -
 * and with no case for it in the vendor switch, it is answered by nothing.
 */
#ifdef DEBUG
void okplugin_config_set(uint8_t *buffer);
#define OKSETCONFIG_UNLISTED(c) ((c) != OKSETCONFIG)
#else
#define OKSETCONFIG_UNLISTED(c) 1
#endif

#endif
