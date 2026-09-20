package com.okrn.signer;

import java.security.PrivateKey;

/**
 * A handle to a key the JVM will never hold.
 *
 * This is the whole point of the provider: apksigner's signing code is written
 * against java.security.PrivateKey, so it needs an object of that type - but
 * the actual key lives in an OnlyKey's flash and cannot be extracted. So this
 * carries a slot alias and nothing else, and the signing happens in
 * OnlyKeySignature by asking the device.
 *
 * getEncoded() returns null and getFormat() returns null, which is the
 * documented way for a PrivateKey to say "I am not extractable". That is also
 * what makes the delayed-provider-selection trick work: SunRsaSign is offered
 * this key first and cannot make an RSAPrivateKey out of it, so it throws
 * InvalidKeyException and the search moves on to us. See OnlyKeySignature.
 */
public final class OnlyKeyPrivateKey implements PrivateKey {

  private static final long serialVersionUID = 1L;

  private final String alias;

  public OnlyKeyPrivateKey(String alias) {
    this.alias = alias;
  }

  public String alias() {
    return alias;
  }

  @Override
  public String getAlgorithm() {
    /*
     * "RSA" rather than anything more specific, because this is what apksig
     * reads to decide which signature algorithms the signer supports. Saying
     * anything else here makes it reject the key before a signature is ever
     * requested.
     */
    return "RSA";
  }

  /** Not extractable, so there is no encoding and no format to name. */
  @Override
  public String getFormat() {
    return null;
  }

  @Override
  public byte[] getEncoded() {
    return null;
  }

  @Override
  public String toString() {
    return "OnlyKeyPrivateKey[" + alias + "]";
  }
}
