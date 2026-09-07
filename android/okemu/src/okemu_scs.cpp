/*
 * okemu_scs.cpp - backing store for the Cortex-M system block.
 *
 * The emulator maps 0xE0000000 with mmap so kinetis.h's absolute addresses
 * resolve. Android cannot: that window is above the 3 GB user/kernel split on
 * 32-bit ARM, and Samsung ships a 32-bit-only build on some supported
 * handsets, so the mapping can never succeed there.
 *
 * scripts/stage.js instead rewrites every 0xE0000000-range register in the
 * staged kinetis.h to index this array. Ten of them are actually reached by
 * the firmware - the DWT cycle counter, SysTick, and three SCB registers - and
 * every one is either driven by core-override/okemu_pins.cpp or inert.
 *
 * Page-aligned on purpose: okemu_restart.cpp mprotects the page holding
 * SCB_AIRCR so a write to it faults and can be turned into a restart request,
 * and mprotect works on page granularity.
 */
#include <stddef.h>

#ifndef OKEMU_SCS_ALIGN
#define OKEMU_SCS_ALIGN 4096
#endif

extern "C" {
__attribute__((aligned(OKEMU_SCS_ALIGN)))
unsigned char okemu_scs_base[0x00100000];
}
