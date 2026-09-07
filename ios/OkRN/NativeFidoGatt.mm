//
//  NativeFidoGatt.mm
//  OkRN
//

#import "NativeFidoGatt.h"

#import <LocalAuthentication/LocalAuthentication.h>
#import <Security/Security.h>

/**
 * FIDO Bluetooth Service and its four mandatory characteristics
 * (CTAP 2.1, section 11.2).
 */
static NSString *const kFidoServiceUUID = @"FFFD";
static NSString *const kFidoControlPointUUID = @"F1D0FFF1-DEAA-ECEE-B42F-C9BA7ED623BB";
static NSString *const kFidoStatusUUID = @"F1D0FFF2-DEAA-ECEE-B42F-C9BA7ED623BB";
static NSString *const kFidoControlPointLengthUUID = @"F1D0FFF3-DEAA-ECEE-B42F-C9BA7ED623BB";
static NSString *const kFidoServiceRevisionUUID = @"F1D0FFF4-DEAA-ECEE-B42F-C9BA7ED623BB";

static NSString *const kStateIdle = @"idle";
static NSString *const kStateAdvertising = @"advertising";
static NSString *const kStateConnected = @"connected";
static NSString *const kStateStopped = @"stopped";
static NSString *const kStateError = @"error";

static const NSInteger kDefaultMtu = 23;
static const NSInteger kAttHeaderBytes = 3;
static const NSInteger kMinFragment = 20;

#pragma mark - CTAP BLE fragmentation

/**
 * Reassembles Control Point writes into whole CTAP messages.
 * Mirrors CtapBleAssembler on the Android side.
 */
@interface OKCtapAssembler : NSObject
@property(nonatomic, assign) NSInteger command;
- (nullable NSData *)push:(NSData *)fragment outCommand:(NSInteger *)outCommand;
- (void)reset;
@end

@implementation OKCtapAssembler {
  NSMutableData *_buffer;
  NSInteger _expected;
  NSInteger _nextSeq;
  BOOL _inProgress;
}

- (instancetype)init {
  if (self = [super init]) {
    _buffer = [NSMutableData data];
    [self reset];
  }
  return self;
}

- (void)reset {
  _inProgress = NO;
  _expected = 0;
  _nextSeq = 0;
  [_buffer setLength:0];
}

- (nullable NSData *)push:(NSData *)fragment outCommand:(NSInteger *)outCommand {
  if (fragment.length == 0) {
    return nil;
  }
  const uint8_t *bytes = (const uint8_t *)fragment.bytes;
  uint8_t head = bytes[0];

  if (head & 0x80) {
    if (fragment.length < 3) {
      return nil;
    }
    _command = head & 0x7f;
    _expected = (bytes[1] << 8) | bytes[2];
    _nextSeq = 0;
    _inProgress = YES;
    [_buffer setLength:0];
    [_buffer appendBytes:bytes + 3 length:fragment.length - 3];
  } else {
    // A continuation with no initialisation fragment, or one out of sequence,
    // cannot be spliced in safely - drop the whole message.
    if (!_inProgress || head != _nextSeq) {
      [self reset];
      return nil;
    }
    _nextSeq += 1;
    [_buffer appendBytes:bytes + 1 length:fragment.length - 1];
  }

  if (_inProgress && (NSInteger)_buffer.length >= _expected) {
    NSData *payload = [_buffer subdataWithRange:NSMakeRange(0, (NSUInteger)_expected)];
    if (outCommand) {
      *outCommand = _command;
    }
    [self reset];
    return payload;
  }
  return nil;
}

@end

#pragma mark - Module

@implementation NativeFidoGatt {
  CBPeripheralManager *_peripheral;
  CBMutableCharacteristic *_statusCharacteristic;
  CBCentral *_subscribedCentral;
  OKCtapAssembler *_assembler;

  NSMutableDictionary<NSString *, NSNumber *> *_pendingRequests;
  NSInteger _requestCounter;

  NSString *_state;
  NSInteger _mtu;
  NSDictionary *_config;

  RCTPromiseResolveBlock _startResolve;
  RCTPromiseRejectBlock _startReject;
}

RCT_EXPORT_MODULE()

- (instancetype)init {
  if (self = [super init]) {
    _assembler = [[OKCtapAssembler alloc] init];
    _pendingRequests = [NSMutableDictionary dictionary];
    _requestCounter = 0;
    _state = kStateIdle;
    _mtu = kDefaultMtu;
    _config = @{
      @"displayName" : @"OnlyKey Mobile",
      @"aaguid" : @"00000000000000000000000000000000",
      @"requireUserVerification" : @YES,
      @"preferStrongBox" : @YES,
    };
  }
  return self;
}

- (void)invalidate {
  [self stopEverything];
}

#pragma mark - Hex helpers

static NSString *OKHexFromData(NSData *data) {
  static const char *digits = "0123456789abcdef";
  const uint8_t *bytes = (const uint8_t *)data.bytes;
  NSMutableString *out = [NSMutableString stringWithCapacity:data.length * 2];
  for (NSUInteger i = 0; i < data.length; i++) {
    [out appendFormat:@"%c%c", digits[bytes[i] >> 4], digits[bytes[i] & 0x0f]];
  }
  return out;
}

static NSData *_Nullable OKDataFromHex(NSString *hex) {
  if (hex.length % 2 != 0) {
    return nil;
  }
  NSMutableData *data = [NSMutableData dataWithLength:hex.length / 2];
  uint8_t *bytes = (uint8_t *)data.mutableBytes;
  const char *chars = hex.UTF8String;
  for (NSUInteger i = 0; i < hex.length / 2; i++) {
    int hi = 0, lo = 0;
    if (sscanf(&chars[i * 2], "%1x%1x", &hi, &lo) != 2) {
      return nil;
    }
    bytes[i] = (uint8_t)((hi << 4) | lo);
  }
  return data;
}

#pragma mark - Capability

- (void)isSupported:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  // CBPeripheralManager exists on every supported iOS device; the Secure
  // Enclave gates the key material.
  BOOL hasSecureEnclave = NO;
  LAContext *context = [[LAContext alloc] init];
  NSError *error = nil;
  hasSecureEnclave = [context canEvaluatePolicy:LAPolicyDeviceOwnerAuthenticationWithBiometrics
                                          error:&error];
  resolve(@(hasSecureEnclave));
}

- (void)requestPermissions:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  // iOS asks for Bluetooth consent the first time CBPeripheralManager is used,
  // driven by NSBluetoothAlwaysUsageDescription in Info.plist. There is no
  // separate request call, so report the current authorisation instead.
  if (@available(iOS 13.1, *)) {
    CBManagerAuthorization auth = [CBPeripheralManager authorization];
    resolve(@(auth == CBManagerAuthorizationAllowedAlways ||
              auth == CBManagerAuthorizationNotDetermined));
  } else {
    resolve(@YES);
  }
}

- (void)configure:(JS::NativeFidoGatt::AuthenticatorConfig &)config {
  NSMutableDictionary *next = [_config mutableCopy];
  next[@"displayName"] = config.displayName();
  next[@"aaguid"] = config.aaguid();
  next[@"requireUserVerification"] = @(config.requireUserVerification());
  next[@"preferStrongBox"] = @(config.preferStrongBox());
  _config = next;
}

- (NSString *)getState {
  return _state;
}

#pragma mark - Advertising

- (void)startAdvertising:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  [self stopEverything];
  _startResolve = resolve;
  _startReject = reject;
  // The service is registered and advertising starts once the manager reports
  // CBManagerStatePoweredOn in the delegate callback below.
  _peripheral = [[CBPeripheralManager alloc] initWithDelegate:self queue:dispatch_get_main_queue()];
}

- (void)stopAdvertising:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  [self stopEverything];
  [self setState:kStateStopped message:@"stopped by app"];
  resolve(nil);
}

- (void)stopEverything {
  if (_peripheral) {
    [_peripheral stopAdvertising];
    [_peripheral removeAllServices];
    _peripheral = nil;
  }
  _statusCharacteristic = nil;
  _subscribedCentral = nil;
  [_assembler reset];
  [_pendingRequests removeAllObjects];
  _mtu = kDefaultMtu;
}

- (NSInteger)maxFragmentSize {
  NSInteger size = _mtu - kAttHeaderBytes;
  return size < kMinFragment ? kMinFragment : size;
}

- (CBMutableService *)buildFidoService {
  CBMutableCharacteristic *controlPoint = [[CBMutableCharacteristic alloc]
      initWithType:[CBUUID UUIDWithString:kFidoControlPointUUID]
        properties:CBCharacteristicPropertyWrite
             value:nil
       permissions:CBAttributePermissionsWriteable];

  CBMutableCharacteristic *status = [[CBMutableCharacteristic alloc]
      initWithType:[CBUUID UUIDWithString:kFidoStatusUUID]
        properties:CBCharacteristicPropertyNotify
             value:nil
       permissions:CBAttributePermissionsReadable];
  _statusCharacteristic = status;

  NSInteger fragment = [self maxFragmentSize];
  uint8_t lengthBytes[2] = {(uint8_t)((fragment >> 8) & 0xff), (uint8_t)(fragment & 0xff)};
  CBMutableCharacteristic *controlPointLength = [[CBMutableCharacteristic alloc]
      initWithType:[CBUUID UUIDWithString:kFidoControlPointLengthUUID]
        properties:CBCharacteristicPropertyRead
             value:[NSData dataWithBytes:lengthBytes length:2]
       permissions:CBAttributePermissionsReadable];

  // Bit 5 set = FIDO2 / CTAP2 supported.
  uint8_t revision = 0x20;
  CBMutableCharacteristic *serviceRevision = [[CBMutableCharacteristic alloc]
      initWithType:[CBUUID UUIDWithString:kFidoServiceRevisionUUID]
        properties:CBCharacteristicPropertyRead
             value:[NSData dataWithBytes:&revision length:1]
       permissions:CBAttributePermissionsReadable];

  CBMutableService *service =
      [[CBMutableService alloc] initWithType:[CBUUID UUIDWithString:kFidoServiceUUID] primary:YES];
  service.characteristics = @[ controlPoint, status, controlPointLength, serviceRevision ];
  return service;
}

#pragma mark - CBPeripheralManagerDelegate

- (void)peripheralManagerDidUpdateState:(CBPeripheralManager *)peripheral {
  if (peripheral.state != CBManagerStatePoweredOn) {
    NSString *message = [NSString stringWithFormat:@"Bluetooth unavailable (state %ld)",
                                                   (long)peripheral.state];
    [self setState:kStateError message:message];
    if (_startReject) {
      _startReject(@"ERR_BLE_UNSUPPORTED", message, nil);
      _startResolve = nil;
      _startReject = nil;
    }
    return;
  }
  [peripheral addService:[self buildFidoService]];
}

- (void)peripheralManager:(CBPeripheralManager *)peripheral
            didAddService:(CBService *)service
                    error:(NSError *)error {
  if (error) {
    [self setState:kStateError message:error.localizedDescription];
    if (_startReject) {
      _startReject(@"ERR_BLE_ADVERTISE", error.localizedDescription, error);
      _startResolve = nil;
      _startReject = nil;
    }
    return;
  }
  [peripheral startAdvertising:@{
    CBAdvertisementDataServiceUUIDsKey : @[ [CBUUID UUIDWithString:kFidoServiceUUID] ],
    CBAdvertisementDataLocalNameKey : _config[@"displayName"] ?: @"OnlyKey Mobile",
  }];
}

- (void)peripheralManagerDidStartAdvertising:(CBPeripheralManager *)peripheral
                                       error:(NSError *)error {
  if (error) {
    [self setState:kStateError message:error.localizedDescription];
    if (_startReject) {
      _startReject(@"ERR_BLE_ADVERTISE", error.localizedDescription, error);
    }
  } else {
    [self setState:kStateAdvertising message:@"service 0xFFFD"];
    if (_startResolve) {
      _startResolve(nil);
    }
  }
  _startResolve = nil;
  _startReject = nil;
}

- (void)peripheralManager:(CBPeripheralManager *)peripheral
                          central:(CBCentral *)central
    didSubscribeToCharacteristic:(CBCharacteristic *)characteristic {
  _subscribedCentral = central;
  // maximumUpdateValueLength is the usable notification payload, which is
  // already MTU minus the ATT header.
  _mtu = (NSInteger)central.maximumUpdateValueLength + kAttHeaderBytes;
  [self setState:kStateConnected message:@"central subscribed"];
}

- (void)peripheralManager:(CBPeripheralManager *)peripheral
                              central:(CBCentral *)central
    didUnsubscribeFromCharacteristic:(CBCharacteristic *)characteristic {
  _subscribedCentral = nil;
  [_assembler reset];
  [self setState:kStateAdvertising message:@"central unsubscribed"];
}

- (void)peripheralManager:(CBPeripheralManager *)peripheral
    didReceiveWriteRequests:(NSArray<CBATTRequest *> *)requests {
  for (CBATTRequest *request in requests) {
    if (![request.characteristic.UUID
            isEqual:[CBUUID UUIDWithString:kFidoControlPointUUID]]) {
      continue;
    }
    NSInteger command = 0;
    NSData *payload = [_assembler push:request.value outCommand:&command];
    if (payload == nil) {
      continue;
    }

    _requestCounter += 1;
    NSString *requestId = [NSString stringWithFormat:@"req-%ld", (long)_requestCounter];
    _pendingRequests[requestId] = @(command);

    const uint8_t *bytes = (const uint8_t *)payload.bytes;
    NSInteger ctap2Command = payload.length > 0 ? bytes[0] : -1;

    [self emitOnCtapRequest:@{
      @"requestId" : requestId,
      @"command" : @(command),
      @"commandName" : OKCtap2CommandName(ctap2Command),
      @"hex" : OKHexFromData(payload),
      // Extracting rpId needs a CBOR decoder, which is not wired up yet.
      @"rpId" : @"",
    }];
  }
  [peripheral respondToRequest:requests.firstObject withResult:CBATTErrorSuccess];
}

static NSString *OKCtap2CommandName(NSInteger command) {
  switch (command) {
    case 0x01: return @"authenticatorMakeCredential";
    case 0x02: return @"authenticatorGetAssertion";
    case 0x04: return @"authenticatorGetInfo";
    case 0x06: return @"authenticatorClientPIN";
    case 0x07: return @"authenticatorReset";
    case 0x08: return @"authenticatorGetNextAssertion";
    default: return @"";
  }
}

#pragma mark - Respond

- (void)respondToRequest:(NSString *)requestId
                     hex:(NSString *)hex
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject {
  NSNumber *command = _pendingRequests[requestId];
  if (command == nil) {
    reject(@"ERR_CTAP_RESPOND", @"Unknown or already-answered requestId", nil);
    return;
  }
  [_pendingRequests removeObjectForKey:requestId];

  if (_statusCharacteristic == nil || _peripheral == nil) {
    reject(@"ERR_CTAP_RESPOND", @"GATT server is not running", nil);
    return;
  }

  NSData *payload = OKDataFromHex(hex);
  if (payload == nil) {
    reject(@"ERR_CTAP_RESPOND", @"Invalid hex payload", nil);
    return;
  }

  NSInteger maxFragment = [self maxFragmentSize];
  const uint8_t *bytes = (const uint8_t *)payload.bytes;
  NSUInteger offset = 0;

  // Initialisation fragment: [CMD | 0x80][HLEN][LLEN][data ...]
  NSUInteger firstChunk = MIN((NSUInteger)(maxFragment - 3), payload.length);
  NSMutableData *init = [NSMutableData dataWithCapacity:3 + firstChunk];
  uint8_t header[3] = {(uint8_t)(command.integerValue | 0x80),
                       (uint8_t)((payload.length >> 8) & 0xff),
                       (uint8_t)(payload.length & 0xff)};
  [init appendBytes:header length:3];
  [init appendBytes:bytes length:firstChunk];
  [_peripheral updateValue:init
         forCharacteristic:_statusCharacteristic
      onSubscribedCentrals:nil];
  offset = firstChunk;

  // Continuation fragments: [SEQ][data ...]
  uint8_t seq = 0;
  while (offset < payload.length) {
    NSUInteger chunk = MIN((NSUInteger)(maxFragment - 1), payload.length - offset);
    NSMutableData *cont = [NSMutableData dataWithCapacity:1 + chunk];
    [cont appendBytes:&seq length:1];
    [cont appendBytes:bytes + offset length:chunk];
    [_peripheral updateValue:cont
           forCharacteristic:_statusCharacteristic
        onSubscribedCentrals:nil];
    offset += chunk;
    seq += 1;
  }

  resolve(nil);
}

#pragma mark - Key material

/**
 * Generates a P-256 key inside the Secure Enclave, gated on biometrics. The
 * private key never leaves the enclave; only a keychain reference to it does.
 */
- (void)createCredential:(NSString *)rpId
           userHandleHex:(NSString *)userHandleHex
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject {
  NSString *alias = [NSString stringWithFormat:@"okrn-cred-%@-%@", rpId,
                                               [userHandleHex substringToIndex:MIN(32u, (unsigned)userHandleHex.length)]];
  NSData *tag = [alias dataUsingEncoding:NSUTF8StringEncoding];

  CFErrorRef error = NULL;
  SecAccessControlCreateFlags flags = kSecAccessControlPrivateKeyUsage;
  if ([_config[@"requireUserVerification"] boolValue]) {
    flags |= kSecAccessControlBiometryCurrentSet;
  }
  SecAccessControlRef access = SecAccessControlCreateWithFlags(
      kCFAllocatorDefault, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, flags, &error);
  if (access == NULL) {
    NSError *err = CFBridgingRelease(error);
    reject(@"ERR_KEYSTORE", err.localizedDescription ?: @"SecAccessControl failed", err);
    return;
  }

  NSDictionary *attributes = @{
    (id)kSecAttrKeyType : (id)kSecAttrKeyTypeECSECPrimeRandom,
    (id)kSecAttrKeySizeInBits : @256,
    (id)kSecAttrTokenID : (id)kSecAttrTokenIDSecureEnclave,
    (id)kSecPrivateKeyAttrs : @{
      (id)kSecAttrIsPermanent : @YES,
      (id)kSecAttrApplicationTag : tag,
      (id)kSecAttrAccessControl : (__bridge id)access,
    },
  };

  SecKeyRef privateKey = SecKeyCreateRandomKey((__bridge CFDictionaryRef)attributes, &error);
  CFRelease(access);
  if (privateKey == NULL) {
    NSError *err = CFBridgingRelease(error);
    reject(@"ERR_KEYSTORE", err.localizedDescription ?: @"SecKeyCreateRandomKey failed", err);
    return;
  }
  CFRelease(privateKey);

  resolve(OKHexFromData(tag));
}

- (void)signWithCredential:(NSString *)credentialIdHex
                payloadHex:(NSString *)payloadHex
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject {
  NSData *tag = OKDataFromHex(credentialIdHex);
  NSData *payload = OKDataFromHex(payloadHex);
  if (tag == nil || payload == nil) {
    reject(@"ERR_KEYSTORE", @"Invalid hex argument", nil);
    return;
  }

  NSDictionary *query = @{
    (id)kSecClass : (id)kSecClassKey,
    (id)kSecAttrKeyType : (id)kSecAttrKeyTypeECSECPrimeRandom,
    (id)kSecAttrApplicationTag : tag,
    (id)kSecReturnRef : @YES,
  };

  SecKeyRef privateKey = NULL;
  OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, (CFTypeRef *)&privateKey);
  if (status != errSecSuccess || privateKey == NULL) {
    reject(@"ERR_KEYSTORE",
           [NSString stringWithFormat:@"No credential key for that id (OSStatus %d)", (int)status],
           nil);
    return;
  }

  // Signing triggers the biometric prompt configured by the access control
  // flags above; the user gesture happens inside the Secure Enclave call.
  CFErrorRef error = NULL;
  CFDataRef signature = SecKeyCreateSignature(
      privateKey, kSecKeyAlgorithmECDSASignatureMessageX962SHA256,
      (__bridge CFDataRef)payload, &error);
  CFRelease(privateKey);

  if (signature == NULL) {
    NSError *err = CFBridgingRelease(error);
    reject(@"ERR_KEYSTORE", err.localizedDescription ?: @"SecKeyCreateSignature failed", err);
    return;
  }

  NSData *result = CFBridgingRelease(signature);
  resolve(OKHexFromData(result));
}

#pragma mark - Events

- (void)setState:(NSString *)state message:(NSString *)message {
  _state = state;
  [self emitOnGattStatus:@{
    @"state" : state,
    @"message" : message ?: @"",
    @"mtu" : @(_mtu),
  }];
}

#pragma mark - TurboModule

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeFidoGattSpecJSI>(params);
}

@end
