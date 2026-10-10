# Receipt codes: the agent's one-byte result

**Edge v1.** The numbers are `node-onlykey-lib/edge/src/codes.js` (`RECEIPT`); the firmware stores the byte as given.

After every budget use (a sign or decrypt a budget paid), the agent owes a **receipt**. Until it is filed, nothing automatic happens: no TX start, no new budget, no resume. An ordinary press is not Edge and owes nothing. A use nobody will receipt is cleared only by a person's **settle** (below).

A receipt has two parts:

1. **`code`**: one byte, from the table below.
2. **`message`**: the agent's own words about what it did, at most **1,024 bytes** of UTF-8. The key gets only `msg_hash = SHA256(message)`. The text travels to the phone in the agent's note; the phone shows it, as plain text, only when it hashes to `msg_hash`, else as missing. (The budget's **reason**, read on the approval sheet, is at most 280 bytes.)

On the chain a receipt is one link: op 8, decision = the code, `grant_id` = the seq of the use it answers, and

```
subject = SHA256("OKEDGE-RECEIPT-v1" || ref_seq (u32 LE) || head[ref_seq] || code || msg_hash)
```

`head[ref_seq]` comes from the key's own list of owed uses, so a receipt is bound to the use it answers.

## Structure of the byte

```
 bit 7   6 5 4   3 2 1 0
 +---+-------+---------+
 | A | class | detail  |
 +---+-------+---------+
 A = 1 -> ALARM: a person must review this use
```

- High nibble = **class**, low nibble = **detail**.
- **Bit 7 set = alarm**, with no table lookup needed. The Edge tab shows it red and the phone raises a notification.
- **A code not in the table is also an alarm.** It fails closed: a future version, or a forged copy.
- The CLI takes a code by name (`--code TARGET_UNREACHABLE`), by number or as hex (`0x21`), and refuses anything else; with no `--code` it files `OK`.

## v1 codes

### 0x0_ Success
| Code | Name | Meaning |
|---|---|---|
| `0x00` | `OK` | Used exactly as stated, and the outcome was confirmed (the server accepted it) |
| `0x01` | `OK_UNCONFIRMED` | Used as stated; the outcome was not observed |
| `0x02` | `PARTIAL` | Used as stated, but only part of the work completed |

### 0x1_ Not used
| Code | Name | Meaning |
|---|---|---|
| `0x10` | `NOT_USED` | The result was obtained, then discarded |
| `0x11` | `SUPERSEDED` | Not used; the agent will ask again for the same purpose |

### 0x2_ Downstream failure (the key worked; the target did not)
| Code | Name | Meaning |
|---|---|---|
| `0x20` | `TARGET_REJECTED` | The target refused the result (bad signature, auth refused) |
| `0x21` | `TARGET_UNREACHABLE` | The target could not be reached. `edge exec` files this itself when its command fails, with the command and its exit code |

### 0x3_ Aborted
| Code | Name | Meaning |
|---|---|---|
| `0x30` | `ABORTED_BY_AGENT` | The agent stopped the task on its own judgement |
| `0x31` | `ABORTED_BY_HUMAN` | The person told the agent to stop |

### 0x4_ Agent error
| Code | Name | Meaning |
|---|---|---|
| `0x40` | `AGENT_ERROR` | The agent's own code or tooling failed while using the result |

### 0x8_ Alarm: a person must review
| Code | Name | Meaning |
|---|---|---|
| `0x80` | `USED_DIFFERENTLY` | Used for something other than the stated purpose (the message says what) |
| `0x81` | `SUSPECTED_INJECTION` | The agent believes instructions it received were injected (a file, a web page, tool output) |
| `0x82` | `DATA_EXPOSED` | Decrypted output or a secret may have gone somewhere unintended |
| `0x83` | `POLICY_CONCERN` | The agent was asked to do something it believes the person would not approve |
| `0x8F` | `NEEDS_REVIEW` | Anything else a person should look at. Also the code of a **settle** |

### 0xF_ Indeterminate
| Code | Name | Meaning |
|---|---|---|
| `0xFF` | `UNKNOWN` | The agent cannot tell what happened. Bit 7 is set, so it is an alarm |

## Settle: `0x8F` with the press flag

A settle is the person's way out for uses nobody will receipt: the power was cut mid-use, a signer failed mid-stream, or the agent is no longer allowed. One press on the key ends every live budget (each with a grant-end link, decision 3 settled), then writes **one** receipt link: code `0x8F`, flags `0x01` (press observed), `grant_id` = the seq it settles, and

```
subject = SHA256("OKEDGE-SETTLE-v1" || the owed seq (u32 LE))
```

It clears the debt (the key owes one use at a time, R16). An agent cannot forge one: a RECEIPT the agent files is always written with flags 0, so an agent's own `0x8F` is an ordinary alarm receipt for one use, never a settle.

## What a receipt proves, and what it does not

- **Proven:** *that* the agent made this claim about use `#seq`, and *where* in the chain's order. Once welded, nobody can edit, delete or reorder it.
- **Not proven:** that the claim is true. A tricked agent can file `0x00 OK` and lie. A receipt's value is **accountability**: a committed claim per use, to check against independent evidence (a git signature, a server log).
- **A missing receipt is evidence too.** The use stays owed, the key pays for nothing more, and the phone alerts red after 10 minutes. An owed receipt can still be filed after its budget ended.
