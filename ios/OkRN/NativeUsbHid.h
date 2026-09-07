//
//  NativeUsbHid.h
//  OkRN
//
//  USB HID bridge for iOS. Mirrors the Android module's dual transport:
//  a TCP socket to tools/hardware-emulator.js for simulator development, and
//  CoreHID for real hardware on device.
//
//  See EXPLAINER/ios-hid.md and EXPLAINER/emulator-testing(ios).md.
//

#import <Foundation/Foundation.h>
#import <AppSpecs/AppSpecs.h>

NS_ASSUME_NONNULL_BEGIN

@interface NativeUsbHid : NSObject <NativeUsbHidSpec>
@end

NS_ASSUME_NONNULL_END
