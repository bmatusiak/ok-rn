/*
 * edge - the minimal firmware half of OnlyKey Edge: the key is a NOTARY
 * (DESIGN.md section 0; owner, 2026-10-02: "the smallest minimal firmware
 * addition, because a device can only hold so much logic").
 *
 * Edge JS (node-onlykey-lib/edge) does the work - builds requests, stores the
 * chain, verifies it, pairs tickets, tracks budgets, derives the device id.
 * The key adds only what the host (the agent's own machine, the thing being
 * watched) cannot be trusted with, from facts it saw itself:
 *   1 the weld at each sign/decrypt decision, and the head that pins history;
 *   2 the budget decision (self-press) and its reveal;
 *   3 ONE signature, with a key no generic sign request reaches: a checkpoint
 *     over (seq, head). Opening a budget at a physical press answers with a
 *     checkpoint over its grant-create link, whose subject commits to G - so
 *     the budget's genesis is signed through the chain.
 *   4 the ticket link, straight after the use it answers.
 *
 * Every byte is node-onlykey-lib/edge's format (codes.js, chain.js, grants.js,
 * tickets.js); the comments name the lib function each must match.
 *
 * Budgets are bmatusiak/provable series (owner: "each budget has its own
 * genesis, each genesis gets started with the firmware button press by getting
 * signed"): G = H^n(seed), n <= 255; use i reveals v_i = H^(n-i)(seed).
 *
 * Soft key and desktop emulator only: the flash it uses (base+0x1000) is the
 * bootloader's on a real Teensy, and file-backed and unused on the emulators.
 */
#include "core_pins.h" /* millis() */
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
#define OP_GRANT_CREATE 6
#define OP_GRANT_END 7
#define OP_TICKET 8
#define DECISION_SELF_PRESS 4
#define FLAG_PRESS_OBSERVED 0x01
#define FLAG_BUDGET_SPENT 0x02
#define FLAG_PREV_NO_TICKET 0x04
#define GRANT_TICKET_REQUIRED 0x01 /* GRANT_CREATE flags */

#define SEQ_NONE 0xFFFFFFFFUL
#define LINK_BYTES 64
#define ID_BYTES 16

#define MAX_LIVE 4      /* R15 */
#define MAX_SCOPES 4    /* R11 */
#define MAX_USES 255    /* owner, 2026-10-02 */
#define HELD 8          /* links held in RAM for pickup */
#define GRANT_PRESS_MS 25000UL

/* ------------------------------------------------------------ flash: one small record */

/* base + 0x1000, from the firmware's own constant so it follows OKEMU_FLASH_BASE */
#define EDGE_REGION ((uintptr_t)factorysectoradr - 0x4800)
#define EDGE_STATE_A (EDGE_REGION + 0x0000)
#define EDGE_STATE_B (EDGE_REGION + 0x0800)

#define STATE_BYTES 120
#define STATE_CHECKED 116
static const uint8_t MAGIC[8] = {'O', 'K', 'E', 'D', 'G', 'E', '0', '4'};

/* everything that survives a restart: ~110 bytes */
struct edge_state {
  uint32_t gen;
  uint32_t seq;               /* SEQ_NONE = no link yet */
  uint8_t head[32];           /* head[seq]; the genesis while seq == SEQ_NONE */
  uint8_t use_owes;           /* the latest link is an approved use with no ticket (R16) */
  uint8_t use_self;           /* ... and it was a self-press (R18 gates only on those) */
  uint8_t last_link[LINK_BYTES]; /* the latest link, so a crash never loses it */
};
static struct edge_state st;
static uint8_t loaded;

/* ------------------------------------------------------------ RAM only */

static struct {
  uint8_t ok;
  uint8_t pub[64];            /* the Edge public key, X||Y */
  uint8_t device_id[ID_BYTES];
} ident;

struct scope { uint8_t op, slot; uint16_t cap, used; };
/* a live budget: RAM only - a lock or reboot is a new process, so it ends with the session (R15) */
struct budget {
  uint32_t id;
  uint8_t nscopes, flags;
  struct scope scopes[MAX_SCOPES];
  uint16_t uses, used;
  uint8_t seed[32];
  uint8_t genesis[32];
};
static struct budget budgets[MAX_LIVE];

/* the last links, with a self-press's reveal, for edge JS to pick up */
static struct held_link {
  uint8_t used;
  uint32_t seq;
  uint8_t link[LINK_BYTES];
  uint8_t head[32];
  uint8_t reveal[32];
} held[HELD];

/* what the confirmation that is waiting for its decision is about */
static struct {
  uint8_t active, opcode, slot, press;
  int8_t budget;
  uint8_t subject[32];
} pend;

/* a GRANT_CREATE waiting for its press */
static struct {
  uint8_t active;
  unsigned long since;
  struct budget b;
  uint8_t reason[32];
  uint8_t scopes_enc[1 + 4 * MAX_SCOPES];
  uint8_t scopes_len;
} grant;

/* ------------------------------------------------------------ bytes and hashes */

static void put32(uint8_t *p, uint32_t v) {
  p[0] = v & 0xff; p[1] = (v >> 8) & 0xff; p[2] = (v >> 16) & 0xff; p[3] = (v >> 24) & 0xff;
}
static uint32_t get32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static void put16(uint8_t *p, uint16_t v) { p[0] = v & 0xff; p[1] = (v >> 8) & 0xff; }
static uint16_t get16(const uint8_t *p) { return (uint16_t)(p[0] | (p[1] << 8)); }

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

/* "EDGE:xx" - the only text the plugin sends (okplugin_edge.h lists the codes) */
static void status(uint8_t code) {
  static const char HEX[] = "0123456789ABCDEF";
  char s[8] = {'E', 'D', 'G', 'E', ':', HEX[code >> 4], HEX[code & 0x0f], 0};
  hidprint(s);
}

static void hash_times(uint8_t out[32], const uint8_t v[32], unsigned times) {
  uint8_t x[32];
  memcpy(x, v, 32);
  for (unsigned k = 0; k < times; k++) H(x, NULL, x, 32, NULL, 0, NULL, 0);
  memcpy(out, x, 32);
  memset(x, 0, 32);
}

static void reply(const uint8_t *data, int len) {
  uint8_t r[64];
  memset(r, 0, sizeof(r));
  memcpy(r, data, len > 64 ? 64 : len);
  send_transport_response(r, 64, false, false);
}

/* ------------------------------------------------------------ the record */

static void state_encode(uint8_t rec[STATE_BYTES]) {
  uint8_t check[32];
  memset(rec, 0, STATE_BYTES);
  memcpy(rec, MAGIC, 8);
  put32(rec + 8, st.gen);
  put32(rec + 12, st.seq);
  memcpy(rec + 16, st.head, 32);
  rec[48] = st.use_owes;
  rec[49] = st.use_self;
  memcpy(rec + 52, st.last_link, LINK_BYTES);
  H(check, NULL, rec, STATE_CHECKED, NULL, 0, NULL, 0);
  memcpy(rec + STATE_CHECKED, check, 4);
}

static int state_decode(const uint8_t rec[STATE_BYTES], struct edge_state *s) {
  uint8_t check[32];
  if (memcmp(rec, MAGIC, 8) != 0) return 0;
  H(check, NULL, rec, STATE_CHECKED, NULL, 0, NULL, 0);
  if (memcmp(rec + STATE_CHECKED, check, 4) != 0) return 0; /* torn write: the other copy wins */
  s->gen = get32(rec + 8);
  s->seq = get32(rec + 12);
  memcpy(s->head, rec + 16, 32);
  s->use_owes = rec[48];
  s->use_self = rec[49];
  memcpy(s->last_link, rec + 52, LINK_BYTES);
  return 1;
}

/* double-buffered: write the OTHER sector, so a crash mid-write keeps the old record */
static void state_save(void) {
  uint8_t rec[STATE_BYTES];
  st.gen++;
  state_encode(rec);
  okcore_flashsector(rec, (unsigned long *)((st.gen & 1) ? EDGE_STATE_B : EDGE_STATE_A), STATE_BYTES);
}

static void hold(uint32_t seq, const uint8_t link[LINK_BYTES], const uint8_t head[32], const uint8_t *reveal) {
  struct held_link *h = &held[seq % HELD];
  h->used = 1;
  h->seq = seq;
  memcpy(h->link, link, LINK_BYTES);
  memcpy(h->head, head, 32);
  if (reveal) memcpy(h->reveal, reveal, 32); else memset(h->reveal, 0, 32);
}

static void state_load(void) {
  if (loaded) return;
  uint8_t rec[STATE_BYTES];
  struct edge_state a, b;
  okcore_flashget_common(rec, (unsigned long *)EDGE_STATE_A, STATE_BYTES);
  int ha = state_decode(rec, &a);
  okcore_flashget_common(rec, (unsigned long *)EDGE_STATE_B, STATE_BYTES);
  int hb = state_decode(rec, &b);
  if (ha && (!hb || a.gen > b.gen)) st = a;
  else if (hb) st = b;
  else {
    memset(&st, 0, sizeof(st));
    st.seq = SEQ_NONE;
  }
  /* the latest link survives a restart, so it can still be picked up */
  if (st.seq != SEQ_NONE) hold(st.seq, st.last_link, st.head, NULL);
  loaded = 1;
}

/* ------------------------------------------------------------ the Edge key */

/*
 * HKDF(K132, info "onlykey/edge/v1"), P-256. K132 is the key's own secret (made
 * at PIN setup, in the backup): the identity survives a restore and changes
 * with a wipe - a wiped key is simply a new device to every host. The
 * firmware's ECC globals (a pending sign may be using them) are put back.
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

/* the public key and device id (RAM), and the genesis on a new chain; 0 without K132 */
static int ensure_identity(void) {
  state_load();
  if (ident.ok) return 1;
  uint8_t priv[32], h[32];
  if (!edge_private_key(priv)) return 0;
  int ok = uECC_compute_public_key(priv, ident.pub, uECC_secp256r1());
  memset(priv, 0, 32);
  if (!ok) return 0;
  /* device_id = SHA256("OKEDGE-DEVICE-v1" || pubkey)[0..16] - edge JS computes it the same way */
  H(h, "OKEDGE-DEVICE-v1", ident.pub, 64, NULL, 0, NULL, 0);
  memcpy(ident.device_id, h, ID_BYTES);
  ident.ok = 1;
  if (st.seq == SEQ_NONE) {
    /* head[-1] = SHA256("OKEDGE-GENESIS-v1" || device_id)  (lib chain.genesis) */
    H(st.head, "OKEDGE-GENESIS-v1", ident.device_id, ID_BYTES, NULL, 0, NULL, 0);
    state_save();
  }
  return 1;
}

/*
 * The one signature: a checkpoint over (seq, head) (R7, lib chain.checkpointDigest)
 *   SHA256("OKEDGE-CKPT-v1" || device_id || seq (u32 LE) || head)
 * reply: seq u32 . head 32; then the 64-byte signature.
 */
static void checkpoint(void) {
  uint8_t seq4[4], digest[32], sig[64], priv[32], r[36];
  put32(seq4, st.seq);
  H(digest, "OKEDGE-CKPT-v1", ident.device_id, ID_BYTES, seq4, 4, st.head, 32);
  int ok = edge_private_key(priv) && uECC_sign(priv, digest, 32, sig, uECC_secp256r1());
  memset(priv, 0, 32);
  if (!ok) { status(EDGE_SIGN_FAILED); return; }
  memcpy(r, seq4, 4);
  memcpy(r + 4, st.head, 32);
  reply(r, 36);
  reply(sig, 64);
}

/* ------------------------------------------------------------ the weld */

/*
 * One link (lib chain.encodeLink), welded
 *   head[n] = SHA256("OKEDGE-LINK-v1" || head[n-1] || link[n])   (lib chain.weld)
 * and persisted before the operation's result is released (R4).
 */
static void append(uint8_t op, uint8_t decision, uint8_t slot, uint8_t flags, const uint8_t subject[32],
    uint32_t grant_id, uint16_t grant_step, const uint8_t *reveal) {
  uint8_t link[LINK_BYTES], head[32];
  memset(link, 0, sizeof(link));
  uint32_t seq = st.seq == SEQ_NONE ? 0 : st.seq + 1;
  put32(link, seq);
  link[4] = op;
  link[5] = decision;
  link[6] = slot;
  link[7] = flags;
  memcpy(link + 8, subject, 32);
  put32(link + 40, grant_id);
  put16(link + 44, grant_step);
  H(head, "OKEDGE-LINK-v1", st.head, 32, link, LINK_BYTES, NULL, 0);
  st.seq = seq;
  memcpy(st.head, head, 32);
  memcpy(st.last_link, link, LINK_BYTES);
  /* only the link straight after a use may be its ticket (R16, tightened): anything else closes it */
  st.use_owes = (op == OP_SIGN || op == OP_DECRYPT) && (decision == OKEDGE_DECISION_APPROVE || decision == DECISION_SELF_PRESS);
  st.use_self = st.use_owes && decision == DECISION_SELF_PRESS;
  state_save();
  hold(seq, link, head, reveal);
}

/* ------------------------------------------------------------ budgets */

/*
 * What a budget may pay for (R14: never FIDO2, config, backup, keys, PINs or
 * the hardened derive / shared secret): OKSIGN on the stored slots 1-4 and
 * 101-116 and the agent sign codes 201-203 / 221-223; OKDECRYPT on the stored
 * slots only. CHOSEN - the open question on agent-derived identities decides
 * whether agent signs stay in.
 */
static int scope_allowed(uint8_t op, uint8_t slot) {
  int stored = (slot >= 1 && slot <= 4) || (slot >= 101 && slot <= 116);
  if (op == OP_SIGN) return stored || (slot >= 201 && slot <= 203) || (slot >= 221 && slot <= 223);
  if (op == OP_DECRYPT) return stored;
  return 0;
}

/*
 * A live budget with room for this use, while unlocked and out of config mode.
 * R18, CHOSEN: under a ticket_required budget, while the latest SELF-PRESS still
 * owes its ticket, there is no self-press (a person pressing never files
 * tickets, R17, so a pressed use must not block a budget) - the use falls back
 * to a PRESS the person sees, rather than adding a refusal path.
 */
static int budget_for(uint8_t op, uint8_t slot, struct scope **sc_out) {
  if (!(unlocked == true && configmode == false)) return -1;
  for (int i = 0; i < MAX_LIVE; i++) {
    struct budget *b = &budgets[i];
    if (!b->id || b->used >= b->uses) continue;
    if ((b->flags & GRANT_TICKET_REQUIRED) && st.use_owes && st.use_self) continue;
    for (int j = 0; j < b->nscopes; j++) {
      struct scope *sc = &b->scopes[j];
      if (sc->op == op && sc->slot == slot && sc->used < sc->cap) {
        *sc_out = sc;
        return i;
      }
    }
  }
  return -1;
}

static void grant_drop(void) {
  memset(&grant, 0, sizeof(grant));
}

/*
 * GRANT_CREATE: [6] scope count, [7..22] scopes (op, slot, cap u16 LE) x4,
 * [23..54] reason_hash, [55] flags. The seed and G = H^n(seed) are made here;
 * the budget opens only on a PHYSICAL press.
 */
static void grant_create(const uint8_t *buffer) {
  uint8_t n = buffer[6];
  unsigned uses = 0;
  grant_drop();
  if (n < 1 || n > MAX_SCOPES) { status(EDGE_BAD_SCOPES); return; }
  grant.scopes_enc[0] = n;
  for (int j = 0; j < n; j++) {
    const uint8_t *p = buffer + 7 + 4 * j;
    struct scope *sc = &grant.b.scopes[j];
    sc->op = p[0];
    sc->slot = p[1];
    sc->cap = get16(p + 2);
    if (!scope_allowed(sc->op, sc->slot) || sc->cap < 1) { grant_drop(); status(EDGE_SCOPE_NOT_ALLOWED); return; }
    uses += sc->cap;
    memcpy(grant.scopes_enc + 1 + 4 * j, p, 4);
  }
  if (uses > MAX_USES) { grant_drop(); status(EDGE_TOO_MANY_USES); return; }
  grant.scopes_len = 1 + 4 * n;
  grant.b.nscopes = n;
  grant.b.uses = (uint16_t)uses;
  grant.b.flags = buffer[55];
  memcpy(grant.reason, buffer + 23, 32);
  RNG2(grant.b.seed, 32);
  hash_times(grant.b.genesis, grant.b.seed, grant.b.uses);
  grant.active = 1;
  grant.since = millis();
  uint8_t what[32];
  H(what, NULL, grant.reason, 32, grant.b.genesis, 32, grant.scopes_enc, grant.scopes_len);
  okcore_prime_user_confirmation(OKEDGE, 0, what, 32); /* the press is forced in okplugin_edge_primed */
}

/*
 * The press: link grant-create, whose subject commits to the budget's genesis
 *   SHA256("OKEDGE-GRANT-v1" || scopes || reason_hash || G)   (lib grants.grantSubject)
 * and answer with a checkpoint over that link - the key's signature on G.
 * reply: id u32 . uses u16 . G 32 . the link's seq u32; then the checkpoint.
 */
static void grant_pressed(void) {
  int slot = -1;
  if (!grant.active || millis() - grant.since > GRANT_PRESS_MS) { grant_drop(); return; }
  if (!ensure_identity()) { grant_drop(); status(EDGE_NEED_PIN); return; }
  for (int i = 0; i < MAX_LIVE; i++) if (!budgets[i].id) { slot = i; break; }
  if (slot < 0) { grant_drop(); status(EDGE_LIVE_FULL); return; }

  uint32_t seq = st.seq == SEQ_NONE ? 0 : st.seq + 1;
  uint32_t id = seq + 1; /* the seq of its grant-create link, plus one (0 = no budget) */
  uint8_t subject[32], r[42];
  SHA256_CTX ctx;
  sha256_init(&ctx);
  sha256_update(&ctx, (const unsigned char *)"OKEDGE-GRANT-v1", 15);
  sha256_update(&ctx, grant.scopes_enc, grant.scopes_len);
  sha256_update(&ctx, grant.reason, 32);
  sha256_update(&ctx, grant.b.genesis, 32);
  sha256_final(&ctx, subject);
  grant.b.id = id;
  budgets[slot] = grant.b;
  append(OP_GRANT_CREATE, OKEDGE_DECISION_APPROVE, 0, FLAG_PRESS_OBSERVED, subject, id, 0, NULL);

  put32(r, id);
  put16(r + 4, grant.b.uses);
  memcpy(r + 6, grant.b.genesis, 32);
  put32(r + 38, seq);
  grant_drop();
  reply(r, 42);
  checkpoint();
}

/* ------------------------------------------------------------ hooks */

void okplugin_edge_primed(uint8_t opcode, uint8_t slot, const uint8_t *msg, size_t msg_len) {
  pend.active = 0;
  pend.budget = -1;
  if (opcode == OKEDGE) {
    user_input_mode = USER_INPUT_PRESS; /* opening a budget always takes a physical press (R10) */
    return;
  }
  if (opcode != OKSIGN && opcode != OKDECRYPT) return;
  pend.active = 1;
  pend.opcode = opcode;
  pend.slot = slot;
  H(pend.subject, NULL, msg, msg_len, NULL, 0, NULL, 0); /* SHA-256 of exactly what was submitted */
  state_load();
  struct scope *sc;
  int i = budget_for(opcode == OKSIGN ? OP_SIGN : OP_DECRYPT, slot, &sc);
  if (i >= 0) {
    pend.budget = (int8_t)i;
    user_input_mode = USER_INPUT_NONE; /* a live budget pays: the firmware's own no-press path runs it (R13) */
  }
  pend.press = user_input_mode != USER_INPUT_NONE;
}

void okplugin_edge_decision(int decision) {
  if (decision == OKEDGE_DECISION_APPROVE && packet_buffer_details[0] == OKEDGE) {
    grant_pressed();
    return;
  }
  if (!pend.active) return;
  if (decision == OKEDGE_DECISION_APPROVE && packet_buffer_details[0] != pend.opcode) return;
  pend.active = 0;
  if (!ensure_identity()) return; /* no K132 yet: nothing to chain to */
  uint8_t op = pend.opcode == OKSIGN ? OP_SIGN : OP_DECRYPT;
  uint8_t flags = st.use_owes ? FLAG_PREV_NO_TICKET : 0; /* R17's empty hook */

  if (decision == OKEDGE_DECISION_APPROVE && pend.budget >= 0) {
    struct scope *sc;
    if (budget_for(op, pend.slot, &sc) == pend.budget) { /* still live, still room */
      struct budget *b = &budgets[pend.budget];
      uint8_t reveal[32];
      b->used++;
      sc->used++;
      hash_times(reveal, b->seed, b->uses - b->used); /* v_i = H^(n-i)(seed) (lib grants.reveal) */
      append(op, DECISION_SELF_PRESS, pend.slot, flags | FLAG_BUDGET_SPENT, pend.subject, b->id, b->used, reveal);
      memset(reveal, 0, 32);
      return;
    }
  }
  if (decision == OKEDGE_DECISION_APPROVE && pend.press) flags |= FLAG_PRESS_OBSERVED;
  append(op, (uint8_t)decision, pend.slot, flags, pend.subject, 0, 0, NULL);
}

/* wipeflashdata(): the record goes and live budgets end; a new K132 makes the key a new device */
void okplugin_edge_wipe(void) {
  uint8_t blank[4] = {0xff, 0xff, 0xff, 0xff};
  okcore_flashsector(blank, (unsigned long *)EDGE_STATE_A, 4);
  okcore_flashsector(blank, (unsigned long *)EDGE_STATE_B, 4);
  memset(budgets, 0, sizeof(budgets));
  memset(held, 0, sizeof(held));
  memset(&ident, 0, sizeof(ident));
  memset(&st, 0, sizeof(st));
  st.seq = SEQ_NONE;
  loaded = 1;
  pend.active = 0;
  grant_drop();
}

/* ------------------------------------------------------------ OKEDGE */

void okplugin_edge_recv(uint8_t *buffer) {
  if (!(initialized == true && unlocked == true && configmode == false)) return;
  if (!ensure_identity()) { status(EDGE_NEED_PIN); return; }
  if (grant.active && millis() - grant.since > GRANT_PRESS_MS) grant_drop(); /* never pressed */
  uint8_t r[64];
  memset(r, 0, sizeof(r));
  switch (buffer[5]) {
    case OKEDGE_HEAD: {
      /* seq (SEQ_NONE = empty) . head (the genesis while empty) . oldest pickable seq . live budget ids x4 */
      uint32_t oldest = SEQ_NONE;
      for (int i = 0; i < HELD; i++) if (held[i].used && held[i].seq < oldest) oldest = held[i].seq;
      put32(r, st.seq);
      memcpy(r + 4, st.head, 32);
      put32(r + 36, oldest);
      for (int i = 0; i < MAX_LIVE; i++) put32(r + 40 + 4 * i, budgets[i].id);
      reply(r, 56);
      return;
    }
    case OKEDGE_PICKUP: {
      /* from u32 . count u8 (<= 8); per link: the link, then its head + the reveal (zeros if none) */
      uint32_t from = get32(buffer + 6);
      uint8_t count = buffer[10] > HELD ? HELD : buffer[10];
      for (uint32_t s = from; s < from + count; s++) {
        struct held_link *h = &held[s % HELD];
        if (!h->used || h->seq != s) { status(EDGE_NOT_HELD); return; }
      }
      for (uint32_t s = from; s < from + count; s++) {
        struct held_link *h = &held[s % HELD];
        reply(h->link, LINK_BYTES);
        memcpy(r, h->head, 32);
        memcpy(r + 32, h->reveal, 32);
        reply(r, 64);
      }
      return;
    }
    case OKEDGE_CHECKPOINT:
      checkpoint();
      return;
    case OKEDGE_PUBKEY:
      reply(ident.pub, 64);
      return;
    case OKEDGE_GRANT_CREATE:
      grant_create(buffer);
      return;
    case OKEDGE_GRANT_REVOKE: {
      uint32_t id = get32(buffer + 6);
      for (int i = 0; i < MAX_LIVE; i++) {
        if (budgets[i].id && budgets[i].id == id) {
          uint8_t zero[32] = {0};
          memset(&budgets[i], 0, sizeof(budgets[i]));
          append(OP_GRANT_END, OKEDGE_DECISION_APPROVE, 0, 0, zero, id, 0, NULL);
          status(EDGE_OK);
          return;
        }
      }
      status(EDGE_NO_SUCH_BUDGET);
      return;
    }
    case OKEDGE_TICKET: {
      /*
       * ref_seq u32 . code u8 . msg_hash 32 - only as the very NEXT link after
       * its use, so head[ref_seq] is the current head:
       *   SHA256("OKEDGE-TICKET-v1" || ref_seq || head[ref_seq] || code || msg_hash)
       * (lib tickets.ticketSubject). The message itself never reaches the key.
       */
      uint32_t ref = get32(buffer + 6);
      uint8_t code = buffer[10];
      if (!st.use_owes || st.seq == SEQ_NONE || ref != st.seq) { status(EDGE_NO_TICKET_WAITING); return; }
      uint8_t ref4[4], subject[32];
      put32(ref4, ref);
      SHA256_CTX ctx;
      sha256_init(&ctx);
      sha256_update(&ctx, (const unsigned char *)"OKEDGE-TICKET-v1", 16);
      sha256_update(&ctx, ref4, 4);
      sha256_update(&ctx, st.head, 32);
      sha256_update(&ctx, &code, 1);
      sha256_update(&ctx, buffer + 11, 32);
      sha256_final(&ctx, subject);
      append(OP_TICKET, code, 0, 0, subject, ref, 0, NULL);
      status(EDGE_OK);
      return;
    }
    default:
      status(EDGE_UNKNOWN_REQUEST);
      return;
  }
}
