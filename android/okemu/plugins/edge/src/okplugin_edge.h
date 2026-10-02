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
#define OKEDGE_GRANT_CREATE 0x10
#define OKEDGE_GRANT_REVOKE 0x12
#define OKEDGE_GRANT_HOLD 0x13   /* R15a: no press */
#define OKEDGE_GRANT_RESUME 0x14 /* R15a: press */
#define OKEDGE_TICKET 0x20       /* replies seq . head */
#define OKEDGE_WAIVE 0x21        /* R18: press; replies seq . head */
#define OKEDGE_ARM 0x22          /* R13a: ARM {head} */

/*
 * Text replies are "EDGE:xx" - two hex digits, no sentences (owner, 2026-10-02:
 * "keep the return strings minimal in firmware"). Edge JS turns each into words.
 */
#define EDGE_OK 0x00
#define EDGE_NEED_PIN 0x01          /* no K132 yet: set a PIN first */
#define EDGE_BAD_SCOPES 0x02        /* a budget has 1 to 4 scopes */
#define EDGE_SCOPE_NOT_ALLOWED 0x03 /* op/slot a budget may not pay for (R14) */
#define EDGE_TOO_MANY_USES 0x04     /* more than 255 uses */
#define EDGE_LIVE_FULL 0x05         /* 4 budgets already live */
#define EDGE_SIGN_FAILED 0x06       /* the Edge key could not sign */
#define EDGE_NO_SUCH_BUDGET 0x07    /* revoke: no live budget with that id */
#define EDGE_NO_TICKET_WAITING 0x08 /* ticket: that use owes nothing; waive: nothing owed */
#define EDGE_NOT_HELD 0x09          /* pickup: that link is no longer held */
#define EDGE_UNKNOWN_REQUEST 0x0A
#define EDGE_STALE_HEAD 0x0B        /* ARM: not the current head */
#define EDGE_TICKET_OWED 0x0C       /* R18: a ticket is owed - no ARM, GRANT_CREATE or GRANT_RESUME */
#define EDGE_NOTHING_TO_ARM 0x0D    /* ARM: no live budget off hold with uses left */

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
/* wipeflashdata(): the key is being wiped */
void okplugin_edge_wipe(void);
/* the plugin backup section (the loader calls these): version 2, seq, head and the owed uses */
int okplugin_edge_backup(uint8_t *out, int max);
void okplugin_edge_restore(const uint8_t *in, int len);

#endif
