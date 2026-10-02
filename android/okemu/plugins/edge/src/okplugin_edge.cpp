/*
 * edge - step 1: the device chain, its storage, its identity (DESIGN.md 1-3, 5).
 *
 * Every sign/decrypt decision (approve, deny, timeout) becomes a 64-byte link
 * welded into a SHA-256 chain whose head this key keeps. The BYTES are the
 * contract with node-onlykey-lib/edge (codes.js, chain.js) and its Python
 * vectors: a link written here must verify there, so every format choice
 * below names the lib function it must match.
 *
 * Soft key and desktop emulator only. The storage lives in flash the real
 * device uses for something else (0x1000-0x57FF is the bootloader's area on a
 * Teensy); on the emulators that range is file-backed, unused and outside the
 * firmware hash - so this plugin must never be built for a hard key.
 */
#include "onlykey.h"
#include "okplugin_edge.h"
#include "sha256.h"
#include "uECC.h"
#include <string.h>

extern uint8_t packet_buffer_details[5];
extern uint8_t profilemode;
extern uint8_t ecc_private_key[];
extern uint8_t ecc_public_key[];
extern uint8_t type;
extern int okeeprom_eeget_ecckey(uint8_t *ptr, int slot);
extern void okcrypto_hkdf_info(const void *salt, const void *inputKey, void *outputKey, const size_t L,
    const uint8_t *info, size_t info_len);

/* ------------------------------------------------------------ the format (lib codes.js) */

#define OP_SIGN 1
#define OP_DECRYPT 2
#define OP_WIPE 12
#define FLAG_PRESS_OBSERVED 0x01
#define FLAG_PREV_NO_TICKET 0x04

#define SEQ_NONE 0xFFFFFFFFUL
#define LINK_BYTES 64
#define HEAD_BYTES 32
#define ID_BYTES 16

/* ------------------------------------------------------------ storage (DESIGN.md 2) */

/* base + 0x1000: derived from the firmware's own constant so it follows OKEMU_FLASH_BASE */
#define EDGE_REGION ((uintptr_t)factorysectoradr - 0x4800)
#define EDGE_STATE_A (EDGE_REGION + 0x0000)
#define EDGE_STATE_B (EDGE_REGION + 0x0800)
#define EDGE_RING (EDGE_REGION + 0x1000)
#define RING_N 32
#define RING_PER_SECTOR 16
#define ENTRY_BYTES (LINK_BYTES + HEAD_BYTES)
#define SECTOR_BYTES 0x800

#define STATE_BYTES 160
static const uint8_t MAGIC[8] = {'O', 'K', 'E', 'D', 'G', 'E', '0', '1'};

#define SF_WIPED 0x01 /* the next link records a wipe (R9) */

struct edge_state {
  uint32_t gen;
  uint32_t seq;              /* SEQ_NONE = no link yet */
  uint8_t head[HEAD_BYTES];  /* head[seq]; the genesis while seq == SEQ_NONE */
  uint8_t device_id[ID_BYTES];
  uint8_t pub[64];           /* the Edge public key, X||Y */
  uint32_t flags;
  uint8_t has_id;
};

static struct edge_state st;
static uint8_t loaded = 0;

/* what the confirmation that is waiting for its decision is about */
static struct {
  uint8_t active;
  uint8_t opcode;
  uint8_t slot;
  uint8_t press;
  uint8_t subject[32];
} pend;

static void put32(uint8_t *p, uint32_t v) {
  p[0] = v & 0xff; p[1] = (v >> 8) & 0xff; p[2] = (v >> 16) & 0xff; p[3] = (v >> 24) & 0xff;
}
static uint32_t get32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

/* SHA-256 over an ASCII tag and up to three byte strings (lib hash.js H) */
static void H(uint8_t out[32], const char *tag, const uint8_t *a, size_t al,
    const uint8_t *b, size_t bl, const uint8_t *c, size_t cl) {
  SHA256_CTX ctx;
  sha256_init(&ctx);
  if (tag) sha256_update(&ctx, (const unsigned char *)tag, strlen(tag));
  if (a) sha256_update(&ctx, a, al);
  if (b) sha256_update(&ctx, b, bl);
  if (c) sha256_update(&ctx, c, cl);
  sha256_final(&ctx, out);
}

static void flash_read(uint8_t *buf, uintptr_t adr, int len) {
  okcore_flashget_common(buf, (unsigned long *)adr, len);
}
/* erase the sector at adr and write len bytes (a multiple of 4) */
static void flash_write(uint8_t *buf, uintptr_t adr, int len) {
  okcore_flashsector(buf, (unsigned long *)adr, len);
}

static void state_encode(uint8_t rec[STATE_BYTES], const struct edge_state *s) {
  memset(rec, 0, STATE_BYTES);
  memcpy(rec, MAGIC, 8);
  put32(rec + 8, s->gen);
  put32(rec + 12, s->seq);
  memcpy(rec + 16, s->head, 32);
  memcpy(rec + 48, s->device_id, 16);
  memcpy(rec + 64, s->pub, 64);
  put32(rec + 128, s->flags);
  rec[132] = s->has_id;
  uint8_t check[32];
  H(check, NULL, rec, 148, NULL, 0, NULL, 0);
  memcpy(rec + 148, check, 4);
}

static int state_decode(const uint8_t rec[STATE_BYTES], struct edge_state *s) {
  if (memcmp(rec, MAGIC, 8) != 0) return 0;
  uint8_t check[32];
  H(check, NULL, rec, 148, NULL, 0, NULL, 0);
  if (memcmp(rec + 148, check, 4) != 0) return 0; /* torn write: the other copy wins */
  s->gen = get32(rec + 8);
  s->seq = get32(rec + 12);
  memcpy(s->head, rec + 16, 32);
  memcpy(s->device_id, rec + 48, 16);
  memcpy(s->pub, rec + 64, 64);
  s->flags = get32(rec + 128);
  s->has_id = rec[132];
  return 1;
}

/* double-buffered: write the OTHER sector, so a crash mid-write keeps the old state */
static void state_save(void) {
  uint8_t rec[STATE_BYTES];
  st.gen++;
  state_encode(rec, &st);
  flash_write(rec, (st.gen & 1) ? EDGE_STATE_B : EDGE_STATE_A, STATE_BYTES);
}

static void state_load(void) {
  if (loaded) return;
  uint8_t rec[STATE_BYTES];
  struct edge_state a, b;
  int ha, hb;
  flash_read(rec, EDGE_STATE_A, STATE_BYTES);
  ha = state_decode(rec, &a);
  flash_read(rec, EDGE_STATE_B, STATE_BYTES);
  hb = state_decode(rec, &b);
  if (ha && (!hb || a.gen > b.gen)) st = a;
  else if (hb) st = b;
  else {
    memset(&st, 0, sizeof(st));
    st.seq = SEQ_NONE;
  }
  loaded = 1;
}

/* ------------------------------------------------------------ identity (DESIGN.md 1) */

/*
 * The Edge key: HKDF(K132, info "onlykey/edge/v1"), P-256. K132 is the key's
 * own secret (made at PIN setup, in the backup), so the identity survives a
 * restore and changes with a wipe. Loading K132 goes through the firmware's
 * ECC globals, which a pending sign may be using - they are saved and put back.
 */
static int edge_private_key(uint8_t priv[32]) {
  uint8_t t = 0;
  if (profilemode == NONENCRYPTEDPROFILE) return 0;
  okeeprom_eeget_ecckey(&t, 132);
  if (t == 0) return 0; /* no K132: no PIN set yet */
  uint8_t save_priv[32], save_pub[65], save_type = type;
  memcpy(save_priv, ecc_private_key, 32);
  memcpy(save_pub, ecc_public_key, 65);
  int ok = okcore_flashget_ECC(132) != 0;
  if (ok) {
    static const char INFO[] = "onlykey/edge/v1";
    okcrypto_hkdf_info(NULL, ecc_private_key, priv, 32, (const uint8_t *)INFO, sizeof(INFO) - 1);
  }
  memcpy(ecc_private_key, save_priv, 32);
  memcpy(ecc_public_key, save_pub, 65);
  type = save_type;
  memset(save_priv, 0, 32);
  return ok;
}

/* the identity and the genesis, once; 0 if the key has no K132 yet */
static int ensure_identity(void) {
  state_load();
  if (st.has_id) return 1;
  uint8_t priv[32];
  if (!edge_private_key(priv)) return 0;
  int ok = uECC_compute_public_key(priv, st.pub, uECC_secp256r1());
  memset(priv, 0, 32);
  if (!ok) return 0;
  uint8_t h[32];
  H(h, "OKEDGE-DEVICE-v1", st.pub, 64, NULL, 0, NULL, 0);
  memcpy(st.device_id, h, ID_BYTES);
  /* head[-1] = SHA256("OKEDGE-GENESIS-v1" || device_id)  (lib chain.genesis) */
  H(st.head, "OKEDGE-GENESIS-v1", st.device_id, ID_BYTES, NULL, 0, NULL, 0);
  st.seq = SEQ_NONE;
  st.has_id = 1;
  state_save();
  return 1;
}

/* ------------------------------------------------------------ the chain (DESIGN.md 3) */

static uint32_t ring_from(void) {
  if (st.seq == SEQ_NONE) return 0;
  return st.seq >= RING_N - 1 ? st.seq - (RING_N - 1) : 0;
}

static void ring_put(uint32_t seq, const uint8_t link[LINK_BYTES], const uint8_t head[HEAD_BYTES]) {
  uint32_t i = seq % RING_N;
  uintptr_t sector = EDGE_RING + (i / RING_PER_SECTOR) * SECTOR_BYTES;
  uint8_t buf[RING_PER_SECTOR * ENTRY_BYTES];
  flash_read(buf, sector, sizeof(buf));
  uint8_t *e = buf + (i % RING_PER_SECTOR) * ENTRY_BYTES;
  memcpy(e, link, LINK_BYTES);
  memcpy(e + LINK_BYTES, head, HEAD_BYTES);
  flash_write(buf, sector, sizeof(buf));
}

static void ring_get(uint32_t seq, uint8_t link[LINK_BYTES], uint8_t head[HEAD_BYTES]) {
  uint32_t i = seq % RING_N;
  uintptr_t adr = EDGE_RING + (i / RING_PER_SECTOR) * SECTOR_BYTES + (i % RING_PER_SECTOR) * ENTRY_BYTES;
  uint8_t e[ENTRY_BYTES];
  flash_read(e, adr, ENTRY_BYTES);
  memcpy(link, e, LINK_BYTES);
  memcpy(head, e + LINK_BYTES, HEAD_BYTES);
}

/* the latest link is a use with no ticket - R17's empty hook (tickets come in step 3) */
static int prev_owes_ticket(void) {
  if (st.seq == SEQ_NONE) return 0;
  uint8_t link[LINK_BYTES], head[HEAD_BYTES];
  ring_get(st.seq, link, head);
  return (link[4] == OP_SIGN || link[4] == OP_DECRYPT) && link[5] == OKEDGE_DECISION_APPROVE;
}

/*
 * Append one link: encode it (lib chain.encodeLink), weld it
 *   head[n] = SHA256("OKEDGE-LINK-v1" || head[n-1] || link[n])   (lib chain.weld)
 * and persist ring entry, then state - R4: (seq, head) is on flash BEFORE the
 * operation's result is released (the approve hook runs before the sign).
 */
static void append(uint8_t op, uint8_t decision, uint8_t slot, uint8_t flags, const uint8_t subject[32]) {
  uint8_t link[LINK_BYTES];
  memset(link, 0, sizeof(link));
  uint32_t seq = st.seq == SEQ_NONE ? 0 : st.seq + 1;
  put32(link, seq);
  link[4] = op;
  link[5] = decision;
  link[6] = slot;
  link[7] = flags;
  memcpy(link + 8, subject, 32);
  /* grant_id, grant_step, reserved: zero until budgets (step 2) */
  uint8_t head[HEAD_BYTES];
  H(head, "OKEDGE-LINK-v1", st.head, HEAD_BYTES, link, LINK_BYTES, NULL, 0);
  ring_put(seq, link, head);
  st.seq = seq;
  memcpy(st.head, head, HEAD_BYTES);
  state_save();
}

/* a wiped key's chain starts with a wipe link (R9), once it has an identity again */
static void first_link_after_wipe(void) {
  if (!(st.flags & SF_WIPED)) return;
  uint8_t zero[32];
  memset(zero, 0, sizeof(zero));
  st.flags &= ~SF_WIPED;
  append(OP_WIPE, OKEDGE_DECISION_APPROVE, 0, 0, zero);
}

/* ------------------------------------------------------------ hooks */

void okplugin_edge_primed(uint8_t opcode, uint8_t slot, const uint8_t *msg, size_t msg_len) {
  pend.active = 0;
  if (opcode != OKSIGN && opcode != OKDECRYPT) return;
  pend.active = 1;
  pend.opcode = opcode;
  pend.slot = slot;
  pend.press = user_input_mode != USER_INPUT_NONE;
  /* the link's subject: SHA-256 of exactly what was submitted for approval */
  H(pend.subject, NULL, msg, msg_len, NULL, 0, NULL, 0);
}

void okplugin_edge_decision(int decision) {
  if (!pend.active) return;
  if (decision == OKEDGE_DECISION_APPROVE && packet_buffer_details[0] != pend.opcode) return;
  pend.active = 0;
  if (!ensure_identity()) return; /* no K132 yet: nothing to chain to */
  first_link_after_wipe();
  uint8_t flags = 0;
  if (decision == OKEDGE_DECISION_APPROVE && pend.press) flags |= FLAG_PRESS_OBSERVED;
  if (prev_owes_ticket()) flags |= FLAG_PREV_NO_TICKET;
  append(pend.opcode == OKSIGN ? OP_SIGN : OP_DECRYPT, (uint8_t)decision, pend.slot, flags, pend.subject);
}

/*
 * wipeflashdata(): erase the region, then leave one state record that says
 * "wiped" - the new identity (a new K132 after the new PIN) starts its chain
 * with a wipe link.
 */
void okplugin_edge_wipe(void) {
  uint8_t blank[4] = {0xff, 0xff, 0xff, 0xff};
  for (uintptr_t s = EDGE_REGION; s < EDGE_RING + 2 * SECTOR_BYTES; s += SECTOR_BYTES) {
    flash_write(blank, s, 4);
  }
  memset(&st, 0, sizeof(st));
  st.seq = SEQ_NONE;
  st.flags = SF_WIPED;
  loaded = 1;
  pend.active = 0;
  state_save();
}

/* ------------------------------------------------------------ OKEDGE (DESIGN.md 5) */

static void reply(const uint8_t *data, int len) {
  uint8_t r[64];
  memset(r, 0, sizeof(r));
  memcpy(r, data, len > 64 ? 64 : len);
  send_transport_response(r, 64, false, false);
}

void okplugin_edge_recv(uint8_t *buffer) {
  if (!(initialized == true && unlocked == true && configmode == false)) return;
  if (!ensure_identity()) {
    hidprint("Error Edge needs a key with a PIN set");
    return;
  }
  first_link_after_wipe();
  uint8_t r[64];
  memset(r, 0, sizeof(r));
  switch (buffer[5]) {
    case OKEDGE_HEAD: {
      /* seq (SEQ_NONE = empty) . head (the genesis while empty) . ringFrom . device_id */
      put32(r, st.seq);
      memcpy(r + 4, st.head, 32);
      put32(r + 36, ring_from());
      memcpy(r + 40, st.device_id, ID_BYTES);
      reply(r, 56);
      return;
    }
    case OKEDGE_READ: {
      /* from u32 . count u8 (<= 8); per link two reports: the link, then its head */
      uint32_t from = get32(buffer + 6);
      uint8_t count = buffer[10];
      if (count > 8) count = 8;
      if (st.seq == SEQ_NONE || from > st.seq || from < ring_from()) {
        hidprint("Error Edge seq not in the ring");
        return;
      }
      for (uint32_t s = from; s <= st.seq && s < from + count; s++) {
        uint8_t link[LINK_BYTES], head[HEAD_BYTES];
        ring_get(s, link, head);
        reply(link, LINK_BYTES);
        reply(head, HEAD_BYTES);
      }
      return;
    }
    case OKEDGE_CKPT_PUBKEY:
      reply(st.pub, 64);
      return;
    default:
      hidprint("Error Edge unknown request");
      return;
  }
}
