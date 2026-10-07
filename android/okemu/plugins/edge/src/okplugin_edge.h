/*
 * edge - the minimal firmware half of OnlyKey Edge: the key is a notary
 * (DESIGN.md section 0). It welds each sign/decrypt decision into the key's
 * chain, decides budget self-presses (each ARMed), signs budget geneses and
 * checkpoints, keeps the owed tickets, and links tickets and waives; node-onlykey-lib/edge does everything else.
 */
#ifndef OKPLUGIN_EDGE_H
#define OKPLUGIN_EDGE_H

#include <stdint.h>
#include <stddef.h>

#define OK_PLUGIN_EDGE 1

/* the vendor message, 0xF8 on the wire */
#define OKEDGE (TYPE_INIT | 0x78)

/* OKEDGE sub-ops (recv_buffer[5]) */
#define OKEDGE_HEAD 0x01
#define OKEDGE_PICKUP 0x02
#define OKEDGE_CHECKPOINT 0x03
#define OKEDGE_PUBKEY 0x04
#define OKEDGE_VOUCH 0x05        /* R26: seq . head . vouch tag for the current head; refused while restoring */
#define OKEDGE_GRANT_CREATE 0x10
#define OKEDGE_GRANT_LABEL 0x11   /* R11a: {scope index, label 32}, no press - stages a derived identity's label for the next GRANT_CREATE */
#define OKEDGE_GRANT_REVOKE 0x12
#define OKEDGE_GRANT_HOLD 0x13   /* R15a: no press */
#define OKEDGE_GRANT_RESUME 0x14 /* R15a: press */
#define OKEDGE_TICKET 0x20       /* replies seq . head */
#define OKEDGE_WAIVE 0x21        /* R18: press; replies seq . head */
#define OKEDGE_ARM 0x22          /* R13a: ARM {head} */
#define OKEDGE_REPLAY 0x23       /* R26: a link of the newest copy, while restoring */
#define OKEDGE_AGENT_ADD 0x15    /* mcp-service 4.7a: {agent key 32}, press; an agent-add link, subject = SHA256("OKEDGE-AGENT-v1" || key) */
#define OKEDGE_PEER_ADD 0x30     /* R20: two parts - {0, X 32} staged, then {1, Y 32} and a press; a peer-add link, subject = SHA256(X || Y) */
#define OKEDGE_PEER_REMOVE 0x31  /* R20: {index}, press; a peer-remove link, subject = SHA256(X || Y) of that peer */
#define OKEDGE_SYNC 0x39         /* sync phase 2 (spec, 2026-10-05): three parts - {0, SHA256(peer), first, last}, {1, head}, {2, Key Chain hash} - then a press; the key computes the subject; a sync link (op 20), owes no ticket */
#define OKEDGE_SIBLING_ADD 0x35    /* R29: two parts - {0, X 32} staged, then {1, Y 32, device id 16} and a press; a sibling link (op 17) */
#define OKEDGE_SIBLING_REMOVE 0x36 /* R29: {index}, press; a sibling-remove link (op 18) */
#define OKEDGE_SIBLING_LIST 0x37   /* R29: no press; count . max, then one report per slot: X || Y (zeros = empty) */
#define OKEDGE_ANCHOR 0x38         /* R30: three parts - {0, sibling index, seq, head}, {1, sig r}, {2, sig s} - the key checks the sibling's checkpoint, then a press; an anchor link (op 19) */
#define OKEDGE_PEER_LIST 0x32    /* R20: no press; count . k . max, then one report per slot: X || Y (zeros = empty) */
#define OKEDGE_LOSS 0x34         /* R24: {from, to}, press; a LOSS link the person accepts; refused while restoring */
#define OKEDGE_REPLAY_DONE 0x24  /* R26: {seq, tag, newest}, press; commits only a vouched replay; replies seq . head . tag or EDGE:11 */
#define OKEDGE_REPLAY_INTENT 0x25 /* R13b: {intent 16}, while restoring - the next REPLAY of a self-press link welds it into bytes 47-62 */
/* HEAD byte 61: what this build understands (R13b: ARM {token, intent}) */
#define OKEDGE_CAP_INTENT 0x01
/* R3 (2026-10-06): byte 63 of every link this build writes - 0 = the links before it (no version), still readable */
#define OKEDGE_LINK_VERSION 1

/*
 * Text replies are "EDGE:xx" - two hex digits, no sentences (owner, 2026-10-02:
 * "keep the return strings minimal in firmware"). Edge JS turns each into words.
 */
#define EDGE_OK 0x00
#define EDGE_NEED_PIN 0x01          /* no K132 yet: set a PIN first */
#define EDGE_BAD_SCOPES 0x02        /* a budget has 1 to 4 scopes */
#define EDGE_SCOPE_NOT_ALLOWED 0x03 /* op/slot a budget may not pay for (R14) */
#define EDGE_TOO_MANY_USES 0x04     /* more than 1024 uses */
#define EDGE_LIVE_FULL 0x05         /* 4 budgets already live */
#define EDGE_SIGN_FAILED 0x06       /* the Edge key could not sign */
#define EDGE_NO_SUCH_BUDGET 0x07    /* revoke: no live budget with that id */
#define EDGE_NO_TICKET_WAITING 0x08 /* ticket: that use owes nothing; waive: nothing owed */
#define EDGE_NOT_HELD 0x09          /* pickup: that link is no longer held */
#define EDGE_UNKNOWN_REQUEST 0x0A
#define EDGE_STALE_HEAD 0x0B        /* ARM: not the current head */
#define EDGE_TICKET_OWED 0x0C       /* R18: a ticket is owed - no ARM, GRANT_CREATE or GRANT_RESUME */
#define EDGE_NOTHING_TO_ARM 0x0D    /* ARM: no live budget off hold with uses left */
#define EDGE_RESTORING 0x0E         /* R26: restored, not finished - no ARM, GRANT_CREATE or GRANT_RESUME */
#define EDGE_REPLAY_MISMATCH 0x0F   /* REPLAY: not the next seq, or it does not weld to the head the copy stored */
#define EDGE_REPLAY_CLOSED 0x10     /* REPLAY: not restoring, or the key already wrote a link of its own */
#define EDGE_BAD_RANGE 0x12         /* LOSS: from > to, or to past the key's head (CHOSEN, pending the spec) */
#define EDGE_NOT_VOUCHED 0x11       /* REPLAY_DONE: the tag is not the key's for the replayed head - thrown away, LOSS since the backup */
#define EDGE_PEERS_FULL 0x13       /* PEER_ADD: 4 peers already (R20) */
#define EDGE_PEER_KNOWN 0x14       /* PEER_ADD: that key is a peer already */
#define EDGE_BAD_KEY 0x15          /* PEER_ADD: not a P-256 point, or Y without its X */
#define EDGE_NO_SUCH_PEER 0x16     /* PEER_REMOVE: no peer at that index */
#define EDGE_SIBLING_KNOWN 0x18     /* SIBLING_ADD: that key is a sibling already (CHOSEN number) */
#define EDGE_SIBLINGS_FULL 0x19     /* SIBLING_ADD: 4 siblings already (CHOSEN number) */
#define EDGE_NO_SUCH_SIBLING 0x1A   /* SIBLING_REMOVE / ANCHOR: no sibling at that index (CHOSEN number) */
#define EDGE_BAD_CHECKPOINT 0x1B    /* ANCHOR: the checkpoint does not verify under that sibling's key (CHOSEN number) */
#define EDGE_ARM_MISMATCH 0x1C      /* R13a (2026-10-06): the sign was not the request the ARM was for - refused, the ARM is used up */
#define EDGE_SYNC_ORDER 0x17       /* SYNC: a part out of order (CHOSEN number); EDGE:16 also answers a peer not on the list, EDGE:12 first > last */

/* decisions, as node-onlykey-lib/edge/codes.js numbers them */
#define OKEDGE_DECISION_APPROVE 1
#define OKEDGE_DECISION_DENY 2
#define OKEDGE_DECISION_TIMEOUT 3

/* recvmsg(): an OKEDGE message */
void okplugin_edge_recv(uint8_t *buffer);
/* okcore_prime_user_confirmation(): an operation is waiting for its decision */
void okplugin_edge_primed(uint8_t opcode, uint8_t slot, const uint8_t *msg, size_t msg_len);
/* the decision points: run_pending_op (approve), wrong challenge (deny), the 20 s fade (timeout) */
void okplugin_edge_decision(int decision);
/* R13a + budget or no go: refuse the primed sign/decrypt before it runs (no press, no link) -> 1 if refused */
int okplugin_edge_refused(void);
/* wipeflashdata(): the key is being wiped */
void okplugin_edge_wipe(void);
/* the plugin backup section (the loader calls these): version 2, seq, head and the owed uses */
int okplugin_edge_backup(uint8_t *out, int max);
void okplugin_edge_restore(const uint8_t *in, int len);

#endif
