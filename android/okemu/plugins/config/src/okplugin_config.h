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
void okplugin_config_set(uint8_t *buffer);

#endif
