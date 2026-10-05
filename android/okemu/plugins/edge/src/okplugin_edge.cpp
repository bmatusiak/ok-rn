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
 *   2 the budget decision (self-press, only when ARMed) and its reveal;
 *   3 ONE signature, with a key no generic sign request reaches: a checkpoint
 *     over (seq, head). Opening a budget at a physical press answers with a
 *     checkpoint over its grant-create link, whose subject commits to G - so
 *     the budget's genesis is signed through the chain.
 *   4 the debts: every approved use owes a ticket (R16), and nothing automatic
 *     happens while one is owed (R18) until a ticket or a pressed WAIVE pays it.
 *
 * Every byte is node-onlykey-lib/edge's format (codes.js, chain.js, grants.js,
 * tickets.js); the comments name the lib function each must match. The rules
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
#define OP_TICKET 8
#define OP_PEER_ADD 9     /* R20 */
#define OP_PEER_REMOVE 10 /* R20 */
#define OP_LOSS 11
#define OP_GRANT_HOLD 13
#define OP_GRANT_RESUME 14
#define OP_AGENT_ADD 15
#define OP_SIBLING_ADD 17    /* R29 */
#define OP_SIBLING_REMOVE 18 /* R29 */
#define OP_SYNC 20     /* sync phase 2: every approved sync writes one (Brad, 2026-10-05) */
#define OP_CONTINUE 16 /* R28: the first link of a device's own chain, carrying another chain's debts */
#define DECISION_SELF_PRESS 4
#define CODE_NEEDS_REVIEW 0x8F /* a WAIVE is linked as this ticket code, with the press flag (R18) */
#define FLAG_PRESS_OBSERVED 0x01
#define FLAG_BUDGET_SPENT 0x02
#define FLAG_PREV_NO_TICKET 0x04
#define FLAG_OWES_TICKET 0x10 /* R16: this use owes a ticket (decided at the sign) */
#define FLAG_ARMED 0x20       /* R16: an arm was waiting when it was primed */

#define SEQ_NONE 0xFFFFFFFFUL
#define LINK_BYTES 64
#define ID_BYTES 16

#define MAX_LIVE 4      /* R15 */
#define MAX_SCOPES 4    /* R11 */
#define MAX_USES 1024   /* R11 (Brad, 2026-10-02: back from 255 - too few once the VM and the Pi are in the loop); up to 1,024 SHA-256 at the press and per reveal */
#define OWED_MAX 4      /* R16: owed uses kept in flash (lib tickets.OWED_MAX) */
#define HELD 8          /* links held in RAM for pickup */
#define PRESS_MS 25000UL

/* ------------------------------------------------------------ flash: one small record */

/* base + 0x1000, from the firmware's own constant so it follows OKEMU_FLASH_BASE */
#define EDGE_REGION ((uintptr_t)factorysectoradr - 0x4800)
#define EDGE_STATE_A (EDGE_REGION + 0x0000)
#define EDGE_STATE_B (EDGE_REGION + 0x0800)

/*
 * magic . gen . seq . head . owed_n . overflow . restoring . replay_closed .
 * owed x4 (seq, head) . last_link . replayed_to . check.
 * "06": the owed list replaced 05's one-use flag (the spec change, onlykey-edge
 * c7c30dd). "07" adds R26's replay state (replay_closed, replayed_to); a 06
 * record is still read (its replay state is "nothing replayed past seq"), so a
 * soft key keeps its chain across this change. A 05 record is not read: Edge
 * never shipped.
 * "08" adds R28: salted . cont . salt 32 . cont_id 16 (see ensure_identity). A
 * 07 record reads as unsalted, which is exactly what makes the device move to
 * its own chain with a continue link on the first Edge request.
 */
#define STATE_BYTES 320 /* a multiple of 4: flash takes words (318 lost the check bytes) */
#define STATE_CHECKED 316 /* 314..315 zero padding */
#define SALTED_AT 264
#define CONT_AT 265
#define SALT_AT 266
#define CONT_ID_AT 298
#define STATE07_CHECKED 264
#define STATE06_BYTES 264
#define STATE06_CHECKED 260
#define OWED_AT 52
#define LAST_AT (OWED_AT + OWED_MAX * 36)
#define REPLAYED_AT (LAST_AT + LINK_BYTES)
static const uint8_t MAGIC[8] = {'O', 'K', 'E', 'D', 'G', 'E', '0', '8'};
static const uint8_t MAGIC07[8] = {'O', 'K', 'E', 'D', 'G', 'E', '0', '7'};
static const uint8_t MAGIC06[8] = {'O', 'K', 'E', 'D', 'G', 'E', '0', '6'};

struct owed_use { uint32_t seq; uint8_t head[32]; }; /* head[seq]: what its ticket subject names */

/* everything that survives a restart */
struct edge_state {
  uint32_t gen;
  uint32_t seq;               /* SEQ_NONE = no link yet */
  uint8_t head[32];           /* head[seq]; the genesis while seq == SEQ_NONE */
  uint8_t owed_n;             /* R16: uses owing a ticket, oldest first in owed[] */
  uint8_t overflow;           /* R16: an older owed use fell off the list - only a WAIVE clears it */
  uint8_t restored;           /* R26 "restoring": restored from a backup, REPLAY_DONE not pressed yet */
  uint8_t replay_closed;      /* R26: the key wrote a link of its own while restoring - no more REPLAY */
  uint32_t replayed_to;       /* R26: the newest seq replayed (or restored); a LOSS starts after it */
  struct owed_use owed[OWED_MAX];
  uint8_t last_link[LINK_BYTES]; /* the latest link, so a crash never loses it */
  /*
   * R28 (onlykey-edge firmware.md, decided 2026-10-04): ONE CHAIN PER PHYSICAL
   * DEVICE. The salt is made here on first use and lives only in this record -
   * never in the plugin backup section, and the app keeps the whole flash file
   * out of Android backup and device transfer (data_extraction_rules.xml). A key
   * restored onto another phone therefore has another salt, another Edge key,
   * another device id: its own chain from the first link, never a second writer.
   */
  uint8_t salted;
  uint8_t cont;                  /* a continue link is owed: CONT_FROM_ID (cont_id) or CONT_FROM_UNSALTED */
  uint8_t salt[32];
  uint8_t cont_id[ID_BYTES];     /* CONT_FROM_ID: the chain the debts come from */
};
#define CONT_FROM_ID 1
#define CONT_FROM_UNSALTED 2 /* a pre-R28 chain: its id is the unsalted one, from K132 */
static struct edge_state st;
static uint8_t loaded;

/*
 * R26 (Brad, 2026-10-02: fix the hole "without making another hole"): while
 * restoring, REPLAY welds into this RAM copy, never into st. Only REPLAY_DONE
 * with a vouch tag the key itself issued for exactly this (seq, head) commits
 * it; a power cut, a human press or a bad tag throws it away. Any 64 bytes
 * weld onto a head, so welding alone would let a host replay INVENTED links -
 * tickets that pay its debts, a "pressed" waive nobody pressed.
 */
static struct edge_state tent;
static uint8_t tent_active;

/* R18: is anything owed? Then nothing automatic happens. */
static int owes(void) { return st.owed_n || st.overflow; }

/*
 * R26: restored from a backup, the key lost its newest head - every link after
 * the backup, and the debts they made. Until a person finishes the restore
 * (REPLAY_DONE, with a press) nothing automatic happens, as if overflow were
 * set: a restore must never be a way to forgive debts. Human presses still work.
 */
static int automatic_blocked(void) { return owes() || st.restored; }

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
  uint8_t nscopes, on_hold;   /* on_hold: R15a - pays for nothing, nothing arms under it */
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
 * R13a: ONE self-press, armed by ARM {head}. RAM only, and any link clears it
 * (append) - so it is spent by the very next sign/decrypt, whatever it decides,
 * and a lock or reboot drops it.
 */
static uint8_t armed;
/*
 * R13a (2026-10-02): the arm is bound to ONE request, not just the head:
 *   token = SHA256("OKEDGE-ARM-v1" || head || subject)
 * subject = pend.subject, SHA-256 of exactly the bytes handed to
 * okcore_prime_user_confirmation. The key recomputes it from ITS head when the
 * next sign/decrypt is primed; a program that slips in between the agent's ARM
 * and its sign gets a press, never a free signature - and uses the arm up.
 */
static uint8_t arm_token[32];

/*
 * B7 stage 2 (spec, 2026-10-04): ARMs this key refused since power-up, in HEAD
 * byte 60. RAM only - a refused ARM writes no link (any host could flood the
 * chain and wear the flash), so this count is the key's own evidence; the
 * phone's watcher alarms when it rises. Stops at 255.
 */
static uint8_t refused_arms;
static void status(uint8_t code);
static void refuse_arm(uint8_t code) {
  if (refused_arms < 255) refused_arms++;
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
  uint8_t armed; /* R16: an arm was waiting when this was primed (matched or not) */
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
enum { PRESS_GRANT = 1, PRESS_RESUME, PRESS_WAIVE, PRESS_REPLAY_DONE, PRESS_LOSS, PRESS_AGENT_ADD,
  PRESS_PEER_ADD, PRESS_PEER_REMOVE, PRESS_SYNC, PRESS_SIBLING_ADD, PRESS_SIBLING_REMOVE };
static struct {
  uint8_t what;
  unsigned long since;
  uint32_t id;                /* PRESS_RESUME: the budget; PRESS_REPLAY_DONE: the newest seq the copies hold */
  uint32_t vouch_seq;         /* PRESS_REPLAY_DONE: the seq the vouch tag (in verified[0..16]) is for; PRESS_LOSS: from */
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
  uint8_t peer[64];           /* PRESS_PEER_ADD / PRESS_SIBLING_ADD: the key, X || Y (the REMOVEs: the index is in id) */
  uint8_t sib_id[ID_BYTES];   /* PRESS_SIBLING_ADD: the sibling's device id */
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

static int vouch_tag(uint32_t seq, const uint8_t head[32], uint8_t tag[16]);

/*
 * seq . head . vouch tag (R26): TICKET's, WAIVE's and VOUCH's answer - the head
 * the agent passes to the next ARM (R13a), and the tag a host keeps with its
 * copy so a later restore can prove this head was the key's.
 */
static void reply_seq_head(void) {
  uint8_t r[52];
  memset(r, 0, sizeof(r));
  put32(r, st.seq);
  memcpy(r + 4, st.head, 32);
  vouch_tag(st.seq, st.head, r + 36);
  reply(r, 52);
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
  rec[50] = st.restored;
  rec[51] = st.replay_closed;
  for (int i = 0; i < OWED_MAX; i++) {
    put32(rec + OWED_AT + 36 * i, st.owed[i].seq);
    memcpy(rec + OWED_AT + 36 * i + 4, st.owed[i].head, 32);
  }
  memcpy(rec + LAST_AT, st.last_link, LINK_BYTES);
  put32(rec + REPLAYED_AT, st.replayed_to);
  rec[SALTED_AT] = st.salted;
  rec[CONT_AT] = st.cont;
  memcpy(rec + SALT_AT, st.salt, 32);
  memcpy(rec + CONT_ID_AT, st.cont_id, ID_BYTES);
  H(check, NULL, rec, STATE_CHECKED, NULL, 0, NULL, 0);
  memcpy(rec + STATE_CHECKED, check, 4);
}

static int state_decode(const uint8_t rec[STATE_BYTES], struct edge_state *s) {
  uint8_t check[32];
  int v06 = memcmp(rec, MAGIC06, 8) == 0;
  int v07 = memcmp(rec, MAGIC07, 8) == 0;
  if (!v06 && !v07 && memcmp(rec, MAGIC, 8) != 0) return 0;
  int checked = v06 ? STATE06_CHECKED : v07 ? STATE07_CHECKED : STATE_CHECKED;
  H(check, NULL, rec, checked, NULL, 0, NULL, 0);
  if (memcmp(rec + checked, check, 4) != 0) return 0; /* torn write: the other copy wins */
  s->gen = get32(rec + 8);
  s->seq = get32(rec + 12);
  memcpy(s->head, rec + 16, 32);
  s->owed_n = rec[48] > OWED_MAX ? OWED_MAX : rec[48];
  s->overflow = rec[49];
  s->restored = rec[50];
  s->replay_closed = v06 ? 0 : rec[51];
  for (int i = 0; i < OWED_MAX; i++) {
    s->owed[i].seq = get32(rec + OWED_AT + 36 * i);
    memcpy(s->owed[i].head, rec + OWED_AT + 36 * i + 4, 32);
  }
  memcpy(s->last_link, rec + LAST_AT, LINK_BYTES);
  s->replayed_to = v06 ? s->seq : get32(rec + REPLAYED_AT);
  /* 06 / 07: no salt yet (R28) - ensure_identity moves the device to its own chain */
  int v08 = !v06 && !v07;
  s->salted = v08 ? (rec[SALTED_AT] == 1) : 0;
  s->cont = v08 ? rec[CONT_AT] : 0;
  if (v08) {
    memcpy(s->salt, rec + SALT_AT, 32);
    memcpy(s->cont_id, rec + CONT_ID_AT, ID_BYTES);
  } else {
    memset(s->salt, 0, 32);
    memset(s->cont_id, 0, ID_BYTES);
  }
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
  if (st.seq != SEQ_NONE && !st.restored) hold(st.seq, st.last_link, st.head, NULL);
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

/* the vouch key and anything else from K132 alone (R26 vouch tags must check on the device a backup is restored to) */
static int edge_secret(const char *info, uint8_t out[32]) { return edge_secret_salted(info, NULL, out); }

/*
 * R28: the Edge checkpoint key - and so the device id and the genesis - is
 * HKDF(salt = 0x28 . this device's salt, K132, "onlykey/edge/v1"). ONLY this
 * key takes the salt: every derived identity (SSH, PGP, the agents' keys) is
 * K132's alone and stays the same across R28 (tested before == after). Without
 * a salt (a pre-R28 record) it is the old unsalted key, which is how the
 * continue link names the chain it came from.
 */
static int edge_key_with(const struct edge_state *s, uint8_t priv[32]) {
  if (!s->salted) return edge_secret("onlykey/edge/v1", priv);
  uint8_t salt33[33];
  salt33[0] = 0x28;
  memcpy(salt33 + 1, s->salt, 32);
  int ok = edge_secret_salted("onlykey/edge/v1", salt33, priv);
  memset(salt33, 0, sizeof(salt33));
  return ok;
}
static int edge_private_key(uint8_t priv[32]) { return edge_key_with(&st, priv); }

/*
 * R26 vouch: the key MACs a head it wrote itself,
 *   tag = HMAC-SHA256(K_vouch, "OKEDGE-VOUCH-v1" || seq (u32 LE) || head)[0..16]
 *   K_vouch = HKDF(K132, info "onlykey/edge/vouch/v1")
 * A MAC, not the checkpoint signature: checking its own ECDSA signature needs
 * uECC's verify, which a hard-key build may not carry; HMAC needs only the
 * SHA-256 the firmware has (and is quantum-safe, unlike P-256). Its own HMAC
 * over SHA256_CTX: the FIDO2 helpers share FIDO2's global hash state.
 */
#define VOUCH_BYTES 16
static int vouch_tag(uint32_t seq, const uint8_t head[32], uint8_t tag[VOUCH_BYTES]) {
  uint8_t k[32], pad[64], inner[32], seq4[4];
  if (!edge_secret("onlykey/edge/vouch/v1", k)) return 0;
  SHA256_CTX ctx;
  put32(seq4, seq);
  for (int i = 0; i < 64; i++) pad[i] = (i < 32 ? k[i] : 0) ^ 0x36;
  sha256_init(&ctx);
  sha256_update(&ctx, pad, 64);
  sha256_update(&ctx, (const unsigned char *)"OKEDGE-VOUCH-v1", 15);
  sha256_update(&ctx, seq4, 4);
  sha256_update(&ctx, head, 32);
  sha256_final(&ctx, inner);
  for (int i = 0; i < 64; i++) pad[i] = (i < 32 ? k[i] : 0) ^ 0x5c;
  sha256_init(&ctx);
  sha256_update(&ctx, pad, 64);
  sha256_update(&ctx, inner, 32);
  sha256_final(&ctx, inner);
  memcpy(tag, inner, VOUCH_BYTES);
  memset(k, 0, 32);
  memset(pad, 0, 64);
  memset(inner, 0, 32);
  return 1;
}

/* constant time: a tag check that leaks how many bytes matched helps a forger */
static int same_ct(const uint8_t *a, const uint8_t *b, int n) {
  uint8_t d = 0;
  for (int i = 0; i < n; i++) d |= a[i] ^ b[i];
  return d == 0;
}

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
 * The debts (seq + head) stay owed here and are paid by ticket or waive on this
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
  armed = 0;
  st.restored = 0;
  st.replay_closed = 0;
  st.cont = 0;
  memset(st.cont_id, 0, ID_BYTES);
  /* head[-1] of the new chain = SHA256("OKEDGE-GENESIS-v1" || new device_id) */
  H(st.head, "OKEDGE-GENESIS-v1", ident.device_id, ID_BYTES, NULL, 0, NULL, 0);
  append(OP_CONTINUE, OKEDGE_DECISION_APPROVE, 0, 0, subject, st.owed_n, 0, NULL);
  st.replayed_to = st.seq;
  state_save();
}

/* the public key and device id (RAM), and the genesis on a new chain; 0 without K132 */
static int ensure_identity(void) {
  state_load();
  if (ident.ok) return 1;
  /*
   * R28: no salt yet - a new key, a key wiped and restored, or a pre-R28 record.
   * The salt is made now. A chain that already has links (pre-R28, or restored
   * from a backup made before R28) is continued from its unsalted id.
   */
  if (!st.salted) {
    uint8_t t = 0;
    okeeprom_eeget_ecckey(&t, 132);
    if (profilemode == NONENCRYPTEDPROFILE || t == 0) return 0; /* no K132 yet: nothing to salt for */
    if (st.seq != SEQ_NONE && !st.cont) st.cont = CONT_FROM_UNSALTED;
    RNG2(st.salt, 32);
    st.salted = 1;
    state_save();
  }
  if (!identity_of(&st, ident.pub, ident.device_id)) return 0;
  ident.ok = 1;
  if (st.cont) {
    uint8_t old_pub[64], old_id[ID_BYTES];
    if (st.cont == CONT_FROM_ID) memcpy(old_id, st.cont_id, ID_BYTES);
    else {
      struct edge_state unsalted = st;
      unsalted.salted = 0;
      if (!identity_of(&unsalted, old_pub, old_id)) { ident.ok = 0; return 0; }
      memset(&unsalted, 0, sizeof(unsalted));
    }
    write_continue(old_id);
    return 1;
  }
  /*
   * Restored from a backup (st.restored): the LOSS link is NOT written here any
   * more (R26). The host first replays the newest copy it has, and the person
   * then accepts where it ended with a press (REPLAY_DONE), which writes the
   * LOSS over only what could not be replayed.
   */
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

/* SHA256("OKEDGE-WAIVE-v1" || each owed seq (u32 LE, oldest first) || overflow) (lib tickets.waiveSubject) */
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
 * THE weld - the one function every link goes through, whether the key writes
 * it or REPLAY hands it back (firmware.md §3.1: "replay is a loop over the
 * same rule, not a second copy of it"):
 *   head[n] = SHA256("OKEDGE-LINK-v1" || head[n-1] || link[n])   (lib chain.weld)
 * then the debt rule (R16-R18; lib tickets.keyDebts replays the same rule):
 *   - an approved sign/decrypt whose link carries owes_ticket (bit 4, set at the
 *     sign by the R16 rule - see okplugin_edge_decision) owes a ticket. The key
 *     keeps the latest 4; a 5th pushes the oldest off for good (overflow: only
 *     a WAIVE clears it). Only a human press can make a 5th (R18);
 *   - a WAIVE - a ticket with code 0x8F, the press flag and the subject over
 *     exactly this list and overflow - clears the list and the overflow;
 *   - any other ticket pays its ref_seq, if that use is still on the list;
 * and persists it before the operation's result is released (R4).
 * `expect`: REPLAY's check - the first 8 bytes of the head the copy stored
 * after this link; a weld that gives another head changes nothing (returns 0).
 * `s`: the state it welds into - the record (st: saved, held for pickup), or
 * the tentative replay (tent: RAM only, R26).
 */
static int weld_in(struct edge_state *s, const uint8_t link[LINK_BYTES], const uint8_t *reveal, const uint8_t *expect) {
  uint8_t head[32], w[32];
  uint32_t seq = get32(link);
  H(head, "OKEDGE-LINK-v1", s->head, 32, link, LINK_BYTES, NULL, 0);
  if (expect && memcmp(head, expect, 8) != 0) return 0;

  uint8_t op = link[4], decision = link[5];
  if (op == OP_SIGN || op == OP_DECRYPT) {
    if ((decision == OKEDGE_DECISION_APPROVE || decision == DECISION_SELF_PRESS) && (link[7] & FLAG_OWES_TICKET)) {
      if (s->owed_n == OWED_MAX) {
        memmove(&s->owed[0], &s->owed[1], sizeof(s->owed[0]) * (OWED_MAX - 1));
        s->owed_n--;
        s->overflow = 1;
      }
      s->owed[s->owed_n].seq = seq;
      memcpy(s->owed[s->owed_n].head, head, 32);
      s->owed_n++;
    }
  } else if (op == OP_TICKET) {
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
  armed = 0; /* R13a: any link spends or clears the arm */
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
  put32(link, st.seq == SEQ_NONE ? 0 : st.seq + 1);
  link[4] = op;
  link[5] = decision;
  link[6] = slot;
  link[7] = flags;
  memcpy(link + 8, subject, 32);
  put32(link + 40, grant_id);
  put16(link + 44, grant_step);
  /*
   * R26: a link of the key's own while restoring forks from any copy holding
   * the newer links - from here a replayed link could only be spliced onto a
   * history it never followed. Replay is closed for good.
   */
  if (st.restored) {
    st.replay_closed = 1;
    tent_active = 0; /* R26: a link of its own discards the tentative replay - it writes onto the backup's head */
  }
  weld_in(&st, link, reveal, NULL);
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
static uint8_t blocked_status(void) { return st.restored ? EDGE_RESTORING : EDGE_TICKET_OWED; }

/* R27: does the head the host verified (its first n bytes) still match the key's? */
static int head_is(const uint8_t *verified, uint8_t n) { return memcmp(verified, st.head, n) == 0; }

/*
 * The live budget that pays for this use: armed (R13a), not on hold (R15a), a
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
  if (!armed || !budgets_may_pay()) return -1;
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

/*
 * R16: is this op and slot the agent's - covered by a budget from its opening
 * until it ends (revoke, expiry, lock/reboot), ON HOLD OR NOT, USED UP OR NOT
 * (Brad, 2026-10-02: hold stops paying, not owing - otherwise the agent could
 * use its key outside Edge while Brad is checking it). The same scope match as
 * budget_for, without its "could pay now" conditions.
 */
static int covered(uint8_t op, uint8_t slot, const uint8_t *label) {
  for (int i = 0; i < MAX_LIVE; i++) {
    struct budget *b = &budgets[i];
    if (!alive(b)) continue;
    for (int j = 0; j < b->nscopes; j++)
      if (scope_matches(&b->scopes[j], op, slot, label)) return 1;
  }
  return 0;
}

/* R13a: ARM needs a budget that could pay for something - live, not on hold, uses left */
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
 * PHYSICAL press, never while a ticket is owed or a restore is unfinished
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

/* R15a: the press that lets a held budget pay again (refused while a ticket is owed, R18) */
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
 * R18: the way out for debts nobody will ticket - one press clears them all.
 * Linked as a ticket, code 0x8F (needs review), the press flag, grant_id = the
 * oldest seq it waives, and
 *   subject = SHA256("OKEDGE-WAIVE-v1" || each waived seq (u32 LE, oldest first) || overflow)
 * (lib tickets.waiveSubject). With overflow and an empty list (every listed
 * debt was ticketed, older ones fell off), grant_id is the waive's own seq:
 * the lib then reads every older unpaid use as "waived, not listed".
 */
static void waive_pressed(void) {
  if (!owes()) { status(EDGE_NO_TICKET_WAITING); return; } /* paid while it waited */
  uint8_t subject[32];
  uint32_t oldest = st.owed_n ? st.owed[0].seq : (st.seq == SEQ_NONE ? 0 : st.seq + 1);
  waive_subject(&st, subject);
  append(OP_TICKET, CODE_NEEDS_REVIEW, 0, FLAG_PRESS_OBSERVED, subject, oldest, 0, NULL); /* the weld clears the debts */
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
 * R26: the person accepts "restored to #N" with a press. The tentative replay
 * becomes the record ONLY if the host presents the key's own vouch tag for
 * exactly the tentative (seq, head); otherwise it is thrown away and the LOSS
 * covers everything since the backup's head (EDGE:11, not vouched). Then, if
 * the copies held more than what is committed, a pressed LOSS link over that
 * range - grant_id = the first seq lost, the subject's first 4 bytes = the
 * newest the copies hold (0xFFFFFFFF: not said) - and the key leaves restoring.
 * reply: seq . head . tag after it, or EDGE:11.
 */
static void replay_done_pressed(void) {
  if (!st.restored) { status(EDGE_REPLAY_CLOSED); return; }
  uint8_t want[VOUCH_BYTES];
  int ok = tent_active && tent.seq == press.vouch_seq && vouch_tag(tent.seq, tent.head, want) &&
           same_ct(want, press.verified, VOUCH_BYTES);
  /* the newest seq lost if this replay is not committed: what the host said, else how far its replay got */
  uint32_t replayed = tent_active ? tent.seq : SEQ_NONE;
  if (ok) {
    uint32_t gen = st.gen;
    tent.gen = gen;
    tent.restored = 0;
    tent.replay_closed = 0;
    st = tent;
    hold(st.seq, st.last_link, st.head, NULL);
  }
  memset(&tent, 0, sizeof(tent));
  tent_active = 0;
  st.restored = 0;
  st.replay_closed = 0;
  st.replayed_to = st.seq;
  uint32_t newest = press.id;
  if (!ok && newest == SEQ_NONE) newest = replayed;
  uint32_t from = st.seq == SEQ_NONE ? 0 : st.seq + 1;
  if (!ok || (newest != SEQ_NONE && newest >= from)) {
    uint8_t subject[32];
    loss_subject(newest, subject);
    append(OP_LOSS, OKEDGE_DECISION_APPROVE, 0, FLAG_PRESS_OBSERVED, subject, from, 0, NULL);
  } else {
    state_save();
  }
  if (ok) reply_seq_head(); else status(EDGE_NOT_VOUCHED);
}

/*
 * R24 LOSS {from, to}, a press (firmware.md R24; built ahead of the rest of E5
 * for the tab's red banner, Brad 2026-10-02): the person accepts #from..#to as
 * unrecoverable - no copy anywhere holds it. One link, op = loss, decision
 * approve, slot 0, the press flag, grant_id = from, subject = loss_subject(to)
 * (the same layout REPLAY_DONE writes). It records the acceptance; it
 * pays no debt (R16: only a ticket or a waive does). A host then accepts a gap
 * covered by it under R27. reply: seq . head . tag after it.
 */
static void loss_pressed(void) {
  uint8_t subject[32];
  loss_subject(press.id, subject);
  append(OP_LOSS, OKEDGE_DECISION_APPROVE, 0, FLAG_PRESS_OBSERVED, subject, press.vouch_seq, 0, NULL);
  reply_seq_head();
}

/*
 * AGENT_ADD (mcp-service.md 4.7a: "the agent's key is registered once, with
 * a press", like a known peer - R20): the person's Yes in ok-rn first, then
 * this press. One link, op = agent-add, decision approve, slot 0, the press
 * flag, subject = SHA256("OKEDGE-AGENT-v1" || the agent's Ed25519 key). The
 * key does not keep a list of agents - the APP does, and a copy that verifies
 * shows when each was added with a press. reply: seq . head . tag after it.
 */
static void agent_add_pressed(void) {
  append(OP_AGENT_ADD, OKEDGE_DECISION_APPROVE, 0, FLAG_PRESS_OBSERVED, press.verified, 0, 0, NULL);
  reply_seq_head();
}

/* ------------------------------------------------------------ peers (R20) */

/*
 * R20 KNOWN PEERS: the places that keep copies of the chain (this PC's copy
 * store now, the Worker at E5), each with its own P-256 key, added and removed
 * only with a press after the person's Yes in ok-rn. A sync goes only to places
 * added this way (mcp-service 4.2b), so the list is the key's, not the app's -
 * unlike agents, a host that could edit it could send copies anywhere.
 *
 * Their own record, beside the chain's, because (Brad, 2026-10-05) peers and
 * siblings are NOT in the backup: a restored key pairs again with a press. A
 * peer list carried by a backup would let a backup restored elsewhere keep
 * sending copies to the old places. Kept apart, the chain record's format (and
 * the backup section) never changes for it, and the wipe drops it with K132.
 *
 * Receipts, backed_through and k are E5 (R21, R22); until then PEER_LIST says
 * backed_through = none and k = 0. The PC's copy store never counts toward k
 * for that PC's own budgets (R20) - a rule for E5's watermark, not for this list.
 *
 * magic 8 . gen 4 . peer count 1 . sibling count 1 (P2b, R29) . pad 2 .
 * peers 4 x 64 (X || Y) . siblings 4 x 80 (key 64 . device id 16; reserved
 * until P2b, so siblings need no new format) . check 4.
 */
#define MAX_PEERS 4
#define MAX_SIBLINGS 4
#define PAIRS_A (EDGE_REGION + 0x1000)
#define PAIRS_B (EDGE_REGION + 0x1800)
#define PAIRS_BYTES 600 /* a multiple of 4: flash takes words */
#define PAIRS_CHECKED 596
#define PEERS_AT 16
#define SIBS_AT (PEERS_AT + MAX_PEERS * 64) /* 272: siblings, key 64 . device id 16 each */
static const uint8_t PAIRS_MAGIC[8] = {'O', 'K', 'E', 'P', 'A', 'I', 'R', '1'};
static struct {
  uint32_t gen;
  uint8_t peer_n;
  uint8_t peer[MAX_PEERS][64];
  uint8_t sib_n;
  uint8_t sib[MAX_SIBLINGS][64 + ID_BYTES]; /* R29: key X || Y . device id */
} pairs;
static uint8_t pairs_loaded;
static uint8_t peer_x[32];     /* PEER_ADD part 0: X, until part 1 brings Y (RAM only) */
static uint8_t peer_x_staged;
static uint8_t sib_x[32];      /* SIBLING_ADD part 0: X, until part 1 brings Y and the id (RAM only) */
static uint8_t sib_x_staged;
/* SYNC's parts, until the third brings the last (RAM only): peer hash 32 . first 4 . last 4 . head 32 . Key Chain hash 32 */
static uint8_t sync_fields[104];
static uint8_t sync_parts;

/* double-buffered like the chain record: the newer copy whose check holds */
static void pairs_load(void) {
  if (pairs_loaded) return;
  uint8_t rec[PAIRS_BYTES], check[32];
  const uintptr_t at[2] = {PAIRS_A, PAIRS_B};
  int found = 0;
  memset(&pairs, 0, sizeof(pairs));
  for (int c = 0; c < 2; c++) {
    okcore_flashget_common(rec, (unsigned long *)at[c], PAIRS_BYTES);
    if (memcmp(rec, PAIRS_MAGIC, 8) != 0) continue;
    H(check, NULL, rec, PAIRS_CHECKED, NULL, 0, NULL, 0);
    if (memcmp(rec + PAIRS_CHECKED, check, 4) != 0) continue; /* torn write: the other copy wins */
    uint32_t gen = get32(rec + 8);
    if (found && gen <= pairs.gen) continue;
    found = 1;
    pairs.gen = gen;
    pairs.peer_n = rec[12] > MAX_PEERS ? MAX_PEERS : rec[12];
    memcpy(pairs.peer, rec + PEERS_AT, sizeof(pairs.peer));
    pairs.sib_n = rec[13] > MAX_SIBLINGS ? MAX_SIBLINGS : rec[13];
    memcpy(pairs.sib, rec + SIBS_AT, sizeof(pairs.sib));
  }
  pairs_loaded = 1;
}

static void pairs_save(void) {
  uint8_t rec[PAIRS_BYTES], check[32];
  pairs.gen++;
  memset(rec, 0, PAIRS_BYTES);
  memcpy(rec, PAIRS_MAGIC, 8);
  put32(rec + 8, pairs.gen);
  rec[12] = pairs.peer_n;
  memcpy(rec + PEERS_AT, pairs.peer, sizeof(pairs.peer));
  rec[13] = pairs.sib_n;
  memcpy(rec + SIBS_AT, pairs.sib, sizeof(pairs.sib));
  H(check, NULL, rec, PAIRS_CHECKED, NULL, 0, NULL, 0);
  memcpy(rec + PAIRS_CHECKED, check, 4);
  okcore_flashsector(rec, (unsigned long *)((pairs.gen & 1) ? PAIRS_B : PAIRS_A), PAIRS_BYTES);
}

/*
 * The link comes first, then the list: a crash between them leaves a peer-add
 * in the chain with no peer on the key (re-add it, harmless), never a peer the
 * chain has no record of - every place a copy goes must show in the history.
 * slot = the peer's index (CHOSEN, pending the spec: R20 names only the subject).
 */
static void peer_add_pressed(void) {
  pairs_load();
  if (pairs.peer_n >= MAX_PEERS) { status(EDGE_PEERS_FULL); return; }
  uint8_t index = pairs.peer_n;
  append(OP_PEER_ADD, OKEDGE_DECISION_APPROVE, index, FLAG_PRESS_OBSERVED, press.verified, 0, 0, NULL);
  memcpy(pairs.peer[index], press.peer, 64);
  pairs.peer_n++;
  pairs_save();
  reply_seq_head();
}

/* the later peers move down one: indexes are positions in today's list, not ids */
/*
 * SYNC (okedge sync phase 2; Brad, 2026-10-05: "every approved sync writes a
 * sync link, subject = SHA256 of what moved; owes no ticket"). The key computes
 * the subject from SYNC's three parts (the case below) - it cannot see what a
 * phone or the Worker holds, but it does check the place is on its own list -
 * and the person reads what moved on the sheet before the press; the link makes
 * "a sync was approved here, of exactly this" part of the history. Op 20,
 * decision approve, slot 0, the press flag; no budget, so no ticket is owed.
 */
static void sync_pressed(void) {
  append(OP_SYNC, OKEDGE_DECISION_APPROVE, 0, FLAG_PRESS_OBSERVED, press.verified, 0, 0, NULL);
  reply_seq_head();
}

/*
 * R29 SIBLINGS: other keys with their own chain that are yours (Brad's second
 * phone), paired with a press on EACH, unpaired the same way. Kept in the pairs
 * record beside the peers, so NOT in the backup either (Brad, 2026-10-05: a
 * restored key pairs again). The subject the press binds: SHA256("OKEDGE-
 * SIBLING-v1" || the sibling's Edge key X || Y || its device id). The 6-digit
 * code the person compares on both phones is the APP's (spec, 2026-10-05: the
 * computer relays the keys and could swap one); the key checks the id belongs
 * to the key, and refuses itself, a known sibling and a fifth. Link first, then
 * the list (as for peers).
 */
static void sibling_subject(const uint8_t key[64], const uint8_t id[ID_BYTES], uint8_t out[32]) {
  H(out, "OKEDGE-SIBLING-v1", key, 64, id, ID_BYTES, NULL, 0);
}

static void sibling_add_pressed(void) {
  pairs_load();
  if (pairs.sib_n >= MAX_SIBLINGS) { status(EDGE_SIBLINGS_FULL); return; }
  uint8_t index = pairs.sib_n;
  append(OP_SIBLING_ADD, OKEDGE_DECISION_APPROVE, 0, FLAG_PRESS_OBSERVED, press.verified, 0, 0, NULL);
  memcpy(pairs.sib[index], press.peer, 64);
  memcpy(pairs.sib[index] + 64, press.sib_id, ID_BYTES);
  pairs.sib_n++;
  pairs_save();
  reply_seq_head();
}

static void sibling_remove_pressed(void) {
  pairs_load();
  uint8_t index = (uint8_t)press.id;
  if (index >= pairs.sib_n) { status(EDGE_NO_SUCH_SIBLING); return; }
  append(OP_SIBLING_REMOVE, OKEDGE_DECISION_APPROVE, 0, FLAG_PRESS_OBSERVED, press.verified, 0, 0, NULL);
  for (int i = index; i + 1 < pairs.sib_n; i++) memcpy(pairs.sib[i], pairs.sib[i + 1], 64 + ID_BYTES);
  pairs.sib_n--;
  memset(pairs.sib[pairs.sib_n], 0, 64 + ID_BYTES);
  pairs_save();
  reply_seq_head();
}

static void peer_remove_pressed(void) {
  pairs_load();
  uint8_t index = (uint8_t)press.id;
  if (index >= pairs.peer_n) { status(EDGE_NO_SUCH_PEER); return; }
  append(OP_PEER_REMOVE, OKEDGE_DECISION_APPROVE, index, FLAG_PRESS_OBSERVED, press.verified, 0, 0, NULL);
  for (int i = index; i + 1 < pairs.peer_n; i++) memcpy(pairs.peer[i], pairs.peer[i + 1], 64);
  pairs.peer_n--;
  memset(pairs.peer[pairs.peer_n], 0, 64);
  pairs_save();
  reply_seq_head();
}

/*
 * R26 REPLAY: [6..52] the link's first REPLAY_BYTES (byte 46 is R3's scope;
 * bytes 47-63 of every link are reserved zeros), [53..60] the first 8 bytes of the head the copy stored
 * after it (CHOSEN, pending the spec). The key takes it only as its NEXT seq,
 * and only if welding it onto its own head gives the head the copy stored -
 * the seq alone would let any link through, and the copy's own head is the one
 * thing that says where it forked. Then the debt rules, as if the key had
 * written it: a use owes, a ticket pays its ref_seq, a waive over exactly this
 * list clears it.
 */
#define REPLAY_BYTES 47 /* R3: through byte 46, the scope */
#define REPLAY_HEAD_BYTES 8
static void replay(const uint8_t *buffer) {
  uint8_t link[LINK_BYTES];
  if (!st.restored || st.replay_closed) { status(EDGE_REPLAY_CLOSED); return; }
  if (!tent_active) { tent = st; tent_active = 1; } /* tentative: the record keeps the backup's state */
  memset(link, 0, sizeof(link));
  memcpy(link, buffer + 6, REPLAY_BYTES);
  uint32_t seq = get32(link);
  if (seq != (tent.seq == SEQ_NONE ? 0 : tent.seq + 1)) { status(EDGE_REPLAY_MISMATCH); return; }
  if (!weld_in(&tent, link, NULL, buffer + 6 + REPLAY_BYTES)) { status(EDGE_REPLAY_MISMATCH); return; }
  status(EDGE_OK);
}

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
  pend.armed = armed; /* R16: taken before the token check below can spend the arm */
  pend.opcode = opcode;
  pend.slot = slot;
  H(pend.subject, NULL, msg, msg_len, NULL, 0, NULL, 0); /* SHA-256 of exactly what was submitted */
  /* R11a: an agent request is message || identity label (32): the label picks the derived key */
  pend.has_label = derived_code(slot) && msg_len >= 32;
  if (pend.has_label) memcpy(pend.label, msg + msg_len - 32, LABEL_PREFIX);
  state_load();
  if (armed) {
    /* R13a: this request, after THIS head, is the one the arm was for - or the arm is spent */
    uint8_t t[32];
    H(t, "OKEDGE-ARM-v1", st.head, 32, pend.subject, 32, NULL, 0);
    if (memcmp(t, arm_token, 32) != 0) armed = 0;
  }
  struct scope *sc;
  int i = budget_for(opcode == OKSIGN ? OP_SIGN : OP_DECRYPT, slot, pend.has_label ? pend.label : NULL, &sc);
  if (i >= 0) {
    pend.budget = (int8_t)i;
    user_input_mode = USER_INPUT_NONE; /* an armed budget pays: the firmware's own no-press path runs it (R13) */
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
    else if (what == PRESS_REPLAY_DONE) replay_done_pressed();
    else if (what == PRESS_LOSS) loss_pressed();
    else if (what == PRESS_AGENT_ADD) agent_add_pressed();
    else if (what == PRESS_PEER_ADD) peer_add_pressed();
    else if (what == PRESS_PEER_REMOVE) peer_remove_pressed();
    else if (what == PRESS_SYNC) sync_pressed();
    else if (what == PRESS_SIBLING_ADD) sibling_add_pressed();
    else if (what == PRESS_SIBLING_REMOVE) sibling_remove_pressed();
    press_drop();
    return;
  }
  if (!pend.active) return;
  if (decision == OKEDGE_DECISION_APPROVE && packet_buffer_details[0] != pend.opcode) return;
  pend.active = 0;
  if (!ensure_identity()) return; /* no K132 yet: nothing to chain to */
  uint8_t op = pend.opcode == OKSIGN ? OP_SIGN : OP_DECRYPT;
  uint8_t flags = owes() ? FLAG_PREV_NO_TICKET : 0; /* R17's empty hook */
  /*
   * R16 (Brad, 2026-10-02 evening: "a ticket is not owed, because it was a
   * direct use of the ssh agent, not the Edge agent"). Decided HERE, written
   * into the link - the chain can't replay "ARMed" or expiry, and weld_in,
   * REPLAY and the lib's keyDebts read only the link:
   *   - ARMED (an arm waited at the prime, matched or not): owes, any slot;
   *   - not ARMed, but a budget covers the op and slot (from its opening to
   *     its end - on hold or used up, it still covers): owes - the agent's key
   *     used outside Edge;
   *   - neither: owes nothing (the person's own keys), still linked.
   */
  if (pend.armed) flags |= FLAG_ARMED;
  if (decision == OKEDGE_DECISION_APPROVE && (pend.armed || covered(op, pend.slot, pend.has_label ? pend.label : NULL))) flags |= FLAG_OWES_TICKET;

  if (decision == OKEDGE_DECISION_APPROVE && pend.budget >= 0) {
    struct scope *sc;
    if (budget_for(op, pend.slot, pend.has_label ? pend.label : NULL, &sc) == pend.budget) { /* still armed, live, with room */
      struct budget *b = &budgets[pend.budget];
      uint8_t reveal[32];
      b->used++;
      sc->used++;
      hash_times(reveal, b->seed, b->uses - b->used); /* v_i = H^(n-i)(seed) (lib grants.reveal) */
      append_scoped(op, DECISION_SELF_PRESS, pend.slot, flags | FLAG_BUDGET_SPENT, pend.subject, b->id, b->used,
                    (uint8_t)(sc - b->scopes + 1), reveal); /* R3: byte 46, which scope paid */
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
  /* the peers go too: a wiped key is a new device and pairs again with a press (R20) */
  okcore_flashsector(blank, (unsigned long *)PAIRS_A, 4);
  okcore_flashsector(blank, (unsigned long *)PAIRS_B, 4);
  memset(&pairs, 0, sizeof(pairs));
  pairs_loaded = 1;
  memset(budgets, 0, sizeof(budgets));
  memset(held, 0, sizeof(held));
  memset(&ident, 0, sizeof(ident));
  memset(&st, 0, sizeof(st));
  st.seq = SEQ_NONE;
  loaded = 1;
  armed = 0;
  tent_active = 0;
  pend.active = 0;
  press_drop();
}

/* ------------------------------------------------------------ backup (DESIGN.md 6) */

/*
 * The plugin backup section (node-onlykey-lib/cli/firmware-plugins.js):
 *   2 . seq u32 . head 32 . owed_n . overflow . owed_n x (seq u32, head 32)
 * The debts travel with the backup, because R16 lets only a ticket or a waive
 * pay them - a restore must not be a way to forgive them. The device id and
 * the Edge key come back with K132, which the backup already carries; budgets
 * end at a restore anyway (their seeds were never stored); the links
 * themselves are the hosts'. Version 1 (37 bytes, no debts) still restores.
 * Version 3 (R28) adds the chain's device id after the debts, so a restore can
 * tell its own chain (R26 replay) from another device's (a continue link). The
 * SALT IS NEVER HERE: a backup restored onto another device must not become it.
 */
int okplugin_edge_backup(uint8_t *out, int max) {
  state_load();
  if (!ensure_identity()) return 0;
  int len = 39 + 36 * st.owed_n + ID_BYTES;
  if (max < len || st.seq == SEQ_NONE) return 0; /* no chain yet: nothing to keep */
  out[0] = 3;
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
  if (len < 37 || in[0] < 1 || in[0] > 3) return; /* a version this build does not know: keep what it has */
  uint8_t n = 0;
  if (in[0] >= 2) {
    if (len < 39) return;
    n = in[37] > OWED_MAX ? OWED_MAX : in[37];
    if (len < 39 + 36 * n + (in[0] == 3 ? ID_BYTES : 0)) return;
  }
  /*
   * Keep the record generation counting UP: the newer of the two sectors wins at
   * boot, so a restore that started again at 1 lost to the older record left in
   * the other sector (found by the kit test: the key came back at the right seq
   * but without the LOSS link).
   */
  state_load();
  uint32_t gen = st.gen;
  /* R28: THIS device's salt stays - the backup never carries one */
  uint8_t salted = st.salted, salt[32];
  memcpy(salt, st.salt, 32);
  int own_chain = 0;
  if (in[0] == 3 && salted && ensure_identity()) own_chain = memcmp(in + 39 + 36 * n, ident.device_id, ID_BYTES) == 0;
  memset(&st, 0, sizeof(st));
  memset(&ident, 0, sizeof(ident));
  st.gen = gen;
  st.salted = salted;
  memcpy(st.salt, salt, 32);
  memset(salt, 0, 32);
  st.seq = get32(in + 1);
  memcpy(st.head, in + 5, 32);
  if (in[0] >= 2) {
    st.owed_n = n;
    st.overflow = in[38] ? 1 : 0;
    for (int i = 0; i < n; i++) {
      st.owed[i].seq = get32(in + 39 + 36 * i);
      memcpy(st.owed[i].head, in + 39 + 36 * i + 4, 32);
    }
  }
  /*
   * R26 replay only onto the device's OWN chain. Another device's backup (or
   * one from before R28): this device continues it on a chain of its own - the
   * continue link is written on the first Edge request, carrying the debts.
   */
  if (own_chain) st.restored = 1; /* R26: restoring - replay, then REPLAY_DONE with a press */
  else if (in[0] == 3) {
    st.cont = CONT_FROM_ID;
    memcpy(st.cont_id, in + 39 + 36 * n, ID_BYTES);
  } else st.cont = CONT_FROM_UNSALTED;
  tent_active = 0;
  st.replay_closed = 0;
  st.replayed_to = st.seq;
  memset(held, 0, sizeof(held));
  memset(budgets, 0, sizeof(budgets));
  armed = 0;
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
      r[59] = st.restored;
      r[60] = refused_arms; /* B7: refused ARMs since power-up (RAM only) */
      reply(r, 61);
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
      /* R26: nothing is signed while restoring - or a host replays invented links and gets their head signed */
      if (st.restored) { status(EDGE_RESTORING); return; }
      checkpoint();
      return;
    case OKEDGE_VOUCH:
      /* R26: seq . head . tag for the current head; never while restoring, for the same reason */
      if (st.restored) { status(EDGE_RESTORING); return; }
      reply_seq_head();
      return;
    case OKEDGE_PUBKEY:
      reply(ident.pub, 64);
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
       * refused while a ticket is owed or a restore is unfinished (R18, R26).
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
    case OKEDGE_TICKET: {
      /*
       * ref_seq u32 . code u8 . msg_hash 32, for ANY owed use (R16):
       *   SHA256("OKEDGE-TICKET-v1" || ref_seq || head[ref_seq] || code || msg_hash)
       * (lib tickets.ticketSubject), head[ref_seq] from the owed list. The message
       * itself never reaches the key. reply: seq . head after the ticket link.
       */
      uint32_t ref = get32(buffer + 6);
      uint8_t code = buffer[10];
      int k = -1;
      for (int i = 0; i < st.owed_n; i++) if (st.owed[i].seq == ref) { k = i; break; }
      if (k < 0) { status(EDGE_NO_TICKET_WAITING); return; }
      uint8_t ref4[4], subject[32];
      put32(ref4, ref);
      SHA256_CTX ctx;
      sha256_init(&ctx);
      sha256_update(&ctx, (const unsigned char *)"OKEDGE-TICKET-v1", 16);
      sha256_update(&ctx, ref4, 4);
      sha256_update(&ctx, st.owed[k].head, 32);
      sha256_update(&ctx, &code, 1);
      sha256_update(&ctx, buffer + 11, 32);
      sha256_final(&ctx, subject);
      append(OP_TICKET, code, 0, 0, subject, ref, 0, NULL); /* the weld pays ref */
      reply_seq_head();
      return;
    }
    case OKEDGE_WAIVE: {
      /* R18: a physical press clears every debt (the person's Yes in ok-rn comes first) */
      uint8_t what[32];
      press_drop();
      if (!owes()) { status(EDGE_NO_TICKET_WAITING); return; }
      H(what, "OKEDGE-WAIVE", st.head, 32, NULL, 0, NULL, 0);
      press_wait(PRESS_WAIVE, what);
      return;
    }
    case OKEDGE_ARM: {
      /*
       * R13a, like ssh-agent: the agent's wire asks, the key decides. ARM {token}
       * arms ONE self-press when nothing is owed, no restore is unfinished and
       * some budget (alive, off hold, uses left) could pay. Whether the token
       * fits - this head, this request - is decided when the request is primed
       * (okplugin_edge_primed); a stale head shows there, as a press.
       */
      if (st.restored) { refuse_arm(EDGE_RESTORING); return; }
      if (owes()) { refuse_arm(EDGE_TICKET_OWED); return; }
      if (!any_budget_payable()) { refuse_arm(EDGE_NOTHING_TO_ARM); return; }
      memcpy(arm_token, buffer + 6, 32);
      armed = 1;
      status(EDGE_OK);
      return;
    }
    case OKEDGE_REPLAY:
      replay(buffer);
      return;
    case OKEDGE_LOSS: {
      /*
       * from u32 . to u32, a press. Only a past range (to at or before the head)
       * can be lost; refused while restoring - the Restore card's REPLAY_DONE
       * writes that LOSS.
       */
      uint32_t from = get32(buffer + 6), to = get32(buffer + 10);
      uint8_t what[32];
      press_drop();
      if (st.restored) { status(EDGE_RESTORING); return; }
      if (st.seq == SEQ_NONE || from > to || to > st.seq) { status(EDGE_BAD_RANGE); return; }
      press.vouch_seq = from;
      press.id = to;
      H(what, "OKEDGE-LOSS", buffer + 6, 8, st.head, 32, NULL, 0);
      press_wait(PRESS_LOSS, what);
      return;
    }
    case OKEDGE_AGENT_ADD: {
      /* {agent key 32}, a press; refused while restoring (nothing new is linked until the restore is finished, R26) */
      uint8_t what[32];
      press_drop();
      if (st.restored) { status(EDGE_RESTORING); return; }
      /* the subject waits in press.verified until the press writes it */
      H(press.verified, "OKEDGE-AGENT-v1", buffer + 6, 32, NULL, 0, NULL, 0);
      press.verified_len = 32;
      H(what, "OKEDGE-AGENT-ADD", press.verified, 32, st.head, 32, NULL, 0);
      press_wait(PRESS_AGENT_ADD, what);
      return;
    }
    case OKEDGE_PEER_ADD: {
      /*
       * Two parts (CHOSEN, pending the spec): X || Y does not fit beside the
       * header, and the firmware's micro-ecc is built without point
       * compression (uECC_SUPPORT_COMPRESSED_POINT 0) - turning it on would
       * change the base build, which a plugin never does. So, like GRANT_LABEL
       * staging a label for the next GRANT_CREATE:
       *   [6] = 0, X at [7..38]: staged, no press, EDGE:00;
       *   [6] = 1, Y at [7..38]: the staged X with it is the key - checked on
       *   the curve, then the press. A part 1 without a part 0 is 'bad-key'.
       * Refused while restoring, like every new link (R26).
       */
      uint8_t what[32];
      press_drop();
      if (st.restored) { status(EDGE_RESTORING); return; }
      if (buffer[6] == 0) {
        memcpy(peer_x, buffer + 7, 32);
        peer_x_staged = 1;
        status(EDGE_OK);
        return;
      }
      if (buffer[6] != 1 || !peer_x_staged) { status(EDGE_BAD_KEY); return; }
      peer_x_staged = 0;
      memcpy(press.peer, peer_x, 32);
      memcpy(press.peer + 32, buffer + 7, 32);
      if (!uECC_valid_public_key(press.peer, uECC_secp256r1())) { press_drop(); status(EDGE_BAD_KEY); return; }
      pairs_load();
      for (int i = 0; i < pairs.peer_n; i++)
        if (memcmp(pairs.peer[i], press.peer, 64) == 0) { press_drop(); status(EDGE_PEER_KNOWN); return; }
      if (pairs.peer_n >= MAX_PEERS) { press_drop(); status(EDGE_PEERS_FULL); return; }
      /* R20's subject: SHA256 of the key, X || Y - the same 64 bytes PUBKEY answers for the Edge key */
      H(press.verified, NULL, press.peer, 64, NULL, 0, NULL, 0);
      press.verified_len = 32;
      H(what, "OKEDGE-PEER-ADD", press.verified, 32, st.head, 32, NULL, 0);
      press_wait(PRESS_PEER_ADD, what);
      return;
    }
    case OKEDGE_PEER_REMOVE: {
      /* {index} at [6], a press; refused while restoring */
      uint8_t what[32];
      press_drop();
      if (st.restored) { status(EDGE_RESTORING); return; }
      pairs_load();
      if (buffer[6] >= pairs.peer_n) { status(EDGE_NO_SUCH_PEER); return; }
      press.id = buffer[6];
      H(press.verified, NULL, pairs.peer[buffer[6]], 64, NULL, 0, NULL, 0);
      press.verified_len = 32;
      H(what, "OKEDGE-PEER-REMOVE", press.verified, 32, st.head, 32, NULL, 0);
      press_wait(PRESS_PEER_REMOVE, what);
      return;
    }
    case OKEDGE_SYNC: {
      /*
       * The subject (spec, 2026-10-05): SHA256("OKEDGE-SYNC-v1" || SHA256(peer
       * pubkey) || first seq moved || last seq moved || the phone copy's head
       * after the merge || SHA256(the merged Key Chain list, or 32 zero bytes)),
       * seqs u32 LE. The KEY computes it from the parts - and checks the first
       * part names a place on ITS list (R20): no sync is recorded from anywhere
       * else. 104 bytes do not fit one request, so three parts, in order:
       *   [6] = 0: SHA256(peer pubkey) 32 . first u32 . last u32  -> EDGE:00
       *   [6] = 1: the copy's head after the merge 32               -> EDGE:00
       *   [6] = 2: SHA256(Key Chain list) 32 (zeros: none)         -> the press
       * Refused while restoring, like every new link (R26).
       */
      uint8_t what[32];
      uint8_t part = buffer[6];
      press_drop();
      if (st.restored) { sync_parts = 0; status(EDGE_RESTORING); return; }
      if (part == 0) {
        pairs_load();
        uint8_t h[32];
        int known = 0;
        for (int i = 0; i < pairs.peer_n && !known; i++) {
          H(h, NULL, pairs.peer[i], 64, NULL, 0, NULL, 0);
          known = memcmp(h, buffer + 7, 32) == 0;
        }
        sync_parts = 0;
        if (!known) { status(EDGE_NO_SUCH_PEER); return; }
        if (get32(buffer + 39) > get32(buffer + 43)) { status(EDGE_BAD_RANGE); return; }
        memcpy(sync_fields, buffer + 7, 40);
        sync_parts = 1;
        status(EDGE_OK);
        return;
      }
      if (part == 1 && sync_parts == 1) {
        memcpy(sync_fields + 40, buffer + 7, 32);
        sync_parts = 2;
        status(EDGE_OK);
        return;
      }
      if (part != 2 || sync_parts != 2) { sync_parts = 0; status(EDGE_SYNC_ORDER); return; }
      memcpy(sync_fields + 72, buffer + 7, 32);
      sync_parts = 0;
      H(press.verified, "OKEDGE-SYNC-v1", sync_fields, sizeof(sync_fields), NULL, 0, NULL, 0);
      press.verified_len = 32;
      H(what, "OKEDGE-SYNC", press.verified, 32, st.head, 32, NULL, 0);
      press_wait(PRESS_SYNC, what);
      return;
    }
    case OKEDGE_SIBLING_ADD: {
      /*
       * Two parts, as PEER_ADD (X || Y does not fit; no point decompression in
       * the base build): [6] = 0, X at [7..38] -> staged, EDGE:00 (a new X drops
       * any pending one); [6] = 1, Y at [7..38], device id at [39..54] -> the
       * whole key checked, then the press. Refused while restoring (R26).
       */
      uint8_t what[32];
      press_drop();
      if (st.restored) { status(EDGE_RESTORING); return; }
      if (buffer[6] == 0) {
        memcpy(sib_x, buffer + 7, 32);
        sib_x_staged = 1;
        status(EDGE_OK);
        return;
      }
      if (buffer[6] != 1 || !sib_x_staged) { status(EDGE_BAD_KEY); return; }
      sib_x_staged = 0;
      memcpy(press.peer, sib_x, 32);
      memcpy(press.peer + 32, buffer + 7, 32);
      memcpy(press.sib_id, buffer + 39, ID_BYTES);
      if (!uECC_valid_public_key(press.peer, uECC_secp256r1())) { press_drop(); status(EDGE_BAD_KEY); return; }
      {
        /* the id must be the one this key's chain is named by (chain.deviceIdOf) - and never this key itself */
        uint8_t h[32];
        H(h, "OKEDGE-DEVICE-v1", press.peer, 64, NULL, 0, NULL, 0);
        if (memcmp(h, press.sib_id, ID_BYTES) != 0 || memcmp(press.peer, ident.pub, 64) == 0) { press_drop(); status(EDGE_BAD_KEY); return; }
      }
      pairs_load();
      for (int i = 0; i < pairs.sib_n; i++)
        if (memcmp(pairs.sib[i], press.peer, 64) == 0) { press_drop(); status(EDGE_SIBLING_KNOWN); return; }
      if (pairs.sib_n >= MAX_SIBLINGS) { press_drop(); status(EDGE_SIBLINGS_FULL); return; }
      sibling_subject(press.peer, press.sib_id, press.verified);
      press.verified_len = 32;
      H(what, "OKEDGE-SIBLING-ADD", press.verified, 32, st.head, 32, NULL, 0);
      press_wait(PRESS_SIBLING_ADD, what);
      return;
    }
    case OKEDGE_SIBLING_REMOVE: {
      /* {index} at [6], a press; refused while restoring */
      uint8_t what[32];
      press_drop();
      if (st.restored) { status(EDGE_RESTORING); return; }
      pairs_load();
      if (buffer[6] >= pairs.sib_n) { status(EDGE_NO_SUCH_SIBLING); return; }
      press.id = buffer[6];
      sibling_subject(pairs.sib[buffer[6]], pairs.sib[buffer[6]] + 64, press.verified);
      press.verified_len = 32;
      H(what, "OKEDGE-SIBLING-REMOVE", press.verified, 32, st.head, 32, NULL, 0);
      press_wait(PRESS_SIBLING_REMOVE, what);
      return;
    }
    case OKEDGE_SIBLING_LIST: {
      /* count . max, then one report per slot (always max): X || Y, zeros when empty - the id is the key's own (chain.deviceIdOf) */
      pairs_load();
      r[0] = pairs.sib_n;
      r[1] = MAX_SIBLINGS;
      reply(r, 2);
      for (int i = 0; i < MAX_SIBLINGS; i++) {
        memset(r, 0, sizeof(r));
        if (i < pairs.sib_n) memcpy(r, pairs.sib[i], 64);
        reply(r, 64);
      }
      return;
    }
    case OKEDGE_PEER_LIST: {
      /*
       * count . k . max, then one report per SLOT (always max of them, so a
       * host knows how many to wait for): the key X || Y, its index = its
       * place; an empty slot is all zeros (not a point). k = 0 and no
       * backed_through until E5's receipts (R21, R22) - they get their own
       * reports then. No press: public keys only (R8). (CHOSEN, pending the spec.)
       */
      pairs_load();
      r[0] = pairs.peer_n;
      r[1] = 0;
      r[2] = MAX_PEERS;
      reply(r, 3);
      for (int i = 0; i < MAX_PEERS; i++) {
        memset(r, 0, sizeof(r));
        if (i < pairs.peer_n) memcpy(r, pairs.peer[i], 64);
        reply(r, 64);
      }
      return;
    }
    case OKEDGE_REPLAY_DONE: {
      /*
       * [6..9] the seq the host replayed to, [10..25] the key's vouch tag for
       * it, [26..29] the newest seq its copies hold (CHOSEN, pending the spec:
       * so a LOSS can name what was not vouched; 0xFFFFFFFF = not said)
       */
      uint8_t what[32];
      press_drop();
      if (!st.restored) { status(EDGE_REPLAY_CLOSED); return; }
      press.vouch_seq = get32(buffer + 6);
      memcpy(press.verified, buffer + 10, VOUCH_BYTES);
      press.id = get32(buffer + 26);
      H(what, "OKEDGE-REPLAY-DONE", buffer + 6, 4, st.head, 32, NULL, 0);
      press_wait(PRESS_REPLAY_DONE, what);
      return;
    }
    default:
      status(EDGE_UNKNOWN_REQUEST);
      return;
  }
}
