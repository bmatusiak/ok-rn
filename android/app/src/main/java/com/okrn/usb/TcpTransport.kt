package com.okrn.usb

import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Development transport: a plain TCP socket to the Node.js hardware emulator.
 *
 * The Android emulator reaches the host loopback at 10.0.2.2, not 127.0.0.1.
 * Cleartext to that host is allowed by res/xml/network_security_config.xml,
 * which is wired up for the debug build only.
 */
class TcpTransport(
  private val host: String,
  private val port: Int,
  override val packetSize: Int = 64,
) : HidTransport {

  override val name: String = "tcp"

  private var socket: Socket? = null
  private var input: InputStream? = null
  private var output: OutputStream? = null
  private val reading = AtomicBoolean(false)
  private var readerThread: Thread? = null

  override var onData: ((ByteArray) -> Unit)? = null
  override var onStatus: ((state: String, message: String) -> Unit)? = null

  override fun isOpen(): Boolean = socket?.isConnected == true && socket?.isClosed == false

  override fun open(vendorId: Int, productId: Int) {
    close()
    onStatus?.invoke("connecting", "$host:$port")

    val sock = Socket()
    sock.connect(InetSocketAddress(host, port), CONNECT_TIMEOUT_MS)
    sock.tcpNoDelay = true
    socket = sock
    input = sock.getInputStream()
    output = sock.getOutputStream()

    onStatus?.invoke("connected", "mock server $host:$port")
    startReadLoop()
  }

  private fun startReadLoop() {
    reading.set(true)
    readerThread = thread(name = "ok-tcp-reader", isDaemon = true) {
      val buffer = ByteArray(packetSize)
      try {
        while (reading.get()) {
          val read = input?.read(buffer) ?: -1
          if (read < 0) break
          if (read > 0) {
            onData?.invoke(buffer.copyOf(read))
          }
        }
        if (reading.get()) {
          onStatus?.invoke("disconnected", "mock server closed the connection")
        }
      } catch (e: Exception) {
        // A close() from another thread surfaces here as a socket exception.
        // Only report it if we did not ask for the shutdown ourselves.
        if (reading.get()) {
          onStatus?.invoke("error", e.message ?: "tcp read failed")
        }
      } finally {
        reading.set(false)
      }
    }
  }

  override fun write(bytes: ByteArray): Int {
    val stream = output ?: return -1
    return try {
      stream.write(bytes)
      stream.flush()
      bytes.size
    } catch (e: Exception) {
      onStatus?.invoke("error", e.message ?: "tcp write failed")
      -1
    }
  }

  override fun close() {
    reading.set(false)
    try {
      socket?.close()
    } catch (_: Exception) {
      // Already closed; nothing to recover.
    }
    readerThread = null
    socket = null
    input = null
    output = null
  }

  companion object {
    private const val CONNECT_TIMEOUT_MS = 4000
  }
}
