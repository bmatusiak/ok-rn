package com.okrn.fido

import java.io.ByteArrayOutputStream

/**
 * CTAP-over-BLE fragmentation (CTAP 2.1, section 11.2).
 *
 * The FIDO Control Point characteristic carries at most `maxFragmentSize`
 * bytes per write, so a CTAP command larger than that arrives in pieces:
 *
 *   Initialisation fragment: [CMD | 0x80][HLEN][LLEN][data ...]
 *   Continuation fragment:   [SEQ 0x00..0x7f][data ...]
 *
 * Responses go back out over the FIDO Status characteristic the same way.
 */
object CtapBle {
  const val CMD_PING = 0x81
  const val CMD_KEEPALIVE = 0x82
  const val CMD_MSG = 0x83
  const val CMD_CANCEL = 0xbe
  const val CMD_ERROR = 0xbf

  /** CTAP2 command bytes, for labelling requests in the UI. */
  fun ctap2CommandName(command: Int): String = when (command) {
    0x01 -> "authenticatorMakeCredential"
    0x02 -> "authenticatorGetAssertion"
    0x04 -> "authenticatorGetInfo"
    0x06 -> "authenticatorClientPIN"
    0x07 -> "authenticatorReset"
    0x08 -> "authenticatorGetNextAssertion"
    else -> ""
  }

  /**
   * Splits a CTAP message into BLE fragments of at most [maxFragmentSize] bytes.
   */
  fun fragment(command: Int, payload: ByteArray, maxFragmentSize: Int): List<ByteArray> {
    require(maxFragmentSize >= 4) { "fragment size must leave room for a 3-byte header" }
    val fragments = mutableListOf<ByteArray>()

    val initCapacity = maxFragmentSize - 3
    val firstChunk = payload.copyOfRange(0, minOf(initCapacity, payload.size))
    val init = ByteArray(3 + firstChunk.size)
    init[0] = (command or 0x80).toByte()
    init[1] = ((payload.size shr 8) and 0xff).toByte()
    init[2] = (payload.size and 0xff).toByte()
    firstChunk.copyInto(init, 3)
    fragments.add(init)

    var offset = firstChunk.size
    var seq = 0
    val contCapacity = maxFragmentSize - 1
    while (offset < payload.size) {
      check(seq <= 0x7f) { "CTAP BLE sequence overflow" }
      val chunk = payload.copyOfRange(offset, minOf(offset + contCapacity, payload.size))
      val cont = ByteArray(1 + chunk.size)
      cont[0] = seq.toByte()
      chunk.copyInto(cont, 1)
      fragments.add(cont)
      offset += chunk.size
      seq += 1
    }

    return fragments
  }
}

/** Reassembles inbound Control Point writes into whole CTAP messages. */
class CtapBleAssembler {

  data class Message(val command: Int, val payload: ByteArray) {
    override fun equals(other: Any?): Boolean =
      other is Message && command == other.command && payload.contentEquals(other.payload)

    override fun hashCode(): Int = 31 * command + payload.contentHashCode()
  }

  private var command = 0
  private var expected = 0
  private var nextSeq = 0
  private var inProgress = false
  private val buffer = ByteArrayOutputStream()

  fun reset() {
    inProgress = false
    expected = 0
    nextSeq = 0
    buffer.reset()
  }

  /** Returns a whole message once the final fragment lands, else null. */
  fun push(fragment: ByteArray): Message? {
    if (fragment.isEmpty()) return null
    val head = fragment[0].toInt() and 0xff

    if (head and 0x80 != 0) {
      if (fragment.size < 3) return null
      command = head and 0x7f
      expected = ((fragment[1].toInt() and 0xff) shl 8) or (fragment[2].toInt() and 0xff)
      nextSeq = 0
      inProgress = true
      buffer.reset()
      buffer.write(fragment, 3, fragment.size - 3)
    } else {
      // A continuation with no initialisation fragment, or one that arrived out
      // of order, cannot be spliced in safely - drop the whole message.
      if (!inProgress || head != nextSeq) {
        reset()
        return null
      }
      nextSeq += 1
      buffer.write(fragment, 1, fragment.size - 1)
    }

    if (inProgress && buffer.size() >= expected) {
      val payload = buffer.toByteArray().copyOfRange(0, expected)
      val message = Message(command, payload)
      reset()
      return message
    }
    return null
  }
}
