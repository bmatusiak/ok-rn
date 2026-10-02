/*
 * config - OKGETCONFIG: the soft key prints its settings as INI text
 * (DESIGN.md). Read-only; the library imports a file by writing each value with
 * the firmware's own setting writes.
 */
#ifndef OKPLUGIN_CONFIG_H
#define OKPLUGIN_CONFIG_H

#include <stdint.h>

#define OK_PLUGIN_CONFIG 1

/* the vendor message, 0xF9 on the wire (CHOSEN: free in 3.1.0, next to edge's 0x78) */
#define OKGETCONFIG (TYPE_INIT | 0x79)

/* the INI's layout version, printed in its first line */
#define OKGETCONFIG_VERSION 1

void okplugin_config_recv(uint8_t *buffer);

#endif
