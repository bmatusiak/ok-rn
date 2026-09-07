package com.okrn

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.okrn.specs.NativeFidoGattSpec
import com.okrn.specs.NativeUsbHidSpec
import com.okrn.fido.NativeFidoGattModule
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
      else -> null
    }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    mapOf(
      NativeUsbHidSpec.NAME to moduleInfo(NativeUsbHidSpec.NAME),
      NativeFidoGattSpec.NAME to moduleInfo(NativeFidoGattSpec.NAME),
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
