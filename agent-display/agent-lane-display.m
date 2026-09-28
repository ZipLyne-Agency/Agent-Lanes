// agent-lane-display: keeps an invisible virtual display alive so the
// authenticated Chrome agent lanes live somewhere the user never sees them.
//
// macOS exposes no public API for this. CoreGraphics' CGVirtualDisplay is
// private but stable (BetterDisplay and DeskPad are built on it). The display
// exists only while this process runs; launchd keeps the process alive. If it
// exits, macOS moves the lane windows onto a real display (the old visible
// behaviour) and the Chrome extension moves them back when the display returns.
//
//   agent-lane-display run      hold the display (launchd runs this)
//   agent-lane-display status   print JSON; exit 0 when the display is online
//
// The display touches the physical arrangement only at one corner, and a
// cursor fence warps the pointer back if it ever slips through that corner.

#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/file.h>
#include <unistd.h>

// Private CoreGraphics interfaces, declared from the runtime's own property and
// method list on macOS 27. Classes are resolved with NSClassFromString so the
// binary never links against private class symbols.
@interface CGVirtualDisplayDescriptor : NSObject
@property(retain, nonatomic) dispatch_queue_t queue;
@property(retain, nonatomic) NSString *name;
@property(nonatomic) unsigned int maxPixelsWide;
@property(nonatomic) unsigned int maxPixelsHigh;
@property(nonatomic) CGSize sizeInMillimeters;
@property(nonatomic) unsigned int productID;
@property(nonatomic) unsigned int vendorID;
@property(nonatomic) unsigned int serialNum;
@property(copy, nonatomic) void (^terminationHandler)(id, id);
@end

@interface CGVirtualDisplayMode : NSObject
- (instancetype)initWithWidth:(unsigned int)width height:(unsigned int)height refreshRate:(double)refreshRate;
@end

@interface CGVirtualDisplaySettings : NSObject
@property(retain, nonatomic) NSArray *modes;
@property(nonatomic) unsigned int hiDPI;
@end

@interface CGVirtualDisplay : NSObject
@property(readonly, nonatomic) CGDirectDisplayID displayID;
- (instancetype)initWithDescriptor:(CGVirtualDisplayDescriptor *)descriptor;
- (BOOL)applySettings:(CGVirtualDisplaySettings *)settings;
@end

// Identity the status command looks for: vendor "AL", model "NE" (Agent LaNE).
// Chrome reports no display names on macOS, so the extension recognises this
// display by its size plus its corner-only position instead; keep kWidth and
// kHeight in step with AGENT_DISPLAY_WIDTH/HEIGHT in agentDisplay.ts.
static NSString *const kDisplayName = @"Agent Lanes";
static const unsigned int kVendorID = 0x414C;
static const unsigned int kProductID = 0x4E45;
static const unsigned int kSerial = 1;
static const unsigned int kWidth = 1440;
static const unsigned int kHeight = 900;

static CGVirtualDisplay *gDisplay;
static CGDirectDisplayID gDisplayID = kCGNullDirectDisplay;
// A target macOS refused once is not retried until the arrangement around it
// changes, so a refusal can never turn into a loop of screen reconfigurations.
static CGPoint gRefusedTarget = {NAN, NAN};

static NSString *StateDirectory(void) {
  return [NSHomeDirectory() stringByAppendingPathComponent:@".local/state/agent-lanes/display"];
}

static void Log(NSString *format, ...) NS_FORMAT_FUNCTION(1, 2);
static void Log(NSString *format, ...) {
  va_list args;
  va_start(args, format);
  NSString *message = [[NSString alloc] initWithFormat:format arguments:args];
  va_end(args);
  fprintf(stderr, "%s agent-lane-display: %s\n",
          [[[NSDate date] description] UTF8String], [message UTF8String]);
}

static BOOL IsAgentDisplay(CGDirectDisplayID display) {
  return CGDisplayVendorNumber(display) == kVendorID && CGDisplayModelNumber(display) == kProductID;
}

static CGDirectDisplayID FindAgentDisplay(void) {
  CGDirectDisplayID ids[32];
  uint32_t count = 0;
  if (CGGetOnlineDisplayList(32, ids, &count) != kCGErrorSuccess)
    return kCGNullDirectDisplay;
  for (uint32_t i = 0; i < count; i++) {
    if (IsAgentDisplay(ids[i]))
      return ids[i];
  }
  return kCGNullDirectDisplay;
}

// The physical display whose bottom-right corner is furthest right (then
// lowest). The agent display is placed diagonally off that corner.
static BOOL AnchorBounds(CGDirectDisplayID agent, CGRect *anchorOut, CGRect *unionOut) {
  CGDirectDisplayID ids[32];
  uint32_t count = 0;
  if (CGGetOnlineDisplayList(32, ids, &count) != kCGErrorSuccess)
    return NO;
  BOOL found = NO;
  CGRect anchor = CGRectNull;
  CGRect all = CGRectNull;
  for (uint32_t i = 0; i < count; i++) {
    if (ids[i] == agent || IsAgentDisplay(ids[i]) || CGDisplayMirrorsDisplay(ids[i]) != kCGNullDirectDisplay)
      continue;
    CGRect bounds = CGDisplayBounds(ids[i]);
    all = CGRectUnion(all, bounds);
    if (!found || CGRectGetMaxX(bounds) > CGRectGetMaxX(anchor) ||
        (CGRectGetMaxX(bounds) == CGRectGetMaxX(anchor) && CGRectGetMaxY(bounds) > CGRectGetMaxY(anchor))) {
      anchor = bounds;
      found = YES;
    }
  }
  if (found) {
    if (anchorOut)
      *anchorOut = anchor;
    if (unionOut)
      *unionOut = all;
  }
  return found;
}

static void WriteState(void) {
  NSString *directory = StateDirectory();
  [[NSFileManager defaultManager] createDirectoryAtPath:directory
                            withIntermediateDirectories:YES
                                             attributes:@{NSFilePosixPermissions: @0700}
                                                  error:nil];
  CGRect bounds = CGDisplayBounds(gDisplayID);
  NSDictionary *state = @{
    @"pid": @(getpid()),
    @"displayID": @(gDisplayID),
    @"name": kDisplayName,
    @"bounds": @{@"x": @(bounds.origin.x), @"y": @(bounds.origin.y),
                 @"width": @(bounds.size.width), @"height": @(bounds.size.height)},
  };
  NSData *data = [NSJSONSerialization dataWithJSONObject:state options:NSJSONWritingSortedKeys error:nil];
  [data writeToFile:[directory stringByAppendingPathComponent:@"state.json"] atomically:YES];
}

// Keeps the agent display diagonally off the anchor corner. Runs at start and
// after every reconfiguration, because plugging or unplugging a monitor makes
// macOS re-pack the arrangement.
static void PositionDisplay(void) {
  if (gDisplayID == kCGNullDirectDisplay)
    return;
  CGRect anchor;
  if (!AnchorBounds(gDisplayID, &anchor, NULL))
    return;
  CGPoint target = CGPointMake(CGRectGetMaxX(anchor), CGRectGetMaxY(anchor));
  CGRect current = CGDisplayBounds(gDisplayID);
  if ((current.origin.x == target.x && current.origin.y == target.y) ||
      (target.x == gRefusedTarget.x && target.y == gRefusedTarget.y)) {
    WriteState();
    return;
  }
  CGDisplayConfigRef config = NULL;
  if (CGBeginDisplayConfiguration(&config) != kCGErrorSuccess)
    return;
  CGConfigureDisplayOrigin(config, gDisplayID, (int32_t)target.x, (int32_t)target.y);
  CGError error = CGCompleteDisplayConfiguration(config, kCGConfigureForSession);
  CGRect placed = CGDisplayBounds(gDisplayID);
  if (placed.origin.x != target.x || placed.origin.y != target.y)
    gRefusedTarget = target;
  Log(@"positioned at %@ (wanted %@, error %d)",
      NSStringFromRect(NSRectFromCGRect(placed)), NSStringFromPoint(NSPointFromCGPoint(target)), error);
  WriteState();
}

static void ScheduleReposition(void) {
  static BOOL pending = NO;
  if (pending)
    return;
  pending = YES;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    pending = NO;
    PositionDisplay();
  });
}

static void ReconfigurationCallback(CGDirectDisplayID display, CGDisplayChangeSummaryFlags flags, void *context) {
  if (flags & kCGDisplayBeginConfigurationFlag)
    return;
  ScheduleReposition();
}

// The pointer can only reach the agent display through one corner point. If it
// ever does, put it back on the nearest physical display.
static void FenceCursor(void) {
  if (gDisplayID == kCGNullDirectDisplay)
    return;
  CGEventRef event = CGEventCreate(NULL);
  if (!event)
    return;
  CGPoint location = CGEventGetLocation(event);
  CFRelease(event);
  CGRect agentBounds = CGDisplayBounds(gDisplayID);
  if (!CGRectContainsPoint(agentBounds, location))
    return;
  CGRect anchor;
  if (!AnchorBounds(gDisplayID, &anchor, NULL))
    return;
  CGPoint target = CGPointMake(MIN(MAX(location.x, CGRectGetMinX(anchor)), CGRectGetMaxX(anchor) - 2),
                               MIN(MAX(location.y, CGRectGetMinY(anchor)), CGRectGetMaxY(anchor) - 2));
  CGWarpMouseCursorPosition(target);
  CGAssociateMouseAndMouseCursorPosition(true);
}

// True when no physical display shares more than a single point with the
// agent display, so the pointer can reach it only through a corner.
static BOOL TouchesOnlyAtCorner(CGDirectDisplayID agent) {
  CGDirectDisplayID ids[32];
  uint32_t count = 0;
  if (CGGetOnlineDisplayList(32, ids, &count) != kCGErrorSuccess)
    return NO;
  CGRect grown = CGRectInset(CGDisplayBounds(agent), -1, -1);
  for (uint32_t i = 0; i < count; i++) {
    if (ids[i] == agent || CGDisplayMirrorsDisplay(ids[i]) != kCGNullDirectDisplay)
      continue;
    CGRect contact = CGRectIntersection(grown, CGDisplayBounds(ids[i]));
    if (!CGRectIsNull(contact) && (CGRectGetWidth(contact) > 1 || CGRectGetHeight(contact) > 1))
      return NO;
  }
  return YES;
}

static int Status(void) {
  CGDirectDisplayID display = FindAgentDisplay();
  NSMutableDictionary *result = [@{@"present": @(display != kCGNullDirectDisplay), @"name": kDisplayName} mutableCopy];
  if (display != kCGNullDirectDisplay) {
    CGRect bounds = CGDisplayBounds(display);
    result[@"displayID"] = @(display);
    result[@"mirrored"] = @(CGDisplayIsInMirrorSet(display) != 0);
    result[@"bounds"] = @{@"x": @(bounds.origin.x), @"y": @(bounds.origin.y),
                          @"width": @(bounds.size.width), @"height": @(bounds.size.height)};
    result[@"cornerContactOnly"] = @(TouchesOnlyAtCorner(display));
  }
  NSData *data = [NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingSortedKeys error:nil];
  printf("%s\n", [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] UTF8String]);
  return display != kCGNullDirectDisplay ? 0 : 1;
}

static int Run(void) {
  NSString *directory = StateDirectory();
  [[NSFileManager defaultManager] createDirectoryAtPath:directory
                            withIntermediateDirectories:YES
                                             attributes:@{NSFilePosixPermissions: @0700}
                                                  error:nil];
  // One holder per login session. A second copy exits cleanly so launchd's
  // SuccessfulExit=false does not respawn it in a loop.
  int lock = open([[directory stringByAppendingPathComponent:@"lock"] fileSystemRepresentation], O_CREAT | O_RDWR, 0600);
  if (lock < 0 || flock(lock, LOCK_EX | LOCK_NB) != 0) {
    Log(@"another agent-lane-display holds the display; exiting");
    return 0;
  }

  Class descriptorClass = NSClassFromString(@"CGVirtualDisplayDescriptor");
  Class displayClass = NSClassFromString(@"CGVirtualDisplay");
  Class settingsClass = NSClassFromString(@"CGVirtualDisplaySettings");
  Class modeClass = NSClassFromString(@"CGVirtualDisplayMode");
  if (!descriptorClass || !displayClass || !settingsClass || !modeClass) {
    // Permanent for this macOS build, so exit cleanly and let launchd leave
    // it stopped instead of retrying forever.
    Log(@"CGVirtualDisplay is unavailable on this macOS; lanes stay on the physical displays");
    return 0;
  }

  CGVirtualDisplayDescriptor *descriptor = [[descriptorClass alloc] init];
  descriptor.queue = dispatch_get_main_queue();
  descriptor.name = kDisplayName;
  descriptor.maxPixelsWide = kWidth;
  descriptor.maxPixelsHigh = kHeight;
  descriptor.sizeInMillimeters = CGSizeMake(381, 238);
  descriptor.vendorID = kVendorID;
  descriptor.productID = kProductID;
  descriptor.serialNum = kSerial;
  descriptor.terminationHandler = ^(id display, id reason) {
    Log(@"WindowServer terminated the virtual display (%@); exiting for launchd to restart", reason);
    exit(3);
  };

  gDisplay = [[displayClass alloc] initWithDescriptor:descriptor];
  if (!gDisplay) {
    Log(@"could not create the virtual display");
    return 2;
  }
  CGVirtualDisplaySettings *settings = [[settingsClass alloc] init];
  settings.hiDPI = 0;
  settings.modes = @[[[modeClass alloc] initWithWidth:kWidth height:kHeight refreshRate:60]];
  if (![gDisplay applySettings:settings]) {
    Log(@"could not apply the virtual display mode");
    return 2;
  }
  gDisplayID = gDisplay.displayID;
  Log(@"created display %u", gDisplayID);

  CGDisplayRegisterReconfigurationCallback(ReconfigurationCallback, NULL);
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    PositionDisplay();
  });

  dispatch_source_t fence = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
  dispatch_source_set_timer(fence, DISPATCH_TIME_NOW, 50 * NSEC_PER_MSEC, 10 * NSEC_PER_MSEC);
  dispatch_source_set_event_handler(fence, ^{ FenceCursor(); });
  dispatch_resume(fence);

  // Release the display on a normal stop so macOS removes it at once.
  const int stopSignals[] = {SIGINT, SIGTERM, SIGHUP};
  for (size_t index = 0; index < sizeof(stopSignals) / sizeof(stopSignals[0]); index++) {
    const int signalNumber = stopSignals[index];
    signal(signalNumber, SIG_IGN);
    dispatch_source_t source = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, (uintptr_t)signalNumber, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(source, ^{
      Log(@"stopping on signal %d", signalNumber);
      gDisplay = nil;
      [[NSFileManager defaultManager] removeItemAtPath:[StateDirectory() stringByAppendingPathComponent:@"state.json"] error:nil];
      exit(0);
    });
    dispatch_resume(source);
  }

  CFRunLoopRun();
  return 0;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSString *command = argc > 1 ? [NSString stringWithUTF8String:argv[1]] : @"";
    if ([command isEqualToString:@"run"])
      return Run();
    if ([command isEqualToString:@"status"])
      return Status();
    fprintf(stderr, "usage: agent-lane-display run|status\n");
    return 64;
  }
}
