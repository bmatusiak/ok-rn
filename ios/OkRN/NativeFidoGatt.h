//
//  NativeFidoGatt.h
//  OkRN
//
//  CTAP2-over-BLE peripheral for iOS, mirroring the Android GATT server.
//  See EXPLAINER/z.md.
//

#import <Foundation/Foundation.h>
#import <CoreBluetooth/CoreBluetooth.h>
#import <AppSpecs/AppSpecs.h>

NS_ASSUME_NONNULL_BEGIN

@interface NativeFidoGatt : NSObject <NativeFidoGattSpec, CBPeripheralManagerDelegate>
@end

NS_ASSUME_NONNULL_END
