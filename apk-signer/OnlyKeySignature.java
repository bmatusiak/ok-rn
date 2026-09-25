package com.okrn.signer;

import java.io.IOException;
import java.security.InvalidAlgorithmParameterException;
import java.security.InvalidKeyException;
import java.security.InvalidParameterException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SignatureException;
import java.security.SignatureSpi;
import java.security.spec.AlgorithmParameterSpec;

/**
 * SHA256withRSA, where the RSA half happens on a device.
 *
 * ## How this gets chosen at all
 *
 * apksig asks for a Signature the plain way - `Signature.getInstance(name)`
 * with no provider (ApkSigningBlockUtils, confirmed by javap). That form does
 * DELAYED PROVIDER SELECTION: the JCA does not pick a provider until
 * initSign() sees the key, and it walks the installed providers in order,
 * skipping any whose init throws InvalidKeyException.
 *
 * Security.addProvider() appends, so SunRsaSign is always offered the key
 * first. It cannot build an RSAPrivateKey out of an OnlyKeyPrivateKey - which
 * has no encoding - so it throws, and the search reaches us. That is the whole
 * mechanism, and it is the same one PKCS#11 smartcards rely on.
 *
 * ## Why engineInitVerify throws InvalidKeyException and not something louder
 *
 * apksig VERIFIES EVERY SIGNATURE IT GENERATES, immediately, with
 * Signature.initVerify(cert.getPublicKey()) - fail and it reports "Failed to
 * verify generated ... signature". That verify goes through the same delayed
 * selection, and it must land on SunRsaSign, because the public key is an
 * ordinary RSAPublicKey and we have no way to verify anything.
 *
 * So the throw here has to be the one that means "not my key, keep looking".
 * An UnsupportedOperationException would abort the whole signing run instead,
 * and the failure would look like a broken provider rather than a design that
 * only signs.
 *
 * That self-check is worth having: a signature from the wrong slot, or a
 * certificate that does not match the key inside the device, fails at SIGN
 * time with a clear message instead of at install time with none.
 */
public final class OnlyKeySignature extends SignatureSpi {

  /** RSA-2048. The backend is told nothing about sizes; this is the check. */
  private static final int SIGNATURE_BYTES = 256;

  private final MessageDigest sha256;
  private OnlyKeyPrivateKey key;

  public OnlyKeySignature() {
    try {
      this.sha256 = MessageDigest.getInstance("SHA-256");
    } catch (NoSuchAlgorithmException e) {
      /* SHA-256 is mandatory in every JRE; if it is gone, nothing here works. */
      throw new IllegalStateException("SHA-256 is unavailable", e);
    }
  }

  @Override
  protected void engineInitSign(PrivateKey privateKey) throws InvalidKeyException {
    if (!(privateKey instanceof OnlyKeyPrivateKey)) {
      throw new InvalidKeyException(
          "not an OnlyKey key handle: " + (privateKey == null
              ? "null"
              : privateKey.getClass().getName()));
    }
    this.key = (OnlyKeyPrivateKey) privateKey;
    sha256.reset();
  }

  /** See the class comment: this must be the "keep looking" exception. */
  @Override
  protected void engineInitVerify(PublicKey publicKey) throws InvalidKeyException {
    throw new InvalidKeyException(
        "the OnlyKey provider signs only; let another provider verify");
  }

  @Override
  protected void engineUpdate(byte b) {
    sha256.update(b);
  }

  @Override
  protected void engineUpdate(byte[] b, int off, int len) {
    sha256.update(b, off, len);
  }

  @Override
  protected byte[] engineSign() throws SignatureException {
    if (key == null) {
      throw new SignatureException("not initialised for signing");
    }
    byte[] digest = sha256.digest();
    try {
      byte[] sig = OnlyKeyBackend.get().sign(digest);
      if (sig.length != SIGNATURE_BYTES) {
        /*
         * The backend must ask the device for the whole answer. An RSA-2048
         * signature arrives as four 64-byte reports, and the library's default
         * resolves on the first one - so a 64-byte "signature" here means
         * expectBytes was not passed, not that the device misbehaved.
         */
        throw new SignatureException(
            "expected " + SIGNATURE_BYTES + " signature bytes, got " + sig.length
            + " - the helper probably did not ask for the whole reply");
      }
      return sig;
    } catch (IOException e) {
      throw new SignatureException("the OnlyKey did not sign: " + e.getMessage(), e);
    } finally {
      sha256.reset();
    }
  }

  @Override
  protected boolean engineVerify(byte[] sigBytes) throws SignatureException {
    /* Unreachable: engineInitVerify never lets anyone get here. */
    throw new SignatureException("the OnlyKey provider cannot verify");
  }

  /**
   * PKCS#1 v1.5 takes no parameters, so null is the only acceptable value.
   * Anything else means somebody asked for PSS, which this device does not do
   * and which must not be silently downgraded to v1.5.
   */
  @Override
  protected void engineSetParameter(AlgorithmParameterSpec params)
      throws InvalidAlgorithmParameterException {
    if (params != null) {
      throw new InvalidAlgorithmParameterException(
          "SHA256withRSA on an OnlyKey takes no parameters (got "
          + params.getClass().getName() + ")");
    }
  }

  @Override
  @Deprecated
  protected void engineSetParameter(String param, Object value) {
    throw new InvalidParameterException("deprecated parameter API is not supported");
  }

  @Override
  @Deprecated
  protected Object engineGetParameter(String param) {
    throw new InvalidParameterException("deprecated parameter API is not supported");
  }
}
