/*
 * edge - OnlyKey Edge on the soft key: every sign/decrypt decision becomes a
 * link in a SHA-256 chain whose head the key keeps (DESIGN.md). Step 1: the
 * chain, its storage, identity, HEAD / READ / CKPT_PUBKEY.
 */
#ifndef OKPLUGIN_EDGE_H
#define OKPLUGIN_EDGE_H

#include <stdint.h>
#include <stddef.h>

#define OK_PLUGIN_EDGE 1

/* the vendor message, 0xF8 on the wire (DESIGN.md 5) */
#define OKEDGE (TYPE_INIT | 0x78)

/* OKEDGE sub-ops (recv_buffer[5]) */
#define OKEDGE_HEAD 0x01
#define OKEDGE_READ 0x02
#define OKEDGE_CKPT_PUBKEY 0x04
#define OKEDGE_LAST_REVEAL 0x05
#define OKEDGE_GRANT_CREATE 0x10
#define OKEDGE_GRANT_LIST 0x11
#define OKEDGE_GRANT_REVOKE 0x12

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

#endif
