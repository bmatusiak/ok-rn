package com.okrn.signer;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;

/**
 * The process that owns the device, and the dull wire to it.
 *
 * ONE PROCESS FOR THE WHOLE JVM. apksigner asks for one signature per
 * signature scheme - two for this app, v2 and v3 - and booting an emulated
 * OnlyKey costs about ten seconds, with a restart-and-unlock cycle costing
 * more. Spawning per digest would pay that twice for no reason, so the backend
 * is started on the first signature and kept until the JVM exits.
 *
 * THE PROTOCOL IS DELIBERATELY DULL. One line in, one line out:
 *
 *     ->  64 hex characters   the SHA-256 digest to sign
 *     <-  512 hex characters  the PKCS#1 v1.5 signature (256 bytes, RSA-2048)
 *     <-  ERR <message>       anything the device or the helper could not do
 *
 * The interesting failure modes in this system are all on the device side -
 * a locked key, a slot with no signature flag, a press that landed during the
 * priming window. A chatty protocol here would only add failure modes of its
 * own on top of those, and make it harder to tell which layer broke.
 *
 * STDOUT IS THE WIRE, STDERR IS FOR HUMANS. The helper must not print anything
 * to stdout that is not a reply, so any stdout line that is not a signature or
 * an ERR is treated as a fatal protocol error rather than skipped - a helper
 * that has started narrating into the wire is not one to keep guessing with.
 */
final class OnlyKeyBackend {

  /**
   * The command to run. A single executable or script with no arguments:
   * Windows quoting through ProcessBuilder is a source of silent breakage, and
   * a one-element command line cannot suffer from it. The script supplies its
   * own arguments.
   */
  private static final String CMD_ENV = "OKSIGN_CMD";

  private static OnlyKeyBackend instance;

  private final Process process;
  private final Writer out;
  private final BufferedReader in;

  private OnlyKeyBackend(String command) throws IOException {
    ProcessBuilder pb = new ProcessBuilder(command);
    /*
     * The helper's stderr goes to ours rather than being captured. It carries
     * the device console and the kit's own diagnostics, and when a sign hangs
     * that output is the only thing that says why - swallowing it into a pipe
     * nobody drains is how this becomes undebuggable.
     */
    pb.redirectError(ProcessBuilder.Redirect.INHERIT);
    this.process = pb.start();
    this.out = new OutputStreamWriter(process.getOutputStream(), StandardCharsets.US_ASCII);
    this.in = new BufferedReader(
        new InputStreamReader(process.getInputStream(), StandardCharsets.US_ASCII));
  }

  static synchronized OnlyKeyBackend get() throws IOException {
    if (instance != null && instance.process.isAlive()) {
      return instance;
    }
    String command = System.getenv(CMD_ENV);
    if (command == null || command.isEmpty()) {
      throw new IOException(
          CMD_ENV + " is not set; it must name the signing helper to run "
          + "(a single executable or script, no arguments)");
    }
    instance = new OnlyKeyBackend(command);
    return instance;
  }

  /**
   * @param digest 32 bytes, already hashed
   * @return       256 bytes, a PKCS#1 v1.5 RSA-2048 signature
   */
  synchronized byte[] sign(byte[] digest) throws IOException {
    out.write(toHex(digest));
    out.write('\n');
    out.flush();

    String reply = in.readLine();
    if (reply == null) {
      throw new IOException(
          "the signing helper closed its output without replying; it has "
          + "probably exited - see its stderr above");
    }
    reply = reply.trim();
    if (reply.startsWith("ERR")) {
      throw new IOException("the signing helper refused: " + reply.substring(3).trim());
    }
    byte[] sig = fromHex(reply);
    if (sig == null) {
      throw new IOException(
          "expected a hex signature or ERR on stdout, got: " + abbreviate(reply));
    }
    return sig;
  }

  private static String abbreviate(String s) {
    return s.length() <= 80 ? s : s.substring(0, 80) + "...";
  }

  private static String toHex(byte[] b) {
    StringBuilder sb = new StringBuilder(b.length * 2);
    for (byte x : b) {
      sb.append(Character.forDigit((x >> 4) & 0xF, 16));
      sb.append(Character.forDigit(x & 0xF, 16));
    }
    return sb.toString();
  }

  /** null rather than an exception, so the caller can report what it got. */
  private static byte[] fromHex(String s) {
    if (s.isEmpty() || (s.length() % 2) != 0) {
      return null;
    }
    byte[] out = new byte[s.length() / 2];
    for (int i = 0; i < out.length; i++) {
      int hi = Character.digit(s.charAt(i * 2), 16);
      int lo = Character.digit(s.charAt(i * 2 + 1), 16);
      if (hi < 0 || lo < 0) {
        return null;
      }
      out[i] = (byte) ((hi << 4) | lo);
    }
    return out;
  }
}
