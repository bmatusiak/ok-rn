//
//  NativeUsbHid.mm
//  OkRN
//

#import "NativeUsbHid.h"

#import <netdb.h>
#import <netinet/in.h>
#import <netinet/tcp.h>
#import <sys/socket.h>
#import <unistd.h>

/**
 * Transport modes, matching the Android module's strings so the JS layer is
 * platform-agnostic.
 */
static NSString *const kModeAuto = @"auto";
static NSString *const kModeUsb = @"usb";
static NSString *const kModeTcp = @"tcp";

/**
 * The iOS Simulator reaches the host machine on plain loopback, unlike the
 * Android emulator's 10.0.2.2 alias (EXPLAINER/!.md section 3).
 */
static NSString *const kDefaultTcpHost = @"127.0.0.1";
static const NSInteger kDefaultTcpPort = 9000;
static const NSInteger kDefaultReportSize = 64;

@implementation NativeUsbHid {
  NSString *_transportMode;
  NSString *_tcpHost;
  NSInteger _tcpPort;
  NSInteger _packetSize;

  int _socketFd;
  dispatch_queue_t _queue;
  dispatch_source_t _readSource;
  BOOL _connected;
}

RCT_EXPORT_MODULE()

- (instancetype)init {
  if (self = [super init]) {
    _transportMode = kModeAuto;
    _tcpHost = kDefaultTcpHost;
    _tcpPort = kDefaultTcpPort;
    _packetSize = kDefaultReportSize;
    _socketFd = -1;
    _connected = NO;
    _queue = dispatch_queue_create("com.okrn.usbhid", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

- (void)invalidate {
  [self closeSocket];
}

#pragma mark - Hex helpers

static NSString *HexFromBytes(const uint8_t *bytes, NSUInteger length) {
  static const char *digits = "0123456789abcdef";
  NSMutableString *out = [NSMutableString stringWithCapacity:length * 2];
  for (NSUInteger i = 0; i < length; i++) {
    [out appendFormat:@"%c%c", digits[bytes[i] >> 4], digits[bytes[i] & 0x0f]];
  }
  return out;
}

static NSData *_Nullable BytesFromHex(NSString *hex) {
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

#pragma mark - Transport selection

/**
 * 'auto' resolves to the TCP mock in the Simulator, which cannot route real USB
 * HID endpoints, and to CoreHID on a physical device.
 */
- (NSString *)resolvedMode {
  if (![_transportMode isEqualToString:kModeAuto]) {
    return _transportMode;
  }
#if TARGET_OS_SIMULATOR
  return kModeTcp;
#else
  return kModeUsb;
#endif
}

- (void)setTransport:(NSString *)transport {
  if ([transport isEqualToString:kModeUsb] || [transport isEqualToString:kModeTcp]) {
    _transportMode = transport;
  } else {
    _transportMode = kModeAuto;
  }
}

- (NSString *)getTransport {
  return _transportMode;
}

- (void)configureTcp:(NSString *)host port:(double)port {
  _tcpHost = host;
  _tcpPort = (NSInteger)port;
}

#pragma mark - Queries

- (void)listDevices:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  // CoreHID enumeration is Swift-only; see the note on connect: below.
  resolve(@[]);
}

- (NSNumber *)isConnected {
  return @(_connected);
}

- (void)requestPermission:(double)vendorId
                productId:(double)productId
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject {
  // iOS has no per-device USB consent dialog equivalent to Android's; access is
  // governed by entitlements on the app, granted at install time.
  resolve(@YES);
}

#pragma mark - Connection

- (void)connect:(double)vendorId
      productId:(double)productId
        resolve:(RCTPromiseResolveBlock)resolve
         reject:(RCTPromiseRejectBlock)reject {
  NSString *mode = [self resolvedMode];

  if ([mode isEqualToString:kModeUsb]) {
    // CoreHID (iOS 16+) has no Objective-C interface - HIDDeviceManager and
    // HIDDeviceClient are Swift-only types. Implementing this path means adding
    // a Swift file to the target and bridging it here, plus the com.apple.
    // developer.hid.virtual.device entitlement on the provisioning profile.
    // EXPLAINER/ios-hid.md has the Swift shape; EXPLAINER/!.md section 4 has
    // the entitlement and deployment-target constraints.
    reject(@"ERR_NOT_IMPLEMENTED",
           @"CoreHID transport is not implemented yet. Use the TCP transport in "
           @"the Simulator, or add the Swift CoreHID client described in "
           @"EXPLAINER/ios-hid.md.",
           nil);
    return;
  }

  dispatch_async(_queue, ^{
    [self closeSocket];
    [self emitStatus:@"connecting" transport:kModeTcp message:[NSString stringWithFormat:@"%@:%ld", self->_tcpHost, (long)self->_tcpPort]];

    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
      [self emitStatus:@"error" transport:kModeTcp message:@"socket() failed"];
      reject(@"ERR_CONNECT", @"socket() failed", nil);
      return;
    }

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((uint16_t)self->_tcpPort);

    struct hostent *host = gethostbyname(self->_tcpHost.UTF8String);
    if (host == NULL || host->h_addr_list[0] == NULL) {
      close(fd);
      [self emitStatus:@"error" transport:kModeTcp message:@"host lookup failed"];
      reject(@"ERR_CONNECT", @"Could not resolve mock server host", nil);
      return;
    }
    memcpy(&addr.sin_addr, host->h_addr_list[0], (size_t)host->h_length);

    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
      close(fd);
      [self emitStatus:@"error" transport:kModeTcp message:@"connect() failed"];
      reject(@"ERR_CONNECT", @"Could not reach the mock server", nil);
      return;
    }

    int one = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));

    self->_socketFd = fd;
    self->_connected = YES;
    self->_packetSize = kDefaultReportSize;
    [self startReadLoop];

    [self emitStatus:@"connected" transport:kModeTcp message:@"mock server"];
    resolve(@{
      @"transport" : kModeTcp,
      @"vendorId" : @(vendorId),
      @"productId" : @(productId),
      @"packetSize" : @(self->_packetSize),
    });
  });
}

- (void)startReadLoop {
  _readSource = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, (uintptr_t)_socketFd, 0, _queue);

  __weak __typeof(self) weakSelf = self;
  dispatch_source_set_event_handler(_readSource, ^{
    __strong __typeof(weakSelf) self = weakSelf;
    if (!self || self->_socketFd < 0) {
      return;
    }
    uint8_t buffer[512];
    ssize_t got = recv(self->_socketFd, buffer, sizeof(buffer), 0);
    if (got > 0) {
      [self emitData:buffer length:(NSUInteger)got];
    } else if (got == 0) {
      [self emitStatus:@"disconnected" transport:kModeTcp message:@"mock server closed the connection"];
      [self closeSocket];
    }
  });

  dispatch_resume(_readSource);
}

- (void)disconnect:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(_queue, ^{
    [self closeSocket];
    [self emitStatus:@"disconnected" transport:[self resolvedMode] message:@"closed by app"];
    resolve(nil);
  });
}

- (void)closeSocket {
  if (_readSource) {
    dispatch_source_cancel(_readSource);
    _readSource = nil;
  }
  if (_socketFd >= 0) {
    close(_socketFd);
    _socketFd = -1;
  }
  _connected = NO;
}

#pragma mark - Write

- (void)write:(NSString *)hex
      resolve:(RCTPromiseResolveBlock)resolve
       reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(_queue, ^{
    if (!self->_connected || self->_socketFd < 0) {
      reject(@"ERR_NOT_CONNECTED", @"No open transport", nil);
      return;
    }
    NSData *data = BytesFromHex(hex);
    if (data == nil) {
      reject(@"ERR_WRITE_FAILED", @"Invalid hex payload", nil);
      return;
    }
    ssize_t written = send(self->_socketFd, data.bytes, data.length, 0);
    if (written < 0) {
      reject(@"ERR_WRITE_FAILED", @"send() failed", nil);
    } else {
      resolve(@(written));
    }
  });
}

#pragma mark - Events

- (void)emitStatus:(NSString *)state transport:(NSString *)transport message:(NSString *)message {
  [self emitOnStatus:@{@"state" : state, @"transport" : transport, @"message" : message ?: @""}];
}

- (void)emitData:(const uint8_t *)bytes length:(NSUInteger)length {
  [self emitOnData:@{@"hex" : HexFromBytes(bytes, length), @"length" : @(length)}];
}

#pragma mark - TurboModule

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeUsbHidSpecJSI>(params);
}

@end
