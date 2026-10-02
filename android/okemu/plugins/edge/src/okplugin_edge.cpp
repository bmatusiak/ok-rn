/*
 * edge - the device chain (step 1) and budgets (step 2). DESIGN.md 1-5.
 *
 * Every sign/decrypt decision (approve, deny, timeout, self-press) becomes a
 * 64-byte link welded into a SHA-256 chain whose head this key keeps. The
 * BYTES are the contract with node-onlykey-lib/edge (codes.js, chain.js,
 * grants.js) and its Python vectors: what is written here must verify there,
 * so every format choice below names the lib function it must match.
 *
 * Budgets (owner, 2026-10-02: "like a provable blockchain - each budget has
 * its own genesis, each genesis gets started with the firmware button press by
 * getting signed"): each budget is its own bmatusiak/provable series
 * G = H^n(seed); a PHYSICAL press opens it and the key signs its genesis; each
 * use inside it is approved without a press ("self-press") and reveals the next
 * value of the series, bound to what was approved by an HMAC.
 *
 * Soft key and desktop emulator only. The storage lives in flash the real
 * device uses for something else (0x1000-0x57FF is the bootloader's area on a
 * Teensy); on the emulators that range is file-backed, unused and outside the
 * firmware hash - so this plugin must never be built for a hard key.
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
#define OP_WIPE 12
#define DECISION_SELF_PRESS 4
#define FLAG_PRESS_OBSERVED 0x01
#define FLAG_BUDGET_SPENT 0x02
#define FLAG_PREV_NO_TICKET 0x04

#define SEQ_NONE 0xFFFFFFFFUL
#define LINK_BYTES 64
#define HEAD_BYTES 32
#define ID_BYTES 16

/* budgets: at most 4 live (R15), each at most 255 uses (owner, 2026-10-02) */
#define MAX_LIVE 4
#define MAX_SCOPES 4
#define MAX_USES 255
/* a person has this long to press for a budget, like any confirmation */
#define GRANT_PRESS_MS 25000UL

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

#define STATE_BYTES 192
#define STATE_CHECKED 180 /* bytes covered by the 4-byte check stored after them */
static const uint8_t MAGIC[8] = {'O', 'K', 'E', 'D', 'G', 'E', '0', '2'};

#define SF_WIPED 0x01 /* the next link records a wipe (R9) */

struct edge_state {
  uint32_t gen;
  uint32_t seq;              /* SEQ_NONE = no link yet */
  uint8_t head[HEAD_BYTES];  /* head[seq]; the genesis while seq == SEQ_NONE */
  uint8_t device_id[ID_BYTES];
  uint8_t pub[64];           /* the Edge public key, X||Y */
  uint32_t flags;
  uint8_t has_id;
  uint32_t live[MAX_LIVE];   /* ids of budgets live when this was written (0 = none) */
};

static struct edge_state st;
static uint8_t loaded = 0;
static uint8_t booted = 0;

/* what the confirmation that is waiting for its decision is about */
static struct {
  uint8_t active;
  uint8_t opcode;
  uint8_t slot;
  uint8_t press;
  int8_t budget;             /* index into budgets[] when a budget pays for it, else -1 */
  uint8_t subject[32];
} pend;

/* ------------------------------------------------------------ budgets, in RAM only */

struct scope {
  uint8_t op, slot;
  uint16_t cap, used;
};

/*
 * A live budget. The seed is in RAM ONLY: a lock or reboot is a new process on
 * both emulators, so the budget ends with the key's session (R15) by losing it.
 */
struct budget {
  uint32_t id;
  uint8_t nscopes;
  struct scope scopes[MAX_SCOPES];
  uint16_t uses, used;
  uint8_t flags;
  uint8_t seed[32];
  uint8_t genesis[32];
};
static struct budget budgets[MAX_LIVE];

/* a GRANT_CREATE waiting for its press */
static struct {
  uint8_t active;
  unsigned long since;
  struct budget b;
  uint8_t reason[32];
  uint8_t scopes_enc[1 + 4 * MAX_SCOPES];
  uint8_t scopes_len;
} grant;

/* the last self-press's reveal, for LAST_REVEAL */
static struct {
  uint32_t id;
  uint16_t step;
  uint8_t value[32];
  uint8_t mac[32];
} last_reveal;

static void put32(uint8_t *p, uint32_t v) {
  p[0] = v & 0xff; p[1] = (v >> 8) & 0xff; p[2] = (v >> 16) & 0xff; p[3] = (v >> 24) & 0xff;
}
static uint32_t get32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static void put16(uint8_t *p, uint16_t v) {
  p[0] = v & 0xff; p[1] = (v >> 8) & 0xff;
}
static uint16_t get16(const uint8_t *p) {
  return (uint16_t)(p[0] | (p[1] << 8));
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

/* HMAC-SHA256 with a 32-byte key (RFC 2104; lib grants: HMAC(v_i, subject)) */
static void hmac_sha256(uint8_t out[32], const uint8_t key[32], const uint8_t *msg, size_t len) {
  uint8_t pad[64], inner[32];
  SHA256_CTX ctx;
  memset(pad, 0x36, 64);
  for (int i = 0; i < 32; i++) pad[i] ^= key[i];
  sha256_init(&ctx);
  sha256_update(&ctx, pad, 64);
  sha256_update(&ctx, msg, len);
  sha256_final(&ctx, inner);
  memset(pad, 0x5c, 64);
  for (int i = 0; i < 32; i++) pad[i] ^= key[i];
  sha256_init(&ctx);
  sha256_update(&ctx, pad, 64);
  sha256_update(&ctx, inner, 32);
  sha256_final(&ctx, out);
  memset(pad, 0, 64);
}

/* H^times(v) (lib grants hashTimes) */
static void hash_times(uint8_t out[32], const uint8_t v[32], unsigned times) {
  uint8_t x[32];
  memcpy(x, v, 32);
  for (unsigned k = 0; k < times; k++) H(x, NULL, x, 32, NULL, 0, NULL, 0);
  memcpy(out, x, 32);
  memset(x, 0, 32);
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
  for (int i = 0; i < MAX_LIVE; i++) put32(rec + 136 + 4 * i, s->live[i]);
  uint8_t check[32];
  H(check, NULL, rec, STATE_CHECKED, NULL, 0, NULL, 0);
  memcpy(rec + STATE_CHECKED, check, 4);
}

static int state_decode(const uint8_t rec[STATE_BYTES], struct edge_state *s) {
  if (memcmp(rec, MAGIC, 8) != 0) return 0;
  uint8_t check[32];
  H(check, NULL, rec, STATE_CHECKED, NULL, 0, NULL, 0);
  if (memcmp(rec + STATE_CHECKED, check, 4) != 0) return 0; /* torn write: the other copy wins */
  s->gen = get32(rec + 8);
  s->seq = get32(rec + 12);
  memcpy(s->head, rec + 16, 32);
  memcpy(s->device_id, rec + 48, 16);
  memcpy(s->pub, rec + 64, 64);
  s->flags = get32(rec + 128);
  s->has_id = rec[132];
  for (int i = 0; i < MAX_LIVE; i++) s->live[i] = get32(rec + 136 + 4 * i);
  return 1;
}

/* the live budget ids, as the state record keeps them */
static void live_ids_from_budgets(void) {
  for (int i = 0; i < MAX_LIVE; i++) st.live[i] = budgets[i].id;
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

static void append(uint8_t op, uint8_t decision, uint8_t slot, uint8_t flags, const uint8_t subject[32],
    uint32_t grant_id, uint16_t grant_step);

/*
 * Budgets live when the previous process ended (a lock or reboot is a new
 * process) ended with it: their seeds are gone. Link that, once per boot.
 */
static void boot_cleanup(void) {
  if (booted) return;
  booted = 1;
  uint8_t zero[32];
  memset(zero, 0, sizeof(zero));
  int any = 0;
  for (int i = 0; i < MAX_LIVE; i++) {
    if (!st.live[i]) continue;
    uint32_t id = st.live[i];
    st.live[i] = 0;
    append(OP_GRANT_END, OKEDGE_DECISION_APPROVE, 0, 0, zero, id, 0);
    any = 1;
  }
  if (any) state_save();
}

/* the identity and the genesis, once; 0 if the key has no K132 yet */
static int ensure_identity(void) {
  state_load();
  if (st.has_id) {
    boot_cleanup();
    return 1;
  }
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
  booted = 1;
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
  return (link[4] == OP_SIGN || link[4] == OP_DECRYPT)
      && (link[5] == OKEDGE_DECISION_APPROVE || link[5] == DECISION_SELF_PRESS);
}

/*
 * Append one link: encode it (lib chain.encodeLink), weld it
 *   head[n] = SHA256("OKEDGE-LINK-v1" || head[n-1] || link[n])   (lib chain.weld)
 * and persist ring entry, then state - R4: (seq, head) is on flash BEFORE the
 * operation's result is released (the approve hook runs before the sign).
 */
static void append(uint8_t op, uint8_t decision, uint8_t slot, uint8_t flags, const uint8_t subject[32],
    uint32_t grant_id, uint16_t grant_step) {
  uint8_t link[LINK_BYTES];
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
  append(OP_WIPE, OKEDGE_DECISION_APPROVE, 0, 0, zero, 0, 0);
}

/* ------------------------------------------------------------ budgets (DESIGN.md 4) */

/*
 * What a budget may pay for (R14: never FIDO2, config, backup, keys, PINs or
 * the hardened derive / shared secret): OKSIGN on the stored slots 1-4 and
 * 101-116 and the agent sign codes 201-203 / 221-223; OKDECRYPT on the stored
 * slots only. CHOSEN - the open question "budget scopes for agent-derived
 * SSH/GPG identities" decides whether agent signs stay in.
 */
static int scope_allowed(uint8_t op, uint8_t slot) {
  int stored = (slot >= 1 && slot <= 4) || (slot >= 101 && slot <= 116);
  if (op == OP_SIGN) return stored || (slot >= 201 && slot <= 203) || (slot >= 221 && slot <= 223);
  if (op == OP_DECRYPT) return stored;
  return 0;
}

static int budget_count(void) {
  int n = 0;
  for (int i = 0; i < MAX_LIVE; i++) if (budgets[i].id) n++;
  return n;
}

static void budget_wipe(struct budget *b) {
  memset(b, 0, sizeof(*b));
}

static void grant_drop(void) {
  budget_wipe(&grant.b);
  grant.active = 0;
}

/* a live budget with room for this use, while the key is unlocked and out of config mode */
static int budget_for(uint8_t op, uint8_t slot, struct scope **sc_out) {
  if (!(unlocked == true && configmode == false)) return -1;
  for (int i = 0; i < MAX_LIVE; i++) {
    struct budget *b = &budgets[i];
    if (!b->id || b->used >= b->uses) continue;
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

/*
 * The digest the key signs at the press (lib grants.budgetGenesisDigest):
 *   SHA256("OKEDGE-BUDGET-v1" || device_id || grant_id (u32 LE) || G
 *          || uses (u16 LE) || scopes || reason_hash || chain_seq (u32 LE)
 *          || chain_head)
 */
static void genesis_digest(uint8_t out[32], uint32_t grant_id, uint32_t chain_seq, const uint8_t chain_head[32]) {
  uint8_t id4[4], uses2[2], seq4[4];
  put32(id4, grant_id);
  put16(uses2, grant.b.uses);
  put32(seq4, chain_seq);
  SHA256_CTX ctx;
  sha256_init(&ctx);
  sha256_update(&ctx, (const unsigned char *)"OKEDGE-BUDGET-v1", 16);
  sha256_update(&ctx, st.device_id, ID_BYTES);
  sha256_update(&ctx, id4, 4);
  sha256_update(&ctx, grant.b.genesis, 32);
  sha256_update(&ctx, uses2, 2);
  sha256_update(&ctx, grant.scopes_enc, grant.scopes_len);
  sha256_update(&ctx, grant.reason, 32);
  sha256_update(&ctx, seq4, 4);
  sha256_update(&ctx, chain_head, 32);
  sha256_final(&ctx, out);
}

static void reply(const uint8_t *data, int len) {
  uint8_t r[64];
  memset(r, 0, sizeof(r));
  memcpy(r, data, len > 64 ? 64 : len);
  send_transport_response(r, 64, false, false);
}

/*
 * GRANT_CREATE: [6] scope count, [7..22] scopes (op, slot, cap u16 LE) x4,
 * [23..54] reason_hash, [55] flags. Draws the seed, builds G = H^n(seed), then
 * waits for a PHYSICAL press - no press, no budget.
 */
static void grant_create(const uint8_t *buffer) {
  if (grant.active) grant_drop();
  uint8_t n = buffer[6];
  if (n < 1 || n > MAX_SCOPES) { hidprint("Error Edge a budget has 1 to 4 scopes"); return; }
  if (budget_count() >= MAX_LIVE) { hidprint("Error Edge 4 budgets are already live"); return; }
  memset(&grant, 0, sizeof(grant));
  unsigned uses = 0;
  grant.scopes_enc[0] = n;
  for (int j = 0; j < n; j++) {
    const uint8_t *p = buffer + 7 + 4 * j;
    struct scope *sc = &grant.b.scopes[j];
    sc->op = p[0];
    sc->slot = p[1];
    sc->cap = get16(p + 2);
    if (!scope_allowed(sc->op, sc->slot) || sc->cap < 1) { grant_drop(); hidprint("Error Edge scope not allowed"); return; }
    uses += sc->cap;
    memcpy(grant.scopes_enc + 1 + 4 * j, p, 4);
  }
  if (uses > MAX_USES) { grant_drop(); hidprint("Error Edge a budget has at most 255 uses"); return; }
  grant.scopes_len = 1 + 4 * n;
  grant.b.nscopes = n;
  grant.b.uses = (uint16_t)uses;
  grant.b.flags = buffer[55];
  memcpy(grant.reason, buffer + 23, 32);
  RNG2(grant.b.seed, 32);
  hash_times(grant.b.genesis, grant.b.seed, grant.b.uses);
  grant.active = 1;
  grant.since = millis();
  /* the press: forced in okplugin_edge_primed, whatever the slot settings say */
  uint8_t what[32];
  H(what, NULL, grant.reason, 32, grant.b.genesis, 32, grant.scopes_enc, grant.scopes_len);
  okcore_prime_user_confirmation(OKEDGE, 0, what, 32);
}

/* the press arrived: link it, sign the genesis, make the budget live */
static void grant_pressed(void) {
  if (!grant.active || millis() - grant.since > GRANT_PRESS_MS) { grant_drop(); return; }
  if (!ensure_identity()) { grant_drop(); hidprint("Error Edge needs a key with a PIN set"); return; }
  first_link_after_wipe();
  int slot = -1;
  for (int i = 0; i < MAX_LIVE; i++) if (!budgets[i].id) { slot = i; break; }
  if (slot < 0) { grant_drop(); hidprint("Error Edge 4 budgets are already live"); return; }

  uint32_t chain_seq = st.seq == SEQ_NONE ? 0 : st.seq + 1;
  uint8_t chain_head[32];
  memcpy(chain_head, st.head, 32);
  uint32_t id = chain_seq + 1; /* unique: the seq of its grant-create link, plus one (0 = no budget) */

  uint8_t digest[32], sig[64], priv[32];
  genesis_digest(digest, id, chain_seq, chain_head);
  if (!edge_private_key(priv) || !uECC_sign(priv, digest, 32, sig, uECC_secp256r1())) {
    memset(priv, 0, 32);
    grant_drop();
    hidprint("Error Edge could not sign the budget");
    return;
  }
  memset(priv, 0, 32);

  /* grant-create's subject: SHA256("OKEDGE-GRANT-v1" || scopes || reason_hash) (R12) */
  uint8_t subject[32];
  H(subject, "OKEDGE-GRANT-v1", grant.scopes_enc, grant.scopes_len, grant.reason, 32, NULL, 0);
  grant.b.id = id;
  budgets[slot] = grant.b;
  live_ids_from_budgets(); /* persisted by append's state_save */
  append(OP_GRANT_CREATE, OKEDGE_DECISION_APPROVE, 0, FLAG_PRESS_OBSERVED, subject, id, 0);

  uint8_t r[64];
  memset(r, 0, sizeof(r));
  put32(r, id);
  put16(r + 4, grant.b.uses);
  memcpy(r + 6, grant.b.genesis, 32);
  put32(r + 38, chain_seq);
  reply(r, 42);
  reply(sig, 64);
  grant_drop();
}

static void grant_end(int i) {
  uint8_t zero[32];
  memset(zero, 0, sizeof(zero));
  uint32_t id = budgets[i].id;
  budget_wipe(&budgets[i]);
  live_ids_from_budgets();
  append(OP_GRANT_END, OKEDGE_DECISION_APPROVE, 0, 0, zero, id, 0);
}

/* ------------------------------------------------------------ hooks */

void okplugin_edge_primed(uint8_t opcode, uint8_t slot, const uint8_t *msg, size_t msg_len) {
  pend.active = 0;
  pend.budget = -1;
  if (opcode == OKEDGE) {
    /* opening a budget always takes a PHYSICAL press (R10), whatever the slot says */
    user_input_mode = USER_INPUT_PRESS;
    return;
  }
  if (opcode != OKSIGN && opcode != OKDECRYPT) return;
  pend.active = 1;
  pend.opcode = opcode;
  pend.slot = slot;
  /* the link's subject: SHA-256 of exactly what was submitted for approval */
  H(pend.subject, NULL, msg, msg_len, NULL, 0, NULL, 0);
  /* a live budget pays for it: no press (R13) - the existing no-press path runs it */
  struct scope *sc;
  int i = budget_for(opcode == OKSIGN ? OP_SIGN : OP_DECRYPT, slot, &sc);
  if (i >= 0) {
    pend.budget = (int8_t)i;
    user_input_mode = USER_INPUT_NONE;
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
  first_link_after_wipe();
  uint8_t flags = 0;
  if (prev_owes_ticket()) flags |= FLAG_PREV_NO_TICKET;
  uint8_t op = pend.opcode == OKSIGN ? OP_SIGN : OP_DECRYPT;

  if (decision == OKEDGE_DECISION_APPROVE && pend.budget >= 0) {
    /* the budget may have ended since it was primed (revoked, config mode): then it is not a self-press */
    struct scope *sc;
    int i = budget_for(op, pend.slot, &sc);
    if (i == pend.budget) {
      struct budget *b = &budgets[i];
      b->used++;
      sc->used++;
      /* reveal v_i = H^(n-i)(seed) and bind it to what was approved (lib grants.checkSelfPress) */
      last_reveal.id = b->id;
      last_reveal.step = b->used;
      hash_times(last_reveal.value, b->seed, b->uses - b->used);
      hmac_sha256(last_reveal.mac, last_reveal.value, pend.subject, 32);
      append(op, DECISION_SELF_PRESS, pend.slot, flags | FLAG_BUDGET_SPENT, pend.subject, b->id, b->used);
      return;
    }
  }
  if (decision == OKEDGE_DECISION_APPROVE && pend.press) flags |= FLAG_PRESS_OBSERVED;
  append(op, (uint8_t)decision, pend.slot, flags, pend.subject, 0, 0);
}

/*
 * wipeflashdata(): erase the region, then leave one state record that says
 * "wiped" - the new identity (a new K132 after the new PIN) starts its chain
 * with a wipe link. Live budgets end with the key.
 */
void okplugin_edge_wipe(void) {
  uint8_t blank[4] = {0xff, 0xff, 0xff, 0xff};
  for (uintptr_t s = EDGE_REGION; s < EDGE_RING + 2 * SECTOR_BYTES; s += SECTOR_BYTES) {
    flash_write(blank, s, 4);
  }
  for (int i = 0; i < MAX_LIVE; i++) budget_wipe(&budgets[i]);
  grant_drop();
  memset(&last_reveal, 0, sizeof(last_reveal));
  memset(&st, 0, sizeof(st));
  st.seq = SEQ_NONE;
  st.flags = SF_WIPED;
  loaded = 1;
  booted = 1;
  pend.active = 0;
  state_save();
}

/* ------------------------------------------------------------ OKEDGE (DESIGN.md 5) */

void okplugin_edge_recv(uint8_t *buffer) {
  if (!(initialized == true && unlocked == true && configmode == false)) return;
  if (!ensure_identity()) {
    hidprint("Error Edge needs a key with a PIN set");
    return;
  }
  first_link_after_wipe();
  if (grant.active && millis() - grant.since > GRANT_PRESS_MS) grant_drop(); /* never pressed */
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
    case OKEDGE_LAST_REVEAL: {
      /* id u32 . step u16 . v_i 32; then mac 32 */
      if (!last_reveal.id) { hidprint("Error Edge no self-press yet"); return; }
      put32(r, last_reveal.id);
      put16(r + 4, last_reveal.step);
      memcpy(r + 6, last_reveal.value, 32);
      reply(r, 38);
      reply(last_reveal.mac, 32);
      return;
    }
    case OKEDGE_GRANT_CREATE:
      grant_create(buffer);
      return;
    case OKEDGE_GRANT_LIST: {
      /* a count report, then per live budget: id u32 . uses u16 . used u16 . flags . n . (op, slot, cap u16, used u16) x n */
      r[0] = (uint8_t)budget_count();
      reply(r, 1);
      for (int i = 0; i < MAX_LIVE; i++) {
        struct budget *b = &budgets[i];
        if (!b->id) continue;
        memset(r, 0, sizeof(r));
        put32(r, b->id);
        put16(r + 4, b->uses);
        put16(r + 6, b->used);
        r[8] = b->flags;
        r[9] = b->nscopes;
        for (int j = 0; j < b->nscopes; j++) {
          uint8_t *p = r + 10 + 6 * j;
          p[0] = b->scopes[j].op;
          p[1] = b->scopes[j].slot;
          put16(p + 2, b->scopes[j].cap);
          put16(p + 4, b->scopes[j].used);
        }
        reply(r, 10 + 6 * b->nscopes);
      }
      return;
    }
    case OKEDGE_GRANT_REVOKE: {
      uint32_t id = get32(buffer + 6);
      for (int i = 0; i < MAX_LIVE; i++) {
        if (budgets[i].id && budgets[i].id == id) {
          grant_end(i);
          hidprint("Edge budget revoked");
          return;
        }
      }
      hidprint("Error Edge no such budget");
      return;
    }
    default:
      hidprint("Error Edge unknown request");
      return;
  }
}
