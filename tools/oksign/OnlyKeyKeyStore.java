package com.okrn.signer;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.Key;
import java.security.KeyStoreException;
import java.security.KeyStoreSpi;
import java.security.NoSuchAlgorithmException;
import java.security.UnrecoverableKeyException;
import java.security.cert.Certificate;
import java.security.cert.CertificateException;
import java.security.cert.CertificateFactory;
import java.util.Collections;
import java.util.Date;
import java.util.Enumeration;

/**
 * A keystore with one entry, no file, and no secret in it.
 *
 * apksigner's shape is "load a KeyStore, take an alias out of it", so the
 * device has to be presented as one. `--ks NONE` means engineLoad() is handed
 * a null stream, which is the signal that there is nothing to read: the
 * private key is in the device and the only thing this needs from disk is the
 * CERTIFICATE, which is public.
 *
 * WHERE THE CERTIFICATE COMES FROM. apksigner's `--ks-provider-arg` is passed
 * to the PROVIDER's constructor, not to the keystore, so OnlyKeyProvider takes
 * the path and hands it here. Falling back to OKSIGN_CERT keeps the thing
 * usable from a plain `keytool -list` while debugging.
 *
 * THE CERTIFICATE IS NOT DECORATION. apksig verifies every signature it
 * generates against this certificate's public key (see OnlyKeySignature), so a
 * certificate that does not match the key loaded into the device fails the
 * build immediately and by name. That is the check that catches "provisioned
 * the wrong key" before an APK ships rather than after.
 */
public final class OnlyKeyKeyStore extends KeyStoreSpi {

  /**
   * One alias, and apksigner picks it automatically when a keystore has
   * exactly one - so `--ks-key-alias` never has to be passed.
   */
  static final String ALIAS = "onlykey";

  private static final String CERT_ENV = "OKSIGN_CERT";

  /** Set by OnlyKeyProvider's constructor from --ks-provider-arg. */
  private static volatile String certPath;

  private Certificate certificate;
  private final Date created = new Date();

  static void setCertPath(String path) {
    certPath = path;
  }

  @Override
  public void engineLoad(InputStream stream, char[] password)
      throws IOException, NoSuchAlgorithmException, CertificateException {
    /*
     * Both arguments are ignored on purpose. `--ks NONE` gives a null stream,
     * and the password protects nothing because nothing here is secret - but
     * apksigner still PROMPTS for one on stdin unless --ks-pass is given, and
     * a build that prompts is a build that hangs. Hence --ks-pass pass:onlykey
     * in the documented invocation; the value is never looked at.
     */
    String path = certPath != null ? certPath : System.getenv(CERT_ENV);
    if (path == null || path.isEmpty()) {
      throw new IOException(
          "no certificate: pass it as --ks-provider-arg <cert.pem> or set " + CERT_ENV);
    }
    Path file = Paths.get(path);
    if (!Files.isReadable(file)) {
      throw new IOException("cannot read the certificate at " + file.toAbsolutePath());
    }
    try (InputStream in = Files.newInputStream(file)) {
      this.certificate = CertificateFactory.getInstance("X.509").generateCertificate(in);
    }
  }

  @Override
  public Key engineGetKey(String alias, char[] password)
      throws NoSuchAlgorithmException, UnrecoverableKeyException {
    if (!ALIAS.equalsIgnoreCase(alias)) {
      return null;
    }
    return new OnlyKeyPrivateKey(ALIAS);
  }

  @Override
  public Certificate[] engineGetCertificateChain(String alias) {
    if (!ALIAS.equalsIgnoreCase(alias) || certificate == null) {
      return null;
    }
    /*
     * A chain of one. The certificate is self-signed - it is the debug
     * keystore's own - so there is no issuer above it to include.
     */
    return new Certificate[] { certificate };
  }

  @Override
  public Certificate engineGetCertificate(String alias) {
    return ALIAS.equalsIgnoreCase(alias) ? certificate : null;
  }

  @Override
  public Date engineGetCreationDate(String alias) {
    return ALIAS.equalsIgnoreCase(alias) ? new Date(created.getTime()) : null;
  }

  @Override
  public Enumeration<String> engineAliases() {
    return Collections.enumeration(Collections.singletonList(ALIAS));
  }

  @Override
  public boolean engineContainsAlias(String alias) {
    return ALIAS.equalsIgnoreCase(alias);
  }

  @Override
  public int engineSize() {
    return 1;
  }

  @Override
  public boolean engineIsKeyEntry(String alias) {
    return ALIAS.equalsIgnoreCase(alias);
  }

  @Override
  public boolean engineIsCertificateEntry(String alias) {
    return false;
  }

  @Override
  public String engineGetCertificateAlias(Certificate cert) {
    return certificate != null && certificate.equals(cert) ? ALIAS : null;
  }

  /* ---- everything that would change the store ---------------------------
   *
   * Read-only, and loudly so. The contents are a device and a file on disk;
   * there is nothing here that writing to this object could meaningfully
   * change, and silently accepting a write would be worse than refusing it.
   */

  @Override
  public void engineSetKeyEntry(String alias, Key key, char[] password, Certificate[] chain)
      throws KeyStoreException {
    throw new KeyStoreException("the OnlyKey keystore is read-only");
  }

  @Override
  public void engineSetKeyEntry(String alias, byte[] key, Certificate[] chain)
      throws KeyStoreException {
    throw new KeyStoreException("the OnlyKey keystore is read-only");
  }

  @Override
  public void engineSetCertificateEntry(String alias, Certificate cert)
      throws KeyStoreException {
    throw new KeyStoreException("the OnlyKey keystore is read-only");
  }

  @Override
  public void engineDeleteEntry(String alias) throws KeyStoreException {
    throw new KeyStoreException("the OnlyKey keystore is read-only");
  }

  @Override
  public void engineStore(OutputStream stream, char[] password) throws IOException {
    throw new IOException("the OnlyKey keystore cannot be written out");
  }
}
