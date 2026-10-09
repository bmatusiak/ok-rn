/*
 * edge - the minimal firmware half of OnlyKey Edge: the key is a NOTARY
 * (DESIGN.md section 0; owner, 2026-10-02: "the smallest minimal firmware
 * addition, because a device can only hold so much logic").
 *
 * Edge JS (node-onlykey-lib/edge) does the work - builds requests, stores the
 * chain, verifies it, pairs receipts, tracks budgets, derives the device id.
 * The key adds only what the host (the agent's own machine, the thing being
 * watched) cannot be trusted with, from facts it saw itself:
 *   1 the weld at each sign/decrypt decision, and the head that pins history;
 *   2 the budget decision (self-press, only when started) and its reveal;
 *   3 ONE signature, with a key no generic sign request reaches: a checkpoint
 *     over (seq, head). Opening a budget at a physical press answers with a
 *     checkpoint over its grant-create link, whose subject commits to G - so
 *     the budget's genesis is signed through the chain.
 *   4 the debts: every approved use owes a receipt (R16), and nothing automatic
 *     happens while one is owed (R18) until a receipt or a pressed WAIVE pays it.
 *
 * Every byte is node-onlykey-lib/edge's format (codes.js, chain.js, grants.js,
 * receipts.js); the comments name the lib function each must match. The rules
 * are onlykey-edge/build/firmware.md's (R-numbers).
 *
 * Budgets are bmatusiak/provable series (owner: "each budget has its own
 * genesis, each genesis gets started with the firmware button press by getting
 * signed"): G = H^n(seed), n <= 1024; use i reveals v_i = H^(n-i)(seed).
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
#define OP_RECEIPT 8
#define OP_LOSS 11
#define OP_GRANT_HOLD 13
#define OP_GRANT_RESUME 14
/* 15 was agent-add: retired 2026-10-08 (Brad: "the claude key thing is overkill") - a computer is trusted by its Bluetooth pairing, the key keeps no agent; never reused */
#define OP_CONTINUE 16 /* R28: the first link of a device's own chain, carrying another chain's debts */
#define DECISION_SELF_PRESS 4
#define CODE_NEEDS_REVIEW 0x8F /* a WAIVE is linked as this receipt code, with the press flag (R18) */
#define FLAG_PRESS_OBSERVED 0x01
#define FLAG_BUDGET_SPENT 0x02
#define FLAG_OWES_RECEIPT 0x10 /* R16: this use owes a receipt (decided at the sign) */

#define SEQ_NONE 0xFFFFFFFFUL
#define LINK_BYTES 64
#define ID_BYTES 16

#define MAX_LIVE 4      /* R15 */
#define MAX_SCOPES 4    /* R11 */
#define MAX_USES 1024   /* R11 (Brad, 2026-10-02: back from 255 - too few once the VM and the Pi are in the loop); up to 1,024 SHA-256 at the press and per reveal */
#define OWED_MAX 4      /* R16: owed uses kept in flash (lib receipts.OWED_MAX) */
#define HELD 8          /* links held in RAM for pickup */
#define PRESS_MS 25000UL

/* ------------------------------------------------------------ flash: one small record */

/* base + 0x1000, from the firmware's own constant so it follows OKEMU_FLASH_BASE */
#define EDGE_REGION ((uintptr_t)factorysectoradr - 0x4800)
#define EDGE_STATE_A (EDGE_REGION + 0x0000)
#define EDGE_STATE_B (EDGE_REGION + 0x0800)
/* the region's other two sectors held the pairs record until 2026-10-08 (peers and siblings left the key): only erased now */
#define EDGE_SPARE_A (EDGE_REGION + 0x1000)
#define EDGE_SPARE_B (EDGE_REGION + 0x1800)

/*
 * magic . gen . seq . head . owed_n . overflow . 0 . 0 .
 * owed x4 (seq, head) . last_link . 0 x4 . salted . cont . salt 32 .
 * cont_id 16 . check.  (The zeros held R26's replay state until 2026-10-08.)
 *
 * VERSION 1 - THE FIRST RELEASE (Brad, 2026-10-08: "v1 = first release of the protocol
 * and schemas"; 2026-10-07: "we change all the schemas to V1, because we are doing a
 * reset"). Nothing older is read. A key that finds an older record (any v0: OKEDGE06/
 * 07/08 and the development OKEDGE01) starts fresh instead: every Edge sector is
 * erased and the next Edge request draws a new salt, so a new device id and a new
 * genesis (state_load). Only the Edge region is touched: every private key stays
 * where it is (R31). A user's log is never reset this way - only a development one.
 */
#define STATE_BYTES 320 /* a multiple of 4: flash takes words (318 lost the check bytes) */
#define STATE_CHECKED 316 /* 314..315 zero padding */
#define SALTED_AT 264
#define CONT_AT 265
#define SALT_AT 266
#define CONT_ID_AT 298
#define OWED_AT 52
#define LAST_AT (OWED_AT + OWED_MAX * 36)
/*
 * "OKEDGEv1" - THE FIRST RELEASE (Brad, 2026-10-08: "v0 turns to v1, v1 = first release of
 * the protocol and schemas"). Every record before it - OKEDGE06/07/08 and the development
 * "OKEDGE01" - is v0: finding one, the key erases the Edge region and starts fresh (state_load).
 */
static const uint8_t MAGIC[8] = {'O', 'K', 'E', 'D', 'G', 'E', 'v', '1'};

struct owed_use { uint32_t seq; uint8_t head[32]; }; /* head[seq]: what its receipt subject names */

/* everything that survives a restart */
struct edge_state {
  uint32_t gen;
  uint32_t seq;               /* SEQ_NONE = no link yet */
  uint8_t head[32];           /* head[seq]; the genesis while seq == SEQ_NONE */
  uint8_t owed_n;             /* R16: uses owing a receipt, oldest first in owed[] */
  uint8_t overflow;           /* R16: an older owed use fell off the list - only a WAIVE clears it */
  struct owed_use owed[OWED_MAX];
  uint8_t last_link[LINK_BYTES]; /* the latest link, so a crash never loses it */
  /*
   * R28 (onlykey-edge firmware.md, decided 2026-10-04): ONE CHAIN PER PHYSICAL
   * DEVICE. The salt is made here on first use and lives only in this record -
   * never in the plugin backup section, and the app keeps the whole flash file
   * out of Android backup and device transfer (data_extraction_rules.xml). A
   * restored key draws a new salt (okplugin_edge_restore), so it has another Edge
   * key and another device id: its own chain from the first link, never a second writer.
   */
  uint8_t salted;
  uint8_t cont;                  /* a continue link is owed: CONT_FROM_ID (cont_id) */
  uint8_t salt[32];
  uint8_t cont_id[ID_BYTES];     /* CONT_FROM_ID: the chain the debts come from */
};
#define CONT_FROM_ID 1 /* the only continue: a backup restored here */
static struct edge_state st;
static uint8_t loaded;

/* R18: is anything owed? Then nothing automatic happens. */
static int owes(void) { return st.owed_n || st.overflow; }

/* a restore never forgives debts: the continue link carries them (R28), and they block like any other */
static int automatic_blocked(void) { return owes(); }

/* ------------------------------------------------------------ RAM only */

static struct {
  uint8_t ok;
  uint8_t pub[64];            /* the Edge public key, X||Y */
  uint8_t device_id[ID_BYTES];
} ident;

/*
 * R11a: a scope on a DERIVED code (agent sign 201-203 / 221-223) names one
 * identity - the first 16 bytes of its 32-byte derive label. Those codes are
 * shared by every derived identity of a curve; without the label a budget for
 * the agent's key would also pay for, and make owe, Brad's own logins.
 */
#define LABEL_PREFIX 16
struct scope { uint8_t op, slot; uint16_t cap, used; uint8_t has_label; uint8_t label[LABEL_PREFIX]; };
/* a live budget: RAM only - a lock or reboot is a new process, so it ends with the session (R15) */
struct budget {
  uint32_t id;
  uint8_t nscopes, on_hold;   /* on_hold: R15a - pays for nothing, nothing starts under it */
  struct scope scopes[MAX_SCOPES];
  uint16_t uses, used;
  uint32_t opened, lifetime_ms; /* R15b: millis() at the press, and how long it may live */
  uint8_t seed[32];
  uint8_t genesis[32];
};
static struct budget budgets[MAX_LIVE];

/*
 * R11a: GRANT_LABEL stages a derived-code scope's label for the NEXT
 * GRANT_CREATE (no press - it only narrows a request). A GRANT_CREATE
 * consumes them, and 25 s without one clears them.
 */
#define LABEL_STAGE_MS 25000UL
static struct {
  uint8_t set[MAX_SCOPES];
  uint8_t label[MAX_SCOPES][32];
  unsigned long since;
} staged;

/* a derived code: the identity is in the request, not in the slot (R11a) */
static int derived_code(uint8_t slot) {
  return (slot >= 201 && slot <= 203) || (slot >= 221 && slot <= 223);
}

/*
 * R13a: ONE self-press, started by TX start {head}. RAM only, and any link clears it
 * (append) - so it is spent by the very next sign/decrypt, whatever it decides,
 * and a lock or reboot drops it.
 */
static uint8_t started;
/*
 * R13a (2026-10-02): the TX start is bound to ONE request, not just the head:
 *   token = SHA256("OKEDGE-TX-v1" || head || subject || intent)
 * subject = pend.subject, SHA-256 of exactly the bytes handed to
 * okcore_prime_user_confirmation. The key recomputes it from ITS head when the
 * next sign/decrypt is primed; a program that slips in between the agent's TX start
 * and its sign gets a press, never a free signature - and uses the TX start up.
 */
static uint8_t tx_token[32];
/*
 * R13b (Brad, 2026-10-06): the use says what it's for BEFORE it happens.
 * TX start {token, intent}: intent = the first 16 bytes of SHA256("OKEDGE-INTENT-v1" ||
 * intent text), token = SHA256("OKEDGE-TX-v1" || head || subject || intent); the
 * self-press link then carries the intent in bytes 47-62 (63 stays zero), so the
 * reason is welded into the chain before the signature exists.
 * ONE formula (the TX start rename, 2026-10-07): a use that names no intent sends 16
 * zero bytes, the token covers them like any other, and the link carries no intent.
 * The old split (OKEDGE-ARM-v1 without an intent, -v2 with one) is gone; lib and
 * firmware change together, and nothing stored holds a token.
 */
static uint8_t tx_intent[16];
static uint8_t tx_has_intent;
/* the intent the next append_scoped writes into bytes 47-62 (a self-press with an intent), then cleared */
static const uint8_t *next_intent;

/*
 * B7 stage 2 (spec, 2026-10-04): TX starts this key refused since power-up, in HEAD
 * byte 60. RAM only - a refused TX start writes no link (any host could flood the
 * chain and wear the flash), so this count is the key's own evidence; the
 * phone's watcher alarms when it rises. Stops at 255.
 */
static uint8_t refused_tx;
static void status(uint8_t code);
static void refuse_tx(uint8_t code) {
  if (refused_tx < 255) refused_tx++;
  status(code);
}

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
  uint8_t has_intent; /* R13b: a v2 start matched - its intent goes into the self-press link */
  uint8_t refuse;     /* R13a: the status to refuse this request with (0 = none) - not the TX start's request, or no budget can pay it now */
  uint8_t intent[16];
  int8_t budget;
  uint8_t subject[32];
  /* R11a: on a derived code, the identity's label prefix - the request's last 32 bytes are its label */
  uint8_t has_label;
  uint8_t label[LABEL_PREFIX];
} pend;

/*
 * An OKEDGE request waiting for its PHYSICAL press: opening a budget (R10),
 * resuming one (R15a) or waiving the debts (R18). One at a time; a new one
 * replaces it.
 */
enum { PRESS_GRANT = 1, PRESS_RESUME, PRESS_WAIVE, PRESS_LOSS };
static struct {
  uint8_t what;
  unsigned long since;
  uint32_t id;                /* PRESS_RESUME: the budget; PRESS_LOSS: to */
  uint32_t from;              /* PRESS_LOSS: from */
  /*
   * R27: the head the host verified its copy up to (GRANT_CREATE: its first
   * GRANT_HEAD_BYTES, all that fits; GRANT_RESUME: all 32). Checked when the
   * request arrives AND again at the press: a link written while the key waits
   * would otherwise open the budget on a history the host never checked.
   */
  uint8_t verified[32];
  uint8_t verified_len;
  struct budget b;            /* PRESS_GRANT: the budget to open */
  uint8_t reason[32];
  uint8_t scopes_enc[1 + 4 * MAX_SCOPES];
  uint8_t scopes_len;
  uint16_t lifetime;          /* PRESS_GRANT: R15b minutes, 0 = DEFAULT_LIFETIME_MIN */
  uint8_t labels[MAX_SCOPES][32]; /* PRESS_GRANT: R11a, the FULL labels of derived-code scopes, for the subject */
} press;

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

/* seq . head: RECEIPT's, WAIVE's and LOSS's answer - the head the agent passes to the next TX start (R13a) */
static void reply_seq_head(void) {
  uint8_t r[36];
  put32(r, st.seq);
  memcpy(r + 4, st.head, 32);
  reply(r, 36);
}

/* ------------------------------------------------------------ the record */

static void state_encode(uint8_t rec[STATE_BYTES]) {
  uint8_t check[32];
  memset(rec, 0, STATE_BYTES);
  memcpy(rec, MAGIC, 8);
  put32(rec + 8, st.gen);
  put32(rec + 12, st.seq);
  memcpy(rec + 16, st.head, 32);
  rec[48] = st.owed_n;
  rec[49] = st.overflow;
  for (int i = 0; i < OWED_MAX; i++) {
    put32(rec + OWED_AT + 36 * i, st.owed[i].seq);
    memcpy(rec + OWED_AT + 36 * i + 4, st.owed[i].head, 32);
  }
  memcpy(rec + LAST_AT, st.last_link, LINK_BYTES);
  rec[SALTED_AT] = st.salted;
  rec[CONT_AT] = st.cont;
  memcpy(rec + SALT_AT, st.salt, 32);
  memcpy(rec + CONT_ID_AT, st.cont_id, ID_BYTES);
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
  s->owed_n = rec[48] > OWED_MAX ? OWED_MAX : rec[48];
  s->overflow = rec[49];
  for (int i = 0; i < OWED_MAX; i++) {
    s->owed[i].seq = get32(rec + OWED_AT + 36 * i);
    memcpy(s->owed[i].head, rec + OWED_AT + 36 * i + 4, 32);
  }
  memcpy(s->last_link, rec + LAST_AT, LINK_BYTES);
  s->salted = rec[SALTED_AT] == 1;
  s->cont = rec[CONT_AT] == CONT_FROM_ID ? CONT_FROM_ID : 0;
  memcpy(s->salt, rec + SALT_AT, 32);
  memcpy(s->cont_id, rec + CONT_ID_AT, ID_BYTES);
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

/* an Edge record of a version before the clean start (OKEDGE06, 07, 08) */
static int old_record(const uint8_t rec[8]) {
  return memcmp(rec, "OKEDGE0", 7) == 0 && rec[7] != '1';
}

static void fresh_start(void); /* below: the whole Edge region erased */

static void state_load(void) {
  if (loaded) return;
  uint8_t rec[STATE_BYTES];
  struct edge_state a, b;
  okcore_flashget_common(rec, (unsigned long *)EDGE_STATE_A, STATE_BYTES);
  int ha = state_decode(rec, &a);
  int olda = old_record(rec);
  okcore_flashget_common(rec, (unsigned long *)EDGE_STATE_B, STATE_BYTES);
  int hb = state_decode(rec, &b);
  int oldb = old_record(rec);
  if (ha && (!hb || a.gen > b.gen)) st = a;
  else if (hb) st = b;
  else {
    /* THE CLEAN START (v1): a record from before it - the whole Edge region goes */
    if (olda || oldb) fresh_start();
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
static int edge_secret_salted(const char *info, const uint8_t *salt33, uint8_t out[32]) {
  uint8_t t = 0;
  if (profilemode == NONENCRYPTEDPROFILE) return 0;
  okeeprom_eeget_ecckey(&t, 132);
  if (t == 0) return 0; /* no K132: no PIN set yet */
  uint8_t save_priv[32], save_pub[65], save_type = type;
  memcpy(save_priv, ecc_private_key, 32);
  memcpy(save_pub, ecc_public_key, 65);
  int ok = okcore_flashget_ECC(132) != 0;
  if (ok) okcrypto_hkdf_info(salt33, ecc_private_key, out, 32, (const uint8_t *)info, strlen(info));
  memcpy(ecc_private_key, save_priv, 32);
  memcpy(ecc_public_key, save_pub, 65);
  type = save_type;
  memset(save_priv, 0, 32);
  return ok;
}


/*
 * R28: the Edge checkpoint key - and so the device id and the genesis - is
 * HKDF(salt = 0x28 . this device's salt, K132, "onlykey/edge/v1"). ONLY this
 * key takes the salt: every derived identity (SSH, PGP, the agents' keys) is
 * K132's alone and stays the same across R28 (tested before == after). Since
 * the clean start (v1) there is no Edge key without a salt: ensure_identity
 * draws one before anything asks for the key.
 */
static int edge_key_with(const struct edge_state *s, uint8_t priv[32]) {
  if (!s->salted) return 0;
  uint8_t salt33[33];
  salt33[0] = 0x28;
  memcpy(salt33 + 1, s->salt, 32);
  int ok = edge_secret_salted("onlykey/edge/v1", salt33, priv);
  memset(salt33, 0, sizeof(salt33));
  return ok;
}
static int edge_private_key(uint8_t priv[32]) { return edge_key_with(&st, priv); }

static void append(uint8_t op, uint8_t decision, uint8_t slot, uint8_t flags, const uint8_t subject[32],
    uint32_t grant_id, uint16_t grant_step, const uint8_t *reveal);
static void append_scoped(uint8_t op, uint8_t decision, uint8_t slot, uint8_t flags, const uint8_t subject[32],
    uint32_t grant_id, uint16_t grant_step, uint8_t scope, const uint8_t *reveal);

/* device_id = SHA256("OKEDGE-DEVICE-v1" || pubkey)[0..16] - edge JS computes it the same way */
static int identity_of(const struct edge_state *s, uint8_t pub[64], uint8_t id[ID_BYTES]) {
  uint8_t priv[32], h[32];
  if (!edge_key_with(s, priv)) return 0;
  int ok = uECC_compute_public_key(priv, pub, uECC_secp256r1());
  memset(priv, 0, 32);
  if (!ok) return 0;
  H(h, "OKEDGE-DEVICE-v1", pub, 64, NULL, 0, NULL, 0);
  memcpy(id, h, ID_BYTES);
  return 1;
}

/*
 * R28 continue: the first link of this device's own chain. It takes the NEXT
 * seq after the chain it continues (so a carried debt's seq never meets one of
 * the new chain's) and is welded onto the NEW genesis, not the old head:
 *   op = continue, decision = approve, flags 0 (no press: a restore or a
 *   firmware update already needed the person), grant_id = debts carried,
 *   subject = SHA256("OKEDGE-CONTINUE-v1" || old device_id 16 || old seq u32 ||
 *             old head 32 || each carried debt's seq u32, oldest first)
 * The debts (seq + head) stay owed here and are paid by receipt or waive on this
 * chain; the hosts keep the old copy and its checkpoint key beside it, so the
 * old history stays checkable up to the head this names. Live budgets end.
 */
static void write_continue(const uint8_t old_id[ID_BYTES]) {
  uint8_t buf[ID_BYTES + 4 + 32 + 4 * OWED_MAX], subject[32];
  memcpy(buf, old_id, ID_BYTES);
  put32(buf + ID_BYTES, st.seq);
  memcpy(buf + ID_BYTES + 4, st.head, 32);
  for (int i = 0; i < st.owed_n; i++) put32(buf + ID_BYTES + 36 + 4 * i, st.owed[i].seq);
  H(subject, "OKEDGE-CONTINUE-v1", buf, ID_BYTES + 36 + 4 * st.owed_n, NULL, 0, NULL, 0);
  memset(budgets, 0, sizeof(budgets));
  memset(held, 0, sizeof(held));
  started = 0;
  st.cont = 0;
  memset(st.cont_id, 0, ID_BYTES);
  /* head[-1] of the new chain = SHA256("OKEDGE-GENESIS-v1" || new device_id) */
  H(st.head, "OKEDGE-GENESIS-v1", ident.device_id, ID_BYTES, NULL, 0, NULL, 0);
  append(OP_CONTINUE, OKEDGE_DECISION_APPROVE, 0, 0, subject, st.owed_n, 0, NULL);
  state_save();
}

/* the public key and device id (RAM), and the genesis on a new chain; 0 without K132 */
static int ensure_identity(void) {
  state_load();
  if (ident.ok) return 1;
  /*
   * R28: no salt yet - a new key, a key after the clean start, or a backup
   * restored here (which then continues that chain, CONT_FROM_ID).
   * The salt is made now. Since v1 there is no unsalted chain to continue.
   */
  if (!st.salted) {
    uint8_t t = 0;
    okeeprom_eeget_ecckey(&t, 132);
    if (profilemode == NONENCRYPTEDPROFILE || t == 0) return 0; /* no K132 yet: nothing to salt for */
    RNG2(st.salt, 32);
    st.salted = 1;
    state_save();
  }
  if (!identity_of(&st, ident.pub, ident.device_id)) return 0;
  ident.ok = 1;
  if (st.cont == CONT_FROM_ID) {
    uint8_t old_id[ID_BYTES];
    memcpy(old_id, st.cont_id, ID_BYTES);
    write_continue(old_id);
    return 1;
  }
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

/*
 * THE OWNER STATEMENT (Brad, 2026-10-08): "if it has the private ecc key to sign the
 * block, then i want the log"; a device gives "its own name for its device fingerprint in
 * the block" - its NAMETAG. The owner key is HKDF(K132, "onlykey/edge/owner/v1") with NO
 * salt, so it is the same on every device made from the same backup: any of them can tell
 * a log "made with our key" without a salt ever leaving its device (R28). The key signs
 * only a statement about ITSELF - its device id, its checkpoint key, its current seq - and
 * the hash of a nametag the host gives. No press and no link: it writes nothing (the rule:
 * a link only for a press or a budget's use). The nametag is a label - the signature
 * proves the key, not the words.
 *   digest = SHA256("OKEDGE-STATEMENT-v1" || device id 16 || checkpoint pubkey 64 ||
 *                   seq u32 LE || nametag hash 32)        (lib grants.statementDigest)
 * reply: seq . nametag hash, then the owner public key (X || Y), then the signature.
 */
static void statement(const uint8_t nametag_hash[32]) {
  uint8_t who[ID_BYTES + 64], seq4[4], digest[32], priv[32], pub[64], sig[64], r[36];
  memcpy(who, ident.device_id, ID_BYTES);
  memcpy(who + ID_BYTES, ident.pub, 64);
  put32(seq4, st.seq);
  H(digest, "OKEDGE-STATEMENT-v1", who, sizeof(who), seq4, 4, nametag_hash, 32);
  int ok = edge_secret_salted("onlykey/edge/owner/v1", NULL, priv)
        && uECC_compute_public_key(priv, pub, uECC_secp256r1())
        && uECC_sign(priv, digest, 32, sig, uECC_secp256r1());
  memset(priv, 0, 32);
  if (!ok) { status(EDGE_SIGN_FAILED); return; }
  memcpy(r, seq4, 4);
  memcpy(r + 4, nametag_hash, 32);
  reply(r, 36);
  reply(pub, 64);
  reply(sig, 64);
}

/* ------------------------------------------------------------ the weld */

/* SHA256("OKEDGE-WAIVE-v1" || each owed seq (u32 LE, oldest first) || overflow) (lib receipts.waiveSubject) */
static void waive_subject(const struct edge_state *s, uint8_t out[32]) {
  uint8_t seq4[4], ov = s->overflow ? 1 : 0;
  SHA256_CTX ctx;
  sha256_init(&ctx);
  sha256_update(&ctx, (const unsigned char *)"OKEDGE-WAIVE-v1", 15);
  for (int i = 0; i < s->owed_n; i++) {
    put32(seq4, s->owed[i].seq);
    sha256_update(&ctx, seq4, 4);
  }
  sha256_update(&ctx, &ov, 1);
  sha256_final(&ctx, out);
}

/*
 * THE weld - the one function every link goes through:
 *   head[n] = SHA256("OKEDGE-LINK-v1" || head[n-1] || link[n])   (lib chain.weld)
 * then the debt rule (R16-R18; lib receipts.keyDebts follows the same rule):
 *   - an approved sign/decrypt whose link carries owes_receipt (bit 4, set at the
 *     sign by the R16 rule - see okplugin_edge_decision) owes a receipt. The key
 *     keeps the latest 4; a 5th pushes the oldest off for good (overflow: only
 *     a WAIVE clears it). Only a human press can make a 5th (R18);
 *   - a WAIVE - a receipt with code 0x8F, the press flag and the subject over
 *     exactly this list and overflow - clears the list and the overflow;
 *   - any other receipt pays its ref_seq, if that use is still on the list;
 * and persists it before the operation's result is released (R4).
 * `s`: the state it welds into - the record (st: saved, held for pickup).
 */
static int weld_in(struct edge_state *s, const uint8_t link[LINK_BYTES], const uint8_t *reveal) {
  uint8_t head[32], w[32];
  uint32_t seq = get32(link);
  H(head, "OKEDGE-LINK-v1", s->head, 32, link, LINK_BYTES, NULL, 0);

  uint8_t op = link[4], decision = link[5];
  if (op == OP_SIGN || op == OP_DECRYPT) {
    if ((decision == OKEDGE_DECISION_APPROVE || decision == DECISION_SELF_PRESS) && (link[7] & FLAG_OWES_RECEIPT)) {
      if (s->owed_n == OWED_MAX) {
        memmove(&s->owed[0], &s->owed[1], sizeof(s->owed[0]) * (OWED_MAX - 1));
        s->owed_n--;
        s->overflow = 1;
      }
      s->owed[s->owed_n].seq = seq;
      memcpy(s->owed[s->owed_n].head, head, 32);
      s->owed_n++;
    }
  } else if (op == OP_RECEIPT) {
    waive_subject(s, w);
    if (decision == CODE_NEEDS_REVIEW && (link[7] & FLAG_PRESS_OBSERVED) && memcmp(link + 8, w, 32) == 0) {
      s->owed_n = 0;
      s->overflow = 0;
    } else {
      uint32_t ref = get32(link + 40);
      for (int k = 0; k < s->owed_n; k++) {
        if (s->owed[k].seq != ref) continue;
        memmove(&s->owed[k], &s->owed[k + 1], sizeof(s->owed[0]) * (s->owed_n - k - 1));
        s->owed_n--;
        break;
      }
    }
    memset(&s->owed[s->owed_n], 0, sizeof(s->owed[0]) * (OWED_MAX - s->owed_n));
  }
  s->seq = seq;
  memcpy(s->head, head, 32);
  memcpy(s->last_link, link, LINK_BYTES);
  started = 0; /* R13a: any link spends or clears the TX start */
  if (s == &st) {
    state_save();
    hold(seq, link, head, reveal);
  }
  return 1;
}

/* A link the key writes itself (lib chain.encodeLink), as its next seq. */
static void append(uint8_t op, uint8_t decision, uint8_t slot, uint8_t flags, const uint8_t subject[32],
    uint32_t grant_id, uint16_t grant_step, const uint8_t *reveal) {
  append_scoped(op, decision, slot, flags, subject, grant_id, grant_step, 0, reveal);
}

/*
 * R3 (2026-10-03): byte 46 = which of the budget's scopes paid, 1-based, on a
 * link that spends a budget (flags BUDGET_SPENT); 0 on every other link (and on
 * every link before this). The step and the subject cannot say it - two scopes
 * on the same op+slot (two identities on slot 221) differ only by label - and
 * the card and a verifier need each identity's own count. Bytes 47-63 stay
 * reserved zero.
 */
static void append_scoped(uint8_t op, uint8_t decision, uint8_t slot, uint8_t flags, const uint8_t subject[32],
    uint32_t grant_id, uint16_t grant_step, uint8_t scope, const uint8_t *reveal) {
  uint8_t link[LINK_BYTES];
  memset(link, 0, sizeof(link));
  link[46] = scope;
  if (next_intent) { memcpy(link + 47, next_intent, 16); next_intent = NULL; } /* R13b */
  link[63] = OKEDGE_LINK_VERSION; /* R3: future format changes are version 2 in the same chain */
  put32(link, st.seq == SEQ_NONE ? 0 : st.seq + 1);
  link[4] = op;
  link[5] = decision;
  link[6] = slot;
  link[7] = flags;
  memcpy(link + 8, subject, 32);
  put32(link + 40, grant_id);
  put16(link + 44, grant_step);
  weld_in(&st, link, reveal);
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
 * R15b: a budget lives `lifetime` minutes from its press (0 = 12 hours -
 * Brad, 2026-10-02: long enough to step away for lunch). millis() counts from boot, and a reboot ends every
 * budget anyway (R15), so the clock never resets inside a budget's life - the
 * same works on a hard key, which has no real-time clock. Wrap-safe like the
 * 25 s press window. An expired budget is simply gone: it pays for nothing,
 * HEAD stops listing it, and its slot is free; no grant-end link (like a
 * reboot) - the host tells expiry apart from the lifetime in its opening link.
 */
#define DEFAULT_LIFETIME_MIN 720
static int alive(const struct budget *b) {
  return b->id && (uint32_t)(millis() - b->opened) <= b->lifetime_ms;
}

/* unlocked, out of config mode, nothing owed (R18), not restoring (R26): the only state a budget can pay in */
static int budgets_may_pay(void) {
  return unlocked == true && configmode == false && !automatic_blocked();
}

/* why nothing automatic may happen now: restoring first (the person finishes it), else a debt */
static uint8_t blocked_status(void) { return EDGE_RECEIPT_OWED; }

/* R27: does the head the host verified (its first n bytes) still match the key's? */
static int head_is(const uint8_t *verified, uint8_t n) { return memcmp(verified, st.head, n) == 0; }

/*
 * The live budget that pays for this use: started (R13a), not on hold (R15a), a
 * scope with room. Anything else falls back to the press the person sees -
 * never a refusal path of its own.
 */
/* R11a: a scope matches op and slot - and, on a derived code, the identity's label */
static int scope_matches(const struct scope *sc, uint8_t op, uint8_t slot, const uint8_t *label) {
  if (sc->op != op || sc->slot != slot) return 0;
  if (!sc->has_label) return 1;
  return label && memcmp(sc->label, label, LABEL_PREFIX) == 0;
}

static int budget_for(uint8_t op, uint8_t slot, const uint8_t *label, struct scope **sc_out) {
  if (!started || !budgets_may_pay()) return -1;
  for (int i = 0; i < MAX_LIVE; i++) {
    struct budget *b = &budgets[i];
    if (!alive(b) || b->on_hold || b->used >= b->uses) continue;
    for (int j = 0; j < b->nscopes; j++) {
      struct scope *sc = &b->scopes[j];
      if (scope_matches(sc, op, slot, label) && sc->used < sc->cap) {
        *sc_out = sc;
        return i;
      }
    }
  }
  return -1;
}

/* (R16's "covered" check went 2026-10-06: an ordinary press is not Edge and owes nothing) */


/* R13a: TX start needs a budget that could pay for something - live, not on hold, uses left */
static int any_budget_payable(void) {
  for (int i = 0; i < MAX_LIVE; i++)
    if (alive(&budgets[i]) && !budgets[i].on_hold && budgets[i].used < budgets[i].uses) return 1;
  return 0;
}

static struct budget *live_budget(uint32_t id) {
  for (int i = 0; i < MAX_LIVE; i++) if (id && budgets[i].id == id && alive(&budgets[i])) return &budgets[i];
  return NULL;
}

static void press_drop(void) {
  memset(&press, 0, sizeof(press));
}

/* wait for the physical press; okplugin_edge_primed forces it (USER_INPUT_PRESS) */
static void press_wait(uint8_t what, const uint8_t subject[32]) {
  press.what = what;
  press.since = millis();
  okcore_prime_user_confirmation(OKEDGE, 0, (uint8_t *)subject, 32);
}

/*
 * GRANT_CREATE: [6] scope count, [7..22] scopes (op, slot, cap u16 LE) x4,
 * [23..54] reason_hash, [55..62] the first GRANT_HEAD_BYTES of the head the
 * host verified its copy up to (R27; CHOSEN - a report has no room for all 32).
 * The seed and G = H^n(seed) are made here; the budget opens only on a
 * PHYSICAL press, never while a receipt is owed or a restore is unfinished
 * (R10, R18, R26), and never on a head the host did not verify.
 */
/* R11a: GRANT_LABEL {scope index u8, label 32} - no press, no link; it only narrows the next GRANT_CREATE */
static void grant_label(const uint8_t *buffer) {
  uint8_t j = buffer[6];
  if (j >= MAX_SCOPES) { status(EDGE_BAD_SCOPES); return; }
  if (!staged.since || (unsigned long)(millis() - staged.since) > LABEL_STAGE_MS) memset(&staged, 0, sizeof(staged));
  memcpy(staged.label[j], buffer + 7, 32);
  staged.set[j] = 1;
  staged.since = millis();
  if (!staged.since) staged.since = 1; /* 0 means "nothing staged" */
  status(EDGE_OK);
}

#define GRANT_HEAD_BYTES 6
static void grant_create(const uint8_t *buffer) {
  uint8_t n = buffer[6];
  unsigned uses = 0;
  /* R11a: this GRANT_CREATE consumes what GRANT_LABEL staged - fresh only (25 s) */
  int fresh = staged.since && (unsigned long)(millis() - staged.since) <= LABEL_STAGE_MS;
  uint8_t have[MAX_SCOPES];
  uint8_t labels[MAX_SCOPES][32];
  memcpy(have, staged.set, sizeof(have));
  memcpy(labels, staged.label, sizeof(labels));
  memset(&staged, 0, sizeof(staged));
  press_drop();
  if (automatic_blocked()) { status(blocked_status()); return; }
  if (!head_is(buffer + 58, GRANT_HEAD_BYTES)) { status(EDGE_STALE_HEAD); return; }
  memcpy(press.verified, buffer + 58, GRANT_HEAD_BYTES);
  press.lifetime = get16(buffer + 56);
  press.verified_len = GRANT_HEAD_BYTES;
  if (n < 1 || n > MAX_SCOPES) { status(EDGE_BAD_SCOPES); return; }
  press.scopes_enc[0] = n;
  for (int j = 0; j < n; j++) {
    const uint8_t *p = buffer + 7 + 4 * j;
    struct scope *sc = &press.b.scopes[j];
    sc->op = p[0];
    sc->slot = p[1];
    sc->cap = get16(p + 2);
    if (!scope_allowed(sc->op, sc->slot) || sc->cap < 1) { press_drop(); status(EDGE_SCOPE_NOT_ALLOWED); return; }
    if (derived_code(sc->slot)) {
      /* R11a: a derived code names one identity, or the budget is refused (EDGE:03) */
      if (!fresh || !have[j]) { press_drop(); status(EDGE_SCOPE_NOT_ALLOWED); return; }
      sc->has_label = 1;
      memcpy(sc->label, labels[j], LABEL_PREFIX);
      memcpy(press.labels[j], labels[j], 32);
    }
    uses += sc->cap;
    memcpy(press.scopes_enc + 1 + 4 * j, p, 4);
  }
  if (uses > MAX_USES) { press_drop(); status(EDGE_TOO_MANY_USES); return; }
  press.scopes_len = 1 + 4 * n;
  press.b.nscopes = n;
  press.b.uses = (uint16_t)uses;
  memcpy(press.reason, buffer + 23, 32);
  RNG2(press.b.seed, 32);
  hash_times(press.b.genesis, press.b.seed, press.b.uses);
  uint8_t what[32];
  H(what, NULL, press.reason, 32, press.b.genesis, 32, press.scopes_enc, press.scopes_len);
  press_wait(PRESS_GRANT, what);
}

/*
 * The press: link grant-create, whose subject commits to the budget's genesis
 *   SHA256("OKEDGE-GRANT-v1" || scopes || reason_hash || G)   (lib grants.grantSubject)
 * and answer with a checkpoint over that link - the key's signature on G.
 * reply: id u32 . uses u16 . G 32 . the link's seq u32; then the checkpoint.
 */
static void grant_pressed(void) {
  int slot = -1;
  if (automatic_blocked()) { status(blocked_status()); return; } /* a use slipped in while it waited */
  if (!head_is(press.verified, press.verified_len)) { status(EDGE_STALE_HEAD); return; }
  for (int i = 0; i < MAX_LIVE; i++) if (!alive(&budgets[i])) { slot = i; break; } /* an expired budget's slot is free */
  if (slot < 0) { status(EDGE_LIVE_FULL); return; }

  uint32_t seq = st.seq == SEQ_NONE ? 0 : st.seq + 1;
  uint32_t id = seq + 1; /* the seq of its grant-create link, plus one (0 = no budget) */
  uint8_t subject[32], r[42];
  SHA256_CTX ctx;
  sha256_init(&ctx);
  sha256_update(&ctx, (const unsigned char *)"OKEDGE-GRANT-v1", 15);
  sha256_update(&ctx, press.scopes_enc, press.scopes_len);
  sha256_update(&ctx, press.reason, 32);
  sha256_update(&ctx, press.b.genesis, 32);
  uint8_t life[2];
  put16(life, press.lifetime);
  sha256_update(&ctx, life, 2); /* R12 + R15b: the subject ends with the lifetime the person approved */
  /* R11a: then the FULL labels of derived-code scopes, in scope order - the identities the person approved */
  for (int j = 0; j < press.b.nscopes; j++)
    if (press.b.scopes[j].has_label) sha256_update(&ctx, press.labels[j], 32);
  sha256_final(&ctx, subject);
  press.b.id = id;
  press.b.opened = millis();
  press.b.lifetime_ms = (uint32_t)(press.lifetime ? press.lifetime : DEFAULT_LIFETIME_MIN) * 60000UL;
  budgets[slot] = press.b;
  /* R3: the opening carries its scope count in byte 46, so every spend of it must name one of 1..N */
  append_scoped(OP_GRANT_CREATE, OKEDGE_DECISION_APPROVE, 0, FLAG_PRESS_OBSERVED, subject, id, 0, press.b.nscopes, NULL);

  put32(r, id);
  put16(r + 4, press.b.uses);
  memcpy(r + 6, press.b.genesis, 32);
  put32(r + 38, seq);
  reply(r, 42);
  checkpoint();
}

/* R15a: the press that lets a held budget pay again (refused while a receipt is owed, R18) */
static void resume_pressed(void) {
  struct budget *b = live_budget(press.id);
  if (!b) { status(EDGE_NO_SUCH_BUDGET); return; }
  if (automatic_blocked()) { status(blocked_status()); return; }
  if (!head_is(press.verified, press.verified_len)) { status(EDGE_STALE_HEAD); return; }
  if (b->on_hold) {
    uint8_t zero[32] = {0};
    b->on_hold = 0;
    append(OP_GRANT_RESUME, OKEDGE_DECISION_APPROVE, 0, FLAG_PRESS_OBSERVED, zero, b->id, 0, NULL);
  }
  status(EDGE_OK);
}

/*
 * R18: the way out for debts nobody will receipt - one press clears them all.
 * Linked as a receipt, code 0x8F (needs review), the press flag, grant_id = the
 * oldest seq it waives, and
 *   subject = SHA256("OKEDGE-WAIVE-v1" || each waived seq (u32 LE, oldest first) || overflow)
 * (lib receipts.waiveSubject). With overflow and an empty list (every listed
 * debt was receipted, older ones fell off), grant_id is the waive's own seq:
 * the lib then reads every older unpaid use as "waived, not listed".
 */
static void waive_pressed(void) {
  if (!owes()) { status(EDGE_NO_RECEIPT_WAITING); return; } /* paid while it waited */
  uint8_t subject[32];
  uint32_t oldest = st.owed_n ? st.owed[0].seq : (st.seq == SEQ_NONE ? 0 : st.seq + 1);
  waive_subject(&st, subject);
  append(OP_RECEIPT, CODE_NEEDS_REVIEW, 0, FLAG_PRESS_OBSERVED, subject, oldest, 0, NULL); /* the weld clears the debts */
  reply_seq_head();
}

/*
 * R24 LOSS subject: to (u32 LE), then the first 28 bytes of SHA-256(link to+1)
 * when the key holds that link - its latest, or one in the ring - from its own
 * memory (Brad, 2026-10-02). Its predecessor is in the lost range, so its own
 * bytes can never be welded again; this is the key naming them, and a host
 * counts the copy's #to+1 only when it hashes to this. Not held (or past the
 * head): zeros, and the host offers #from..#to+1 instead.
 */
static void loss_subject(uint32_t to, uint8_t subject[32]) {
  memset(subject, 0, 32);
  put32(subject, to);
  if (st.seq == SEQ_NONE || to == SEQ_NONE || to >= st.seq) return; /* no link to+1 in this chain */
  uint32_t next = to + 1;
  const uint8_t *link = NULL;
  if (next == st.seq) link = st.last_link;
  else {
    struct held_link *h = &held[next % HELD];
    if (h->used && h->seq == next) link = h->link;
  }
  if (!link) return;
  uint8_t d[32];
  H(d, NULL, link, LINK_BYTES, NULL, 0, NULL, 0);
  memcpy(subject + 4, d, 28);
}

/*
 * R24 LOSS {from, to}, a press (firmware.md R24; built ahead of the rest of E5
 * for the tab's red banner, Brad 2026-10-02): the person accepts #from..#to as
 * unrecoverable - no copy anywhere holds it. One link, op = loss, decision
 * approve, slot 0, the press flag, grant_id = from, subject = loss_subject(to)
 * It records the acceptance; it
 * pays no debt (R16: only a receipt or a waive does). A host then accepts a gap
 * covered by it under R27. reply: seq . head after it.
 */
static void loss_pressed(void) {
  uint8_t subject[32];
  loss_subject(press.id, subject);
  append(OP_LOSS, OKEDGE_DECISION_APPROVE, 0, FLAG_PRESS_OBSERVED, subject, press.from, 0, NULL);
  reply_seq_head();
}


/*
 * NO PEERS, SIBLINGS, SYNC OR ANCHORS ON THE KEY (Brad, 2026-10-08): "sync ... is a basic p2p
 * style way to combine 2 blockchains into 1, the blocks are signed, so i honestly dont think
 * firmware changes were needed here". Every block is signed by its own key's checkpoint, so
 * the lib joins two chains and checks each against its own key; the phone keeps its own
 * approved lists. The key keeps only what a hostile host could otherwise cheat (firmware.md
 * §3.2) - and its 600-byte pairs record and ~1.5 KB of code went with this.
 */

/* ------------------------------------------------------------ hooks */

void okplugin_edge_primed(uint8_t opcode, uint8_t slot, const uint8_t *msg, size_t msg_len) {
  pend.active = 0;
  pend.budget = -1;
  if (opcode == OKEDGE) {
    user_input_mode = USER_INPUT_PRESS; /* a grant, resume or waive always takes a physical press */
    return;
  }
  if (opcode != OKSIGN && opcode != OKDECRYPT) return;
  pend.active = 1;
  pend.has_intent = 0;
  pend.refuse = 0;
  pend.opcode = opcode;
  pend.slot = slot;
  H(pend.subject, NULL, msg, msg_len, NULL, 0, NULL, 0); /* SHA-256 of exactly what was submitted */
  /* R11a: an agent request is message || identity label (32): the label picks the derived key */
  pend.has_label = derived_code(slot) && msg_len >= 32;
  if (pend.has_label) memcpy(pend.label, msg + msg_len - 32, LABEL_PREFIX);
  state_load();
  if (started) {
    /* R13a: this request, after THIS head, is the one the TX start was for - or the TX start is spent */
    uint8_t t[32];
    H(t, "OKEDGE-TX-v1", st.head, 32, pend.subject, 32, tx_intent, 16); /* R13b: zeros when no intent */
    if (memcmp(t, tx_token, 32) != 0) {
      /*
       * R13a (spec session, 2026-10-06): a request that is not the one the TX start
       * was for is REFUSED, not pressed - no prompt, no link. The TX start is used up
       * (the agent TX starts again) and HEAD byte 60 counts it with the refused TX starts.
       * No press: the core runs the request at once and okplugin_edge_refused()
       * answers EDGE:1C before anything is signed.
       */
      started = 0;
      pend.refuse = EDGE_TX_MISMATCH;
      if (refused_tx < 255) refused_tx++;
      user_input_mode = USER_INPUT_NONE;
      pend.press = 0;
      return;
    }
    else if (tx_has_intent) { pend.has_intent = 1; memcpy(pend.intent, tx_intent, 16); }
  }
  struct scope *sc;
  int i = budget_for(opcode == OKSIGN ? OP_SIGN : OP_DECRYPT, slot, pend.has_label ? pend.label : NULL, &sc);
  if (i >= 0) {
    pend.budget = (int8_t)i;
    user_input_mode = USER_INPUT_NONE; /* an started budget pays: the firmware's own no-press path runs it (R13) */
  } else if (started) {
    /*
     * The announced request, but its budget expired, was held or ended in between: no
     * budget pays, so it is an ordinary request - the person's press decides, and an
     * ordinary press writes no link. The TX start is spent here, or the person's own next
     * request would meet it and be refused as a mismatch. (Brad, 2026-10-08: refusing it
     * was a misreading of "budget or no go", which only means nothing goes on the chain
     * without a budget behind it; firmware.md R13a.)
     */
    started = 0;
  }
  pend.press = user_input_mode != USER_INPUT_NONE;
}

void okplugin_edge_decision(int decision) {
  if (packet_buffer_details[0] == OKEDGE) {
    uint8_t what = press.what;
    int fresh = what && millis() - press.since <= PRESS_MS;
    if (decision != OKEDGE_DECISION_APPROVE || !fresh) { press_drop(); return; }
    if (!ensure_identity()) { press_drop(); status(EDGE_NEED_PIN); return; }
    if (what == PRESS_GRANT) grant_pressed();
    else if (what == PRESS_RESUME) resume_pressed();
    else if (what == PRESS_WAIVE) waive_pressed();
    else if (what == PRESS_LOSS) loss_pressed();
    press_drop();
    return;
  }
  if (!pend.active) return;
  if (decision == OKEDGE_DECISION_APPROVE && packet_buffer_details[0] != pend.opcode) return;
  pend.active = 0;
  if (!ensure_identity()) return; /* no K132 yet: nothing to chain to */
  uint8_t op = pend.opcode == OKSIGN ? OP_SIGN : OP_DECRYPT;
  /*
   * Only a budget use is linked (R1, R16; Brad, 2026-10-08: "no unattended press, unless
   * its an approved budget that can be logged into the blockchain"): the self-press a
   * live budget pays, which owes a receipt. A budget only ever pays a started request
   * (budget_for), so the link needs no "started" mark; nothing else is written, so no
   * "previous use had no receipt" mark either.
   */
  if (decision == OKEDGE_DECISION_APPROVE && pend.budget >= 0) {
    struct scope *sc;
    if (budget_for(op, pend.slot, pend.has_label ? pend.label : NULL, &sc) == pend.budget) { /* still started, live, with room */
      struct budget *b = &budgets[pend.budget];
      uint8_t reveal[32];
      b->used++;
      sc->used++;
      hash_times(reveal, b->seed, b->uses - b->used); /* v_i = H^(n-i)(seed) (lib grants.reveal) */
      if (pend.has_intent) next_intent = pend.intent; /* R13b: the reason, welded in with the use */
      append_scoped(op, DECISION_SELF_PRESS, pend.slot, FLAG_OWES_RECEIPT | FLAG_BUDGET_SPENT, pend.subject, b->id, b->used,
                    (uint8_t)(sc - b->scopes + 1), reveal); /* R3: byte 46, which scope paid */
      memset(reveal, 0, 32);
      return;
    }
  }
  /*
   * THE CHAIN HOLDS ONLY EDGE'S OWN RECORDS (spec session, 2026-10-06): an
   * ordinary ssh/gpg press - approved, denied or timed out - is not Edge and
   * writes no link (FIDO was never linked, R1). Brad: "my press is the
   * safeguard, as on any OnlyKey". Only the self-press above is linked.
   */
}

/*
 * Called first in okcore_run_pending_op (plugin.js hook), before the request
 * runs. Refuses (1) a request that did not match its TX start (R13a, EDGE:1C) and
 * (2) a request primed to be paid by a budget that can no longer pay - budget or
 * no go: it must never run without a press and without a link. -> 1 = refused.
 */
int okplugin_edge_refused(void) {
  if (!pend.active) return 0;
  if (pend.refuse) {
    uint8_t code = pend.refuse;
    pend.active = 0;
    pend.refuse = 0;
    status(code);
    return 1;
  }
  if (pend.budget >= 0 && !pend.press) {
    struct scope *sc;
    uint8_t op = pend.opcode == OKSIGN ? OP_SIGN : OP_DECRYPT;
    if (budget_for(op, pend.slot, pend.has_label ? pend.label : NULL, &sc) != pend.budget) {
      pend.active = 0;
      status(EDGE_NOTHING_TO_PAY);
      return 1;
    }
  }
  return 0;
}

/*
 * The Edge region erased: all four sectors - both state copies and the two spare ones (only the Edge
 * region - no key, slot or setting outside it). The clean start (v1, state_load)
 * and every wipe end here.
 */
static void fresh_start(void) {
  uint8_t blank[4] = {0xff, 0xff, 0xff, 0xff};
  okcore_flashsector(blank, (unsigned long *)EDGE_STATE_A, 4);
  okcore_flashsector(blank, (unsigned long *)EDGE_STATE_B, 4);
  okcore_flashsector(blank, (unsigned long *)EDGE_SPARE_A, 4);
  okcore_flashsector(blank, (unsigned long *)EDGE_SPARE_B, 4);
}

/* wipeflashdata(): the record goes and live budgets end; a new K132 makes the key a new device */
void okplugin_edge_wipe(void) {
  fresh_start();
  memset(budgets, 0, sizeof(budgets));
  memset(held, 0, sizeof(held));
  memset(&ident, 0, sizeof(ident));
  memset(&st, 0, sizeof(st));
  st.seq = SEQ_NONE;
  loaded = 1;
  started = 0;
  pend.active = 0;
  press_drop();
}

/* ------------------------------------------------------------ backup (DESIGN.md 6) */

/*
 * The plugin backup section (node-onlykey-lib/cli/firmware-plugins.js), version 1
 * since the clean start (it was 3; Brad, 2026-10-07: every schema v1):
 *   1 . seq u32 . head 32 . owed_n . overflow . owed_n x (seq u32, head 32) . device id 16
 * The debts travel with the backup, because R16 lets only a receipt or a waive
 * pay them - a restore must not be a way to forgive them. The device id names
 * the chain the restored key continues (its continue link). Budgets end at a restore anyway (their
 * seeds were never stored); the links themselves are the hosts'. The SALT IS
 * NEVER HERE: a restored key must never become the device that made the backup. A
 * section from before the clean start is not restored (that chain is gone).
 */
int okplugin_edge_backup(uint8_t *out, int max) {
  state_load();
  if (!ensure_identity()) return 0;
  int len = 39 + 36 * st.owed_n + ID_BYTES;
  if (max < len || st.seq == SEQ_NONE) return 0; /* no chain yet: nothing to keep */
  out[0] = 1;
  put32(out + 1, st.seq);
  memcpy(out + 5, st.head, 32);
  out[37] = st.owed_n;
  out[38] = st.overflow;
  for (int i = 0; i < st.owed_n; i++) {
    put32(out + 39 + 36 * i, st.owed[i].seq);
    memcpy(out + 39 + 36 * i + 4, st.owed[i].head, 32);
  }
  memcpy(out + 39 + 36 * st.owed_n, ident.device_id, ID_BYTES);
  return len;
}

void okplugin_edge_restore(const uint8_t *in, int len) {
  if (len < 39 || in[0] != 1) return; /* a version this build does not know (or one from before the clean start): keep what it has */
  uint8_t n = in[37] > OWED_MAX ? OWED_MAX : in[37];
  if (len < 39 + 36 * n + ID_BYTES) return;
  /*
   * Keep the record generation counting UP: the newer of the two sectors wins at
   * boot, so a restore that started again at 1 lost to the older record left in
   * the other sector (found by the kit test: the key came back at the right seq
   * but without the LOSS link).
   */
  state_load();
  uint32_t gen = st.gen;
  /*
   * EVERY RESTORE DRAWS A NEW SALT (Brad, 2026-10-08: "you cant reset bitcoin, so i
   * cant reset our log"; restore-then-replay went as overkill). So a restored key is
   * always a device of its own - even on the phone that made the backup it can never
   * write a second history under the old device id - and its first link (continue,
   * R28) names the backup's chain, its seq and head, and carries the debts. The log
   * goes on from there, never from zero; a copy of the links after the backup, found
   * later, still welds onto that head in the lib.
   */
  memset(&st, 0, sizeof(st));
  memset(&ident, 0, sizeof(ident));
  st.gen = gen;
  st.seq = get32(in + 1);
  memcpy(st.head, in + 5, 32);
  st.owed_n = n;
  st.overflow = in[38] ? 1 : 0;
  for (int i = 0; i < n; i++) {
    st.owed[i].seq = get32(in + 39 + 36 * i);
    memcpy(st.owed[i].head, in + 39 + 36 * i + 4, 32);
  }
  /* the continue link is written on the first Edge request, once the new salt is drawn */
  st.cont = CONT_FROM_ID;
  memcpy(st.cont_id, in + 39 + 36 * n, ID_BYTES);
  memset(held, 0, sizeof(held));
  memset(budgets, 0, sizeof(budgets));
  started = 0;
  loaded = 1;
  state_save();
}

/* ------------------------------------------------------------ OKEDGE */

void okplugin_edge_recv(uint8_t *buffer) {
  if (!(initialized == true && unlocked == true && configmode == false)) return;
  if (!ensure_identity()) { status(EDGE_NEED_PIN); return; }
  if (press.what && millis() - press.since > PRESS_MS) press_drop(); /* never pressed */
  uint8_t r[64];
  memset(r, 0, sizeof(r));
  switch (buffer[5]) {
    case OKEDGE_HEAD: {
      /*
       * seq (SEQ_NONE = empty) . head (the genesis while empty) . oldest pickable
       * seq . live budget ids x4 . held mask (bit i = budget i on hold, R15a) .
       * owed count . overflow (R16) . restoring (R26; CHOSEN - the tab opens its
       * Restore card on it)
       */
      uint32_t oldest = SEQ_NONE;
      uint8_t mask = 0;
      for (int i = 0; i < HELD; i++) if (held[i].used && held[i].seq < oldest) oldest = held[i].seq;
      put32(r, st.seq);
      memcpy(r + 4, st.head, 32);
      put32(r + 36, oldest);
      for (int i = 0; i < MAX_LIVE; i++) {
        int up = alive(&budgets[i]);
        put32(r + 40 + 4 * i, up ? budgets[i].id : 0);
        if (up && budgets[i].on_hold) mask |= 1 << i;
      }
      r[56] = mask;
      r[57] = st.owed_n;
      r[58] = st.overflow;
      r[60] = refused_tx; /* B7: refused TX starts since power-up (RAM only) */
      reply(r, 62);
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
    case OKEDGE_STATEMENT:
      statement(buffer + 6);
      return;
    case OKEDGE_GRANT_LABEL:
      grant_label(buffer);
      break;
    case OKEDGE_GRANT_CREATE:
      grant_create(buffer);
      return;
    case OKEDGE_GRANT_REVOKE: {
      /* ends a live budget, held or not; the debts it made stay owed (R16) */
      uint32_t id = get32(buffer + 6);
      struct budget *b = live_budget(id);
      if (!b) { status(EDGE_NO_SUCH_BUDGET); return; }
      uint8_t zero[32] = {0};
      memset(b, 0, sizeof(*b));
      append(OP_GRANT_END, OKEDGE_DECISION_APPROVE, 0, 0, zero, id, 0, NULL);
      status(EDGE_OK);
      return;
    }
#ifdef DEBUG
    /*
     * DEBUG BUILDS ONLY (R31, the clean start's rehearsals): the Edge region erased -
     * state, salt - so the next Edge request starts a new chain with a new
     * device id. Every private key stays (only the Edge region is written). A
     * production build has no such case: it falls to "unknown sub-op".
     */
    case OKEDGE_WIPE_DEBUG:
      okplugin_edge_wipe();
      status(EDGE_OK);
      return;
#endif
    case OKEDGE_GRANT_HOLD: {
      /* R15a: no press - it only makes the key stricter. Holding a held budget links nothing. */
      uint32_t id = get32(buffer + 6);
      struct budget *b = live_budget(id);
      if (!b) { status(EDGE_NO_SUCH_BUDGET); return; }
      if (!b->on_hold) {
        uint8_t zero[32] = {0};
        b->on_hold = 1;
        append(OP_GRANT_HOLD, OKEDGE_DECISION_APPROVE, 0, 0, zero, id, 0, NULL);
      }
      status(EDGE_OK);
      return;
    }
    case OKEDGE_GRANT_RESUME: {
      /*
       * id u32 . the head the host verified (32, R27). A physical press;
       * refused while a receipt is owed or a restore is unfinished (R18, R26).
       */
      uint32_t id = get32(buffer + 6);
      uint8_t what[32];
      press_drop();
      if (!live_budget(id)) { status(EDGE_NO_SUCH_BUDGET); return; }
      if (automatic_blocked()) { status(blocked_status()); return; }
      if (!head_is(buffer + 10, 32)) { status(EDGE_STALE_HEAD); return; }
      memcpy(press.verified, buffer + 10, 32);
      press.verified_len = 32;
      press.id = id;
      H(what, "OKEDGE-RESUME", buffer + 6, 4, NULL, 0, NULL, 0);
      press_wait(PRESS_RESUME, what);
      return;
    }
    case OKEDGE_RECEIPT: {
      /*
       * ref_seq u32 . code u8 . msg_hash 32, for ANY owed use (R16):
       *   SHA256("OKEDGE-RECEIPT-v1" || ref_seq || head[ref_seq] || code || msg_hash)
       * (lib receipts.receiptSubject), head[ref_seq] from the owed list. The message
       * itself never reaches the key. reply: seq . head after the receipt link.
       */
      uint32_t ref = get32(buffer + 6);
      uint8_t code = buffer[10];
      int k = -1;
      for (int i = 0; i < st.owed_n; i++) if (st.owed[i].seq == ref) { k = i; break; }
      if (k < 0) { status(EDGE_NO_RECEIPT_WAITING); return; }
      uint8_t ref4[4], subject[32];
      put32(ref4, ref);
      SHA256_CTX ctx;
      sha256_init(&ctx);
      sha256_update(&ctx, (const unsigned char *)"OKEDGE-RECEIPT-v1", sizeof("OKEDGE-RECEIPT-v1") - 1); /* counted by the compiler: the rename from TICKET (16) to RECEIPT (17) broke a hand count */
      sha256_update(&ctx, ref4, 4);
      sha256_update(&ctx, st.owed[k].head, 32);
      sha256_update(&ctx, &code, 1);
      sha256_update(&ctx, buffer + 11, 32);
      sha256_final(&ctx, subject);
      append(OP_RECEIPT, code, 0, 0, subject, ref, 0, NULL); /* the weld pays ref */
      reply_seq_head();
      return;
    }
    case OKEDGE_WAIVE: {
      /* R18: a physical press clears every debt (the person's Yes in ok-rn comes first) */
      uint8_t what[32];
      press_drop();
      if (!owes()) { status(EDGE_NO_RECEIPT_WAITING); return; }
      H(what, "OKEDGE-WAIVE", st.head, 32, NULL, 0, NULL, 0);
      press_wait(PRESS_WAIVE, what);
      return;
    }
    case OKEDGE_TX_START: {
      /*
       * R13a, like ssh-agent: the agent's wire asks, the key decides. TX start {token}
       * starts ONE self-press when nothing is owed, no restore is unfinished and
       * some budget (alive, off hold, uses left) could pay. Whether the token
       * fits - this head, this request - is decided when the request is primed
       * (okplugin_edge_primed); a stale head shows there, as a press.
       */
      /*
       * R13b, budget or no go (Brad, 2026-10-06): a TX start, with or without an
       * intent, is refused unless a budget can pay - there is no pressed-intent
       * path. A press is the ordinary ssh/gpg agent, which sends no TX start.
       */
      uint8_t has_intent = 0;
      for (int k = 0; k < 16; k++) has_intent |= buffer[38 + k];
      if (owes()) { refuse_tx(EDGE_RECEIPT_OWED); return; }
      if (!any_budget_payable()) { refuse_tx(EDGE_NOTHING_TO_PAY); return; }
      memcpy(tx_token, buffer + 6, 32);
      memcpy(tx_intent, buffer + 38, 16); /* R13b: zeros = no intent (still in the token) */
      tx_has_intent = has_intent;
      started = 1;
      status(EDGE_OK);
      return;
    }
    case OKEDGE_LOSS: {
      /*
       * from u32 . to u32, a press. Only a past range (to at or before the head)
       * can be lost.
       */
      uint32_t from = get32(buffer + 6), to = get32(buffer + 10);
      uint8_t what[32];
      press_drop();
      if (st.seq == SEQ_NONE || from > to || to > st.seq) { status(EDGE_BAD_RANGE); return; }
      press.from = from;
      press.id = to;
      H(what, "OKEDGE-LOSS", buffer + 6, 8, st.head, 32, NULL, 0);
      press_wait(PRESS_LOSS, what);
      return;
    }
    default:
      status(EDGE_UNKNOWN_REQUEST);
      return;
  }
}
