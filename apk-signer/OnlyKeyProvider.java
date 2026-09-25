package com.okrn.signer;

import java.security.Provider;
import java.security.Security;

/**
 * The JCA provider apksigner is pointed at, and the one line that makes the
 * whole arrangement work.
 *
 * ## What apksigner does with this
 *
 * Given `--ks-provider-class com.okrn.signer.OnlyKeyProvider`, apksigner's
 * SignerParams constructs it - with `--ks-provider-arg` as the single String
 * argument if one was given - and then calls
 * `KeyStore.getInstance("ONLYKEY", thisProvider)`. That is the only use it
 * makes of the provider object.
 *
 * ## The line that matters: Security.addProvider(this)
 *
 * apksigner does NOT install the provider globally; it only hands it to
 * KeyStore.getInstance. But the signing code deeper in apksig asks for
 * `Signature.getInstance("SHA256withRSA")` with no provider at all, and that
 * lookup can only find providers that are installed. So the provider installs
 * itself here, in its own constructor, at the moment apksigner builds it -
 * which is before any signature is requested.
 *
 * addProvider APPENDS, and that ordering is load-bearing rather than
 * incidental: SunRsaSign stays ahead of us and is offered the key first, so
 * ordinary RSA keys keep working exactly as before and only a key it rejects
 * reaches us. See OnlyKeySignature for the other half.
 *
 * ## Why the keystore type is not "PKCS12" or anything familiar
 *
 * `--ks-type ONLYKEY` has to name something no other installed provider
 * offers, or the wrong KeyStoreSpi could answer. "ONLYKEY" is unambiguous and
 * it reads correctly in the command line, which is where anyone debugging
 * this will first see it.
 */
public final class OnlyKeyProvider extends Provider {

  private static final long serialVersionUID = 1L;

  private static final String NAME = "OnlyKey";
  private static final String VERSION = "1.0";
  private static final String INFO =
      "OnlyKey device-backed signer (KeyStore.ONLYKEY, Signature.SHA256withRSA)";

  /** Used when apksigner is given no --ks-provider-arg; reads OKSIGN_CERT. */
  public OnlyKeyProvider() {
    this(null);
  }

  /**
   * @param certPath apksigner's --ks-provider-arg: the PEM certificate whose
   *                 public key matches the key inside the device. May be null,
   *                 in which case OnlyKeyKeyStore falls back to OKSIGN_CERT.
   */
  public OnlyKeyProvider(String certPath) {
    super(NAME, VERSION, INFO);

    if (certPath != null && !certPath.isEmpty()) {
      OnlyKeyKeyStore.setCertPath(certPath);
    }

    put("KeyStore.ONLYKEY", OnlyKeyKeyStore.class.getName());
    put("Signature.SHA256withRSA", OnlyKeySignature.class.getName());

    /*
     * Last, so the provider is fully populated before anything can look
     * inside it. Harmless to call twice: addProvider is a no-op for a name
     * that is already installed.
     */
    Security.addProvider(this);
  }
}
