/*
 * okemu_scs.cpp - backing store for the firmware's register blocks.
 *
 * NO FIXED ADDRESSES. The firmware reaches its hardware through kinetis.h, and
 * every register there is a literal absolute address:
 *
 *     #define FTFL_FSEC  (*(const uint8_t *)0x40020002)
 *     #define SYST_CVR   (*(volatile uint32_t *)0xE000E018)
 *
 * The emulator this was derived from mmaps those windows at their real
 * MK20DX256 addresses, which is a bet that nothing else in the process lives
 * there. On a phone that bet is lost twice over:
 *
 *   0xE0000000  the Cortex-M system block is above the 3 GB user/kernel split
 *               on 32-bit ARM (Samsung ships 32-bit-only builds on some
 *               supported handsets), so that mapping can never succeed;
 *   0x40000000  the peripheral bridge is ordinary user space, but the Android
 *               runtime reserves memory before any app code runs. On a moto
 *               g 5G (2023, Android 14) ART's "dalvik-free list large object
 *               space" sits at 0x32000000-0x42000000 in every process, so the
 *               soft key failed to start with "cannot map peripheral bridge at
 *               0x40000000: File exists" (2026-09-26). Another phone, another
 *               allocator, another collision - there is no address that is
 *               safe on every device.
 *
 * So both blocks are ordinary arrays owned by this library, and
 * scripts/stage.js rewrites every register in the staged kinetis.h to index
 * them (rewriteRegisterBlocks(): OKEMU_PBRIDGE(a), OKEMU_SCS(a)). The address
 * arithmetic still resolves at compile time, so the generated code is the
 * same shape it always was - it just points into memory the app owns.
 *
 * They are STATIC, not mmapped, for two reasons. They exist the moment the
 * library is loaded, before any C++ constructor - T3Mac.cpp reads SIM_UID*
 * from a file-scope initializer during dlopen (ok_hal.cpp seeds them first,
 * from a priority-101 constructor). And a static array cannot fail to map.
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
/* 0xE0000000 - 0xE00FFFFF: SCB, NVIC, SysTick, DWT. */
__attribute__((aligned(OKEMU_SCS_ALIGN)))
unsigned char okemu_scs_base[0x00100000];

/* 0x40000000 - 0x400FFFFF: FTFL, SIM, PORT, TSI, ADC, GPIO. */
__attribute__((aligned(OKEMU_SCS_ALIGN)))
unsigned char okemu_pbridge_base[0x00100000];
}
