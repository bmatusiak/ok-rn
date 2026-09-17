package com.okrn

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.okrn.specs.NativeBtKeyboardSpec
import com.okrn.specs.NativeCredProviderSpec
import com.okrn.specs.NativeFidoGattSpec
import com.okrn.specs.NativeOkEmuSpec
import com.okrn.specs.NativeSecretsSpec
import com.okrn.specs.NativeShareSpec
import com.okrn.specs.NativeUsbHidSpec
import com.okrn.btkbd.NativeBtKeyboardModule
// EXPERIMENT - see REMOVAL.md
import com.okrn.credprovider.NativeCredProviderModule
import com.okrn.emu.NativeOkEmuModule
import com.okrn.fido.NativeFidoGattModule
import com.okrn.secrets.NativeSecretsModule
import com.okrn.share.NativeShareModule
import com.okrn.usb.NativeUsbHidModule

/**
 * Registers the app's TurboModules.
 *
 * BaseReactPackage builds modules lazily by name, so neither native module is
 * constructed (and neither broadcast receiver registered) until JS first calls
 * into it.
 */
class OkRnPackage : BaseReactPackage() {

  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
    when (name) {
      NativeUsbHidSpec.NAME -> NativeUsbHidModule(reactContext)
      NativeFidoGattSpec.NAME -> NativeFidoGattModule(reactContext)
      NativeOkEmuSpec.NAME -> NativeOkEmuModule(reactContext)
      NativeSecretsSpec.NAME -> NativeSecretsModule(reactContext)
      NativeShareSpec.NAME -> NativeShareModule(reactContext)
      NativeBtKeyboardSpec.NAME -> NativeBtKeyboardModule(reactContext)
      NativeCredProviderSpec.NAME -> NativeCredProviderModule(reactContext)
      else -> null
    }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    mapOf(
      NativeUsbHidSpec.NAME to moduleInfo(NativeUsbHidSpec.NAME),
      NativeFidoGattSpec.NAME to moduleInfo(NativeFidoGattSpec.NAME),
      NativeOkEmuSpec.NAME to moduleInfo(NativeOkEmuSpec.NAME),
      NativeSecretsSpec.NAME to moduleInfo(NativeSecretsSpec.NAME),
      NativeShareSpec.NAME to moduleInfo(NativeShareSpec.NAME),
      NativeBtKeyboardSpec.NAME to moduleInfo(NativeBtKeyboardSpec.NAME),
      NativeCredProviderSpec.NAME to moduleInfo(NativeCredProviderSpec.NAME),
    )
  }

  private fun moduleInfo(name: String) = ReactModuleInfo(
    /* name = */ name,
    /* className = */ name,
    /* canOverrideExistingModule = */ false,
    /* needsEagerInit = */ false,
    /* isCxxModule = */ false,
    /* isTurboModule = */ true,
  )
}
