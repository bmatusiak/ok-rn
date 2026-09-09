/*
 * ok_hal.cpp - see ok_hal.h for the design rationale.
 */
#include "ok_hal.h"

#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

#include <atomic>
#include <chrono>
#include <mutex>
#include <thread>
#include <condition_variable>
#include <deque>
#include <string>
#include <vector>

namespace {

/* ------------------------------------------------------------ regions */

struct Region { uintptr_t base; size_t len; const char *name; bool required; };

/*
 * Kinetis peripheral windows the firmware touches, plus the Cortex-M system
 * block. Backing them with anonymous memory is what lets kinetis.h be used
 * unmodified: FTFL_*, SIM_*, PORTx_PCR*, TSI0_* all become plain loads/stores.
 */
const Region kPeripherals[] = {
  { 0x40000000UL, 0x00100000UL, "peripheral bridge", true  }, /* FTFL, SIM, PORT, TSI, ADC */
  /*
   * The bit-band alias is 32 MB and the firmware never uses the bit-band
   * macros, so it is optional. Reserving that much fixed address space
   * regularly collided with V8's own heap - MAP_FIXED_NOREPLACE then returns
   * EEXIST and, because ASLR moves the heap each run, the daemon crash-looped
   * intermittently. Skip it when the address is taken.
   */
  { 0x42000000UL, 0x02000000UL, "bitband alias",     false },
  /*
   * The Cortex-M system block is NOT mapped on Android. 0xE0000000 is above
   * the 3 GB user/kernel split on 32-bit ARM, so the mapping is impossible
   * rather than merely contended. scripts/stage.js rewrites every register
   * in that window to index okemu_scs_base[] instead - see okemu_scs.cpp.
   */
};

/* Registers the firmware reads for identity/state, by absolute address. */
volatile uint32_t *reg32(uintptr_t a) { return (volatile uint32_t *)a; }
volatile uint8_t  *reg8 (uintptr_t a) { return (volatile uint8_t  *)a; }

const uintptr_t kSIM_SDID  = 0x40048024UL;
const uintptr_t kSIM_UIDH  = 0x40048054UL;
const uintptr_t kSIM_UIDMH = 0x40048058UL;
const uintptr_t kSIM_UIDML = 0x4004805CUL;
const uintptr_t kSIM_UIDL  = 0x40048060UL;
const uintptr_t kFTFL_FSTAT = 0x40020000UL;
const uintptr_t kFTFL_FSEC  = 0x40020002UL;  /* per kinetis.h:2350 */

/* ------------------------------------------------------------- state */

struct Hal {
  std::mutex mu;

  /* storage */
  std::string dir;
  uint8_t *flash = nullptr;     /* mapped at okemu_flash_base */
  int flash_fd = -1;
  size_t flash_mapped_off = 0;  /* first byte actually mapped (see init) */
  uint8_t eeprom[OKEMU_EEPROM_SIZE];
  int eeprom_fd = -1;

  /* time */
  uint64_t t0_us = 0;

  /* buttons */
  bool button[OKEMU_NUM_BUTTONS + 1] = { false };
  /* Samples still owed on a counted hold; 0 means "not counting". */
  int  ticks[OKEMU_NUM_BUTTONS + 1] = { 0 };
  /* Sense rounds completed since boot. Monotonic; never reset. */
  uint64_t rounds = 0;

  /* led */
  okemu_rgb px[OKEMU_NUM_PIXELS] = {};

  /* host -> device HID; each entry carries the interface it arrived on */
  struct InPkt { int iface; std::vector<uint8_t> data; };
  std::deque<InPkt> hid_in;
  std::condition_variable hid_cv;

  /* restart latch */
  bool restart = false;

  /* host -> device SEREMU (debug console input) */
  std::deque<uint8_t> seremu_in;

  /* sinks */
  okemu_stream_sink stream_sink = nullptr;  void *stream_ctx = nullptr;
  okemu_led_sink    led_sink    = nullptr;  void *led_ctx    = nullptr;
};

Hal g;

uint64_t now_us() {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000000ULL + (uint64_t)ts.tv_nsec / 1000ULL;
}

/* Open `name` under the storage dir at `size` bytes, creating it filled with
 * `fill` if absent. Returns an fd or -1. */
int open_backing(const std::string &dir, const char *name, size_t size,
                 uint8_t fill, char *err, size_t errlen) {
  std::string path = dir + "/" + name;
  int fd = ::open(path.c_str(), O_RDWR | O_CREAT, 0600);
  if (fd < 0) {
    snprintf(err, errlen, "cannot open %s: %s", path.c_str(), strerror(errno));
    return -1;
  }
  struct stat st;
  if (fstat(fd, &st) == 0 && (size_t)st.st_size != size) {
    if (ftruncate(fd, 0) != 0 || ftruncate(fd, (off_t)size) != 0) {
      snprintf(err, errlen, "cannot size %s: %s", path.c_str(), strerror(errno));
      ::close(fd);
      return -1;
    }
    /* A blank NOR flash / EEPROM array reads as 0xFF. */
    std::vector<uint8_t> blank(65536, fill);
    size_t left = size;
    while (left) {
      size_t n = left < blank.size() ? left : blank.size();
      if (write(fd, blank.data(), n) != (ssize_t)n) {
        snprintf(err, errlen, "cannot init %s: %s", path.c_str(), strerror(errno));
        ::close(fd);
        return -1;
      }
      left -= n;
    }
  }
  return fd;
}

/*
 * Peripheral mapping must happen before ANY static initializer in the
 * firmware runs, not when okemu_hal_init() is called.
 *
 * T3Mac.cpp has a file-scope initializer that dereferences registers directly:
 *     unsigned long chipNum[4] = { SIM_UIDH, SIM_UIDMH, SIM_UIDML, SIM_UIDL };
 * That runs during dlopen(), long before JS can call start(). Without the
 * mapping already in place the addon segfaults as it loads.
 *
 * A constructor priority below the default (65535) orders this ahead of every
 * C++ global constructor in the module. Priorities 0-100 are reserved for the
 * implementation, so 101 is the earliest slot available to us.
 *
 * Only the anonymous peripheral windows are set up here - they need no
 * configuration. The flash mapping is file-backed and needs the storage
 * directory, so it stays in okemu_hal_init(); nothing reads flash until
 * setup() runs.
 */
int g_map_status = -1;   /* 0 = mapped, -1 = not yet, >0 = errno */
char g_map_error[256] = "peripheral mapping never ran";

__attribute__((constructor(101)))
void okemu_map_peripherals(void) {
  for (const Region &r : kPeripherals) {
    void *p = mmap((void *)r.base, r.len, PROT_READ | PROT_WRITE,
                   MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE, -1, 0);
    if (p == MAP_FAILED || (uintptr_t)p != r.base) {
      if (p != MAP_FAILED) munmap(p, r.len);
      if (!r.required) {
        fprintf(stderr, "[okemu] note: %s at %#lx unavailable (%s) - skipped\n",
                r.name, (unsigned long)r.base, strerror(errno));
        continue;
      }
      g_map_status = errno ? errno : EFAULT;
      snprintf(g_map_error, sizeof g_map_error,
               "cannot map %s at %#lx: %s", r.name, (unsigned long)r.base,
               strerror(errno));
      return;
    }
  }

  /*
   * Identity registers must hold their values before chipNum's initializer
   * samples them. SIM_SDID's PINID nibble selects the hardware variant: the
   * firmware reads 5 as OK_HW_COLOR (the NeoPixel build) and 9 as OK_HW_DUO.
   */
  *reg32(kSIM_SDID) = 0x00000005;

  /* A stable fake 128-bit chip UID, so derived device keys are stable too. */
  *reg32(kSIM_UIDH)  = 0x4F4B454D; /* "OKEM" */
  *reg32(kSIM_UIDMH) = 0x554C4154; /* "ULAT" */
  *reg32(kSIM_UIDML) = 0x4F520001;
  *reg32(kSIM_UIDL)  = 0x00000001;

  /* CCIF set = "flash controller idle", so the firmware's wait loops exit. */
  *reg8(kFTFL_FSTAT) = 0x80;

  g_map_status = 0;
}

}  // namespace

/* ------------------------------------------------------------ sinks */

extern "C" {

void okemu_set_stream_sink(okemu_stream_sink fn, void *ctx) {
  std::lock_guard<std::mutex> lk(g.mu); g.stream_sink = fn; g.stream_ctx = ctx;
}
void okemu_set_led_sink(okemu_led_sink fn, void *ctx) {
  std::lock_guard<std::mutex> lk(g.mu); g.led_sink = fn; g.led_ctx = ctx;
}

/* One funnel for every interface and direction. Snapshots the sink under the
 * lock, then calls it unlocked - the sink hops to the JS thread and must not
 * run with the HAL mutex held. */
static void stream_emit(const uint8_t *data, size_t len, int iface, int dir) {
  okemu_stream_sink fn; void *ctx;
  {
    std::lock_guard<std::mutex> lk(g.mu);
    fn = g.stream_sink; ctx = g.stream_ctx;
  }
  if (fn) fn(data, len, iface, dir, ctx);
}

/* --------------------------------------------------------- lifecycle */

int okemu_hal_init(const char *storage_dir, char *err, size_t errlen) {
  g.dir = storage_dir ? storage_dir : ".";
  mkdir(g.dir.c_str(), 0700);

  /* 1. peripheral windows ---------------------------------------------
   * Already done by okemu_map_peripherals() during module load; here we only
   * surface a failure, since by now the firmware's static initializers have
   * run against whatever was (or wasn't) mapped. */
  if (g_map_status != 0) {
    snprintf(err, errlen, "%s", g_map_error);
    return -1;
  }

  /* 2. flash array, file-backed at its real address -------------------
   *
   * The firmware reads its own storage through raw pointers, and fw_hash()
   * walks from fwstartadr (0x6060). Mapping from 0 needs mmap_min_addr to be
   * lowered (or CAP_SYS_RAWIO). If we cannot, we still map everything from
   * mmap_min_addr up - which covers the whole storage area at 0x3A800 - and
   * mark the device as already provisioned so the one-time block that calls
   * fw_hash() never runs.
   */
  char e2[256];
  g.flash_fd = open_backing(g.dir, "flash.bin", OKEMU_FLASH_SIZE, 0xFF, e2, sizeof e2);
  if (g.flash_fd < 0) { snprintf(err, errlen, "%s", e2); return -1; }

  /*
   * mmap() treats addr==0 as "no hint" and picks an address of its own, even
   * with MAP_FIXED_NOREPLACE - so a request for base 0 can "succeed" somewhere
   * else entirely. Every mapping below is therefore checked against the
   * address we asked for, and anything else is unmapped and treated as a
   * failure.
   */
  /*
   * THE KERNEL PICKS THE ADDRESS. We only have to tell the firmware which.
   *
   * This used to ask for a fixed base with MAP_FIXED_NOREPLACE and walk a
   * couple of fallback offsets when that failed. Every one of those is a bet
   * that some particular address is free, and the bet is against whatever the
   * host runtime feels like mapping - which changes per device and per OS.
   * 0x44000000 was measured free on one handset and is ART's JIT zygote
   * cache on a Pixel 6a running Android 16:
   *
   *     44000000-46000000 r-xs  /memfd:jit-zygote-cache (deleted)
   *
   * so the firmware could not start at all, and the fallbacks could not help
   * because they are offsets INSIDE the array and land in the same range.
   *
   * Asking for NULL removes the bet. The firmware never sees the difference:
   * its address constants are all OKEMU_FLASH_BASE + offset, so the layout is
   * identical and only the origin moves - which is what the rebase in
   * scripts/stage.js was always for.
   *
   * It also retires the degraded mode this file used to warn about. The whole
   * 256 KB maps or nothing does, so certified_hw at +0x5BB0 is always present
   * and crypto can no longer half-work.
   */
  void *fp = mmap(nullptr, OKEMU_FLASH_SIZE, PROT_READ | PROT_WRITE,
                  MAP_SHARED, g.flash_fd, 0);
  if (fp == MAP_FAILED) {
    snprintf(err, errlen, "cannot map flash: %s", strerror(errno));
    return -1;
  }
  okemu_flash_base = (uintptr_t)fp;
  g.flash = (uint8_t *)okemu_flash_base;
  /* Nothing is ever skipped now, but the field stays: msync/munmap below
   * are written in terms of it, and a zero says plainly that the whole
   * array is mapped. */
  g.flash_mapped_off = 0;

  /* 3. EEPROM --------------------------------------------------------- */
  g.eeprom_fd = open_backing(g.dir, "eeprom.bin", OKEMU_EEPROM_SIZE, 0xFF, e2, sizeof e2);
  if (g.eeprom_fd < 0) { snprintf(err, errlen, "%s", e2); return -1; }
  if (pread(g.eeprom_fd, g.eeprom, OKEMU_EEPROM_SIZE, 0) != OKEMU_EEPROM_SIZE)
    memset(g.eeprom, 0xFF, OKEMU_EEPROM_SIZE);

  /*
   * FSEC != 0x44 sends the firmware through its one-time provisioning path
   * (device-key derivation + fw_hash + lock). That path is only safe when the
   * whole flash array including fwstartadr (0x6060) is mapped - and now it
   * always is, because the kernel places the mapping and nothing is skipped.
   *
   * This used to read `low_mapped ? 0xFF : 0x44`, and the 0x44 was the
   * dangerous half: it told the firmware it was ALREADY provisioned so that
   * it would not walk into unmapped memory. The device then booted, answered
   * HID and reported its real version while being unable to do any crypto -
   * the silent degraded mode of FINDING-emu-degraded-mode-is-silent.md. With
   * a full mapping guaranteed there is no such state to hide.
   */
  *(volatile uint8_t *)kFTFL_FSEC = 0xFF;

  okemu_time_start();
  okemu_systick_start();   /* millis() must advance without the firmware asking */
  return 0;
}

/*
 * The SysTick tick.
 *
 * millis() is a static inline in core_pins.h that reads systick_millis_count
 * directly, so the only way to make it advance is to advance that counter. On
 * the MK20DX256 the SysTick interrupt does it at 1 kHz, completely
 * independently of what the main loop happens to be executing.
 *
 * Feeding it from micros() instead - as this did originally - looks equivalent
 * only while every waiting loop also polls micros(). payload() does not:
 *
 *     unsigned long wait = millis() + 200;
 *     while (millis() < wait) { recvmsg(0); }   // never calls micros()
 *
 * That loop runs on the successful-unlock path. With the counter frozen it
 * never terminated: RawHID kept being serviced from inside the loop, so the
 * device still answered status queries and looked healthy, while checkKey()
 * never returned and touch_sense_loop() - and with it the whole SEREMU debug
 * channel and every button - was dead from the moment the PIN was accepted.
 *
 * A dedicated thread is the honest emulation of a hardware timer interrupt.
 */
static std::thread      g_systick_thread;
static std::atomic<bool> g_systick_run{false};

void okemu_systick_start(void) {
  if (g_systick_run.exchange(true)) return;
  okemu_sync_systick();               /* don't start from zero */
  g_systick_thread = std::thread([] {
    while (g_systick_run.load(std::memory_order_relaxed)) {
      okemu_sync_systick();
      struct timespec t = { 0, 500000L };   /* 500 us - twice SysTick's rate */
      nanosleep(&t, NULL);
    }
  });
}

void okemu_systick_stop(void) {
  if (!g_systick_run.exchange(false)) return;
  if (g_systick_thread.joinable()) g_systick_thread.join();
}

void okemu_hal_shutdown(void) {
  okemu_systick_stop();
  if (g.eeprom_fd >= 0) {
    pwrite(g.eeprom_fd, g.eeprom, OKEMU_EEPROM_SIZE, 0);
    ::close(g.eeprom_fd);
    g.eeprom_fd = -1;
  }
  if (g.flash) {
    msync((void *)(OKEMU_FLASH_BASE + g.flash_mapped_off),
          OKEMU_FLASH_SIZE - g.flash_mapped_off, MS_SYNC);
    /*
     * Unmap, do not just sync.
     *
     * Upstream leaves the mapping in place because a restart there is a
     * PROCESS restart - pm2 respawns the daemon and the address space goes
     * with it. Hosted in an app the process outlives the firmware, so a
     * mapping left behind makes the next okemu_hal_init() fail with EEXIST
     * from MAP_FIXED_NOREPLACE, reported as "cannot map flash: File exists".
     */
    munmap((void *)(OKEMU_FLASH_BASE + g.flash_mapped_off),
           OKEMU_FLASH_SIZE - g.flash_mapped_off);
    g.flash = nullptr;
    g.flash_mapped_off = 0;
  }
  if (g.flash_fd >= 0) { ::close(g.flash_fd); g.flash_fd = -1; }
}

void okemu_factory_reset(void) {
  std::lock_guard<std::mutex> lk(g.mu);
  if (g.flash) {
    memset((void *)(OKEMU_FLASH_BASE + g.flash_mapped_off), 0xFF,
           OKEMU_FLASH_SIZE - g.flash_mapped_off);
    msync((void *)(OKEMU_FLASH_BASE + g.flash_mapped_off),
          OKEMU_FLASH_SIZE - g.flash_mapped_off, MS_SYNC);
  }
  memset(g.eeprom, 0xFF, OKEMU_EEPROM_SIZE);
  if (g.eeprom_fd >= 0) pwrite(g.eeprom_fd, g.eeprom, OKEMU_EEPROM_SIZE, 0);
  g.restart = true;
}

int  okemu_restart_requested(void) { std::lock_guard<std::mutex> lk(g.mu); return g.restart; }
void okemu_clear_restart(void)     { std::lock_guard<std::mutex> lk(g.mu); g.restart = false; }
void okemu_request_restart(void)   { std::lock_guard<std::mutex> lk(g.mu); g.restart = true; }

/* -------------------------------------------------------------- time */

void okemu_time_start(void) { g.t0_us = now_us(); }

uint32_t okemu_micros(void) { return (uint32_t)(now_us() - g.t0_us); }

void okemu_delay_ms(uint32_t ms) {
  struct timespec ts;
  ts.tv_sec  = ms / 1000;
  ts.tv_nsec = (long)(ms % 1000) * 1000000L;
  nanosleep(&ts, nullptr);
  okemu_sync_systick();
}

/*
 * Where the flash array landed. Declared in okemu_flash_base.h, which is
 * force-included everywhere so the firmware's own constants can be written
 * in terms of it. Zero until okemu_hal_init() has mapped the file.
 */
extern "C" uintptr_t okemu_flash_base = 0;

/* ----------------------------------------------------------- buttons */

/*
 * THE PIN ORDER IS NOT THE BUTTON ORDER. setup() assigns TOUCHPIN1..6 = pins
 * 1, 22, 23, 17, 15, 16 (OnlyKey.ino:268-273), but okcore.cpp:2574-2628 then
 * labels those pads in a DIFFERENT order - touchread1 is button 5 and
 * touchread3 is button 1:
 *
 *     touchread1 (pin  1) -> button 5      touchread4 (pin 17) -> button 3
 *     touchread2 (pin 22) -> button 2      touchread5 (pin 15) -> button 4
 *     touchread3 (pin 23) -> button 1      touchread6 (pin 16) -> button 6
 *
 * This table is indexed by BUTTON, which is what a caller means: the digits of
 * a PIN are button numbers, and so is a Confirm control. Seeding it with the
 * TOUCHPIN order instead - the obvious mistake, since the two lists hold the
 * same six pins - makes okemu_set_button(1) arrive as a press of button 5.
 * Measured, not reasoned about: the firmware answered a tap on 1 with
 * "password appended with 5".
 */
static const uint8_t kPinForButton[OKEMU_NUM_BUTTONS] = { 23, 22, 17, 15, 1, 16 };

/*
 * The pad rngloop() samples LAST in a round, and therefore the moment at which
 * one iteration of the sense path has fully observed the button state.
 *
 * touch_sense_loop() opens with rngloop() (okcore.cpp:2536), which reads
 * TOUCHPIN1, 2, 5, then 3, 4, 6 (okcore.cpp:2762-2775) - pin 16 last - and the
 * loop then evaluates those six globals and does key_on += 1. So one round of
 * touchRead() calls is exactly one tick of the firmware's own press counter,
 * and pin 16 is where a round ends.
 */
static const uint8_t kLastPinInRound = 16;

void okemu_set_button(int n, int down) {
  if (n < 1 || n > OKEMU_NUM_BUTTONS) return;
  std::lock_guard<std::mutex> lk(g.mu);
  g.button[n] = down != 0;
  g.ticks[n] = 0;          /* an explicit hold outranks a counted one */
}

int okemu_get_button(int n) {
  if (n < 1 || n > OKEMU_NUM_BUTTONS) return 0;
  std::lock_guard<std::mutex> lk(g.mu);
  return g.button[n] ? 1 : 0;
}

/*
 * Hold a button for a COUNT OF MAIN-LOOP ITERATIONS rather than for a wall
 * time, then release it.
 *
 * The firmware bands a press by how many iterations of touch_sense_loop() saw
 * the pad held - key_on += 1 per iteration, handed to payload() as the
 * duration argument (OnlyKey.ino:522,631) - and nothing in that path consults
 * a clock:
 *
 *     duration <= 20         gen_press()   types slot N
 *     duration 21 .. 89      gen_hold()    types slot N+6, the b profile
 *     duration >= 90         rejected, blink only
 *
 * and, above them and reached FIRST because each of those branches returns
 * before the band dispatch (OnlyKey.ino:873-914):
 *
 *     duration >= 72, button 1   backup()
 *     duration >= 72, button 2   get_key_labels()
 *     duration >= 72, button 3   lock + CPU_RESTART()
 *     duration >= 72, button 6   config mode
 *
 * So the only safe window for a b-profile read is 21..71, and asking for it in
 * milliseconds is a bet on how fast this particular handset runs the loop - a
 * number that has never been measured, and that differs per device, per build
 * and per whatever else the phone is doing. Overshooting does not fail
 * cleanly: it takes a backup, or restarts the key.
 *
 * Counting the samples ourselves removes the bet. N ticks is N iterations on
 * any device, so the band is a property of the call rather than of the timing.
 *
 * The one caveat, stated because it is invisible otherwise: rngloop() also
 * runs from calibration (okcore.cpp:6156) and from RNG2()'s entropy spin
 * (okcore.cpp:7637), and a round from either ages the counters without the
 * sense loop counting a tick. Neither overlaps a deliberate hold - both run
 * synchronously on the firmware thread, calibration at startup and RNG2 during
 * payload processing, which is after the release - but a hold that spanned one
 * would come out SHORT rather than long, i.e. it errs downward, away from the
 * destructive bands.
 */
void okemu_set_button_ticks(int n, int ticks) {
  if (n < 1 || n > OKEMU_NUM_BUTTONS) return;
  std::lock_guard<std::mutex> lk(g.mu);
  if (ticks <= 0) { g.button[n] = false; g.ticks[n] = 0; return; }
  g.button[n] = true;
  g.ticks[n] = ticks;
}

int okemu_button_ticks_left(int n) {
  if (n < 1 || n > OKEMU_NUM_BUTTONS) return 0;
  std::lock_guard<std::mutex> lk(g.mu);
  return g.ticks[n];
}

/*
 * Sense rounds completed since boot.
 *
 * Exposed because A RELEASE IS NOT A GAP IN TIME, it is a count of rounds in
 * which nothing was held, and a caller that wants two presses to arrive as two
 * presses has to be able to wait for them.
 *
 * touch_sense_loop() credits at most ONE pad per round - the branches are
 * else-ifs - and every one of them does key_off = 0 and key_on += 1
 * (okcore.cpp:2574-2628). A press is emitted only once key_off > 2
 * (okcore.cpp:2723), i.e. after three rounds in which no pad read as touched.
 * So two counted holds with no idle round between them are not two presses at
 * all: key_on keeps climbing across both, button_selected ends up as whichever
 * was seen last, and what payload() finally receives is ONE press whose
 * duration is the sum. Seven ten-tick taps become a single seventy-tick hold -
 * and eight of them clear 72, which on button 1 is backup() and on button 3 is
 * lock and CPU_RESTART().
 *
 * Counted in rounds rather than measured in milliseconds for the same reason
 * the holds are: the firmware never consults a clock, and how long a round
 * takes is a property of the handset. See
 * FINDING-counted-presses-merge-without-an-idle-gap.md.
 */
uint64_t okemu_rounds(void) {
  std::lock_guard<std::mutex> lk(g.mu);
  return g.rounds;
}

/*
 * The firmware baselines each pad at rest and treats a large positive excursion
 * as a touch, so we report a low idle value and a high one while held.
 */
int okemu_touch_for_pin(uint8_t pin) {
  std::lock_guard<std::mutex> lk(g.mu);

  bool held = false;
  for (int i = 0; i < OKEMU_NUM_BUTTONS; i++) {
    if (kPinForButton[i] == pin) { held = g.button[i + 1]; break; }
  }

  /*
   * Report first, age the counters after.
   *
   * The last tick of a hold must still read as HELD for the round it retires
   * in, or the sense loop counts one fewer iteration than was asked for - and
   * a one-tick hold, the smallest thing anyone can ask for, would be observed
   * as no press at all. Releasing here takes effect from the next round.
   */
  if (pin == kLastPinInRound) {
    for (int n = 1; n <= OKEMU_NUM_BUTTONS; n++) {
      if (g.ticks[n] > 0 && --g.ticks[n] == 0) g.button[n] = false;
    }
    g.rounds++;
  }

  return held ? 6000 : 1000;
}

/* --------------------------------------------------------------- LED */

void okemu_led_set(int index, uint8_t r, uint8_t g_, uint8_t b) {
  if (index < 0 || index >= OKEMU_NUM_PIXELS) return;
  std::lock_guard<std::mutex> lk(g.mu);
  g.px[index].r = r; g.px[index].g = g_; g.px[index].b = b;
}

void okemu_led_show(void) {
  okemu_led_sink fn; void *ctx; okemu_rgb snap[OKEMU_NUM_PIXELS];
  {
    std::lock_guard<std::mutex> lk(g.mu);
    fn = g.led_sink; ctx = g.led_ctx;
    memcpy(snap, g.px, sizeof snap);
  }
  if (fn) fn(snap, OKEMU_NUM_PIXELS, ctx);
}

/* ------------------------------------------------------------ RawHID */

int okemu_hid_deliver(const uint8_t *data, size_t len, int iface) {
  if (iface == OKEMU_IFACE_SEREMU) {
    /* Debug console input: bytes, not 64-byte reports. */
    {
      std::lock_guard<std::mutex> lk(g.mu);
      for (size_t i = 0; i < len; i++) g.seremu_in.push_back(data[i]);
    }
    stream_emit(data, len, OKEMU_IFACE_SEREMU, OKEMU_DIR_IN);
    return 0;
  }
  if (iface != OKEMU_IFACE_FIDO && iface != OKEMU_IFACE_VENDOR)
    return -1;   /* keyboard is device -> host only */

  Hal::InPkt pkt;
  pkt.iface = iface;
  pkt.data.assign(64, 0);
  memcpy(pkt.data.data(), data, len < 64 ? len : 64);

  /*
   * Snapshot before handing the packet to the queue: push_back(std::move(pkt))
   * leaves pkt.data empty, so reading pkt.data.data() afterwards dereferences
   * null and takes the process down. Every inbound RawHID report hit this.
   */
  uint8_t snap[64];
  memcpy(snap, pkt.data.data(), 64);

  {
    std::lock_guard<std::mutex> lk(g.mu);
    g.hid_in.push_back(std::move(pkt));
  }
  g.hid_cv.notify_one();
  stream_emit(snap, sizeof snap, iface, OKEMU_DIR_IN);
  return 0;
}

/*
 * Mirrors OnlyKey-Firmware/usb_rawhid.c: drain the FIDO endpoint first, then
 * the vendor one, and return WHICH interface produced the packet. Returning a
 * byte count here would make the firmware reply on the wrong interface.
 */
int okemu_hid_recv(void *buf, uint32_t timeout) {
  std::unique_lock<std::mutex> lk(g.mu);
  if (g.hid_in.empty()) {
    if (timeout == 0) return 0;
    g.hid_cv.wait_for(lk, std::chrono::milliseconds(timeout),
                      [] { return !g.hid_in.empty(); });
    if (g.hid_in.empty()) return 0;
  }
  /* Prefer a FIDO packet if one is queued, matching the endpoint poll order. */
  auto it = g.hid_in.begin();
  for (auto i = g.hid_in.begin(); i != g.hid_in.end(); ++i) {
    if (i->iface == OKEMU_IFACE_FIDO) { it = i; break; }
  }
  memcpy(buf, it->data.data(), 64);
  int iface = it->iface;
  g.hid_in.erase(it);
  return iface;
}

int okemu_hid_pending(void) {
  std::lock_guard<std::mutex> lk(g.mu);
  int n = 0;
  for (const auto &p : g.hid_in)
    if (p.iface == OKEMU_IFACE_FIDO) n += 64;
  return n;
}

void okemu_hid_flush_in(void) {
  std::lock_guard<std::mutex> lk(g.mu);
  g.hid_in.clear();
}

int okemu_hid_emit(const uint8_t *data, size_t len, uint32_t /*timeout*/, int iface) {
  stream_emit(data, len, iface, OKEMU_DIR_OUT);
  return (int)len;
}

/* ---------------------------------------------------------- keyboard */

void okemu_kbd_emit(const uint8_t *report8) {
  stream_emit(report8, 8, OKEMU_IFACE_KEYBOARD, OKEMU_DIR_OUT);
}

/* --------------------------------------------------------------- log */

void okemu_log(const uint8_t *data, size_t len) {
  stream_emit(data, len, OKEMU_IFACE_SEREMU, OKEMU_DIR_OUT);
}

/* --- SEREMU input, backing Serial.read() on the firmware side --- */

int okemu_seremu_getc(void) {
  std::lock_guard<std::mutex> lk(g.mu);
  if (g.seremu_in.empty()) return -1;
  int c = g.seremu_in.front();
  g.seremu_in.pop_front();
  return c;
}

int okemu_seremu_peek(void) {
  std::lock_guard<std::mutex> lk(g.mu);
  return g.seremu_in.empty() ? -1 : g.seremu_in.front();
}

int okemu_seremu_avail(void) {
  std::lock_guard<std::mutex> lk(g.mu);
  return (int)g.seremu_in.size();
}

void okemu_seremu_flush_in(void) {
  std::lock_guard<std::mutex> lk(g.mu);
  g.seremu_in.clear();
}

/* EEPROM backing, used by the eeprom override. */
uint8_t okemu_eeprom_read(uint32_t addr) {
  if (addr >= OKEMU_EEPROM_SIZE) return 0xFF;
  std::lock_guard<std::mutex> lk(g.mu);
  return g.eeprom[addr];
}

void okemu_eeprom_write(uint32_t addr, uint8_t v) {
  if (addr >= OKEMU_EEPROM_SIZE) return;
  std::lock_guard<std::mutex> lk(g.mu);
  if (g.eeprom[addr] == v) return;
  g.eeprom[addr] = v;
  if (g.eeprom_fd >= 0) pwrite(g.eeprom_fd, &v, 1, (off_t)addr);
}

/* ----------------------------------------------------------- entropy */

void okemu_random_bytes(uint8_t *out, size_t len) {
  static int fd = -1;
  if (fd < 0) fd = ::open("/dev/urandom", O_RDONLY);
  if (fd >= 0) {
    size_t got = 0;
    while (got < len) {
      ssize_t n = ::read(fd, out + got, len - got);
      if (n <= 0) break;
      got += (size_t)n;
    }
    if (got == len) return;
  }
  /* /dev/urandom is effectively always available; this only guards against a
   * pathological fd exhaustion so the caller still gets varying bytes. */
  for (size_t i = 0; i < len; i++)
    out[i] = (uint8_t)(now_us() >> ((i % 8) * 8));
}

}  // extern "C"
