// agent-lane-display: keeps an invisible virtual display alive so the
// authenticated Chrome agent lanes live somewhere the user never sees them.
//
// macOS exposes no public API for this. CoreGraphics' CGVirtualDisplay is
// private but stable (BetterDisplay and DeskPad are built on it). The display
// exists only while this process runs; launchd keeps the process alive. If it
// exits, macOS moves the lane windows onto a real display (the old visible
// behaviour) and the Chrome extension moves them back when the display returns.
//
//   agent-lane-display run         hold the display (launchd runs this)
//   agent-lane-display status      print JSON; exit 0 when the display is online
//   agent-lane-display guard-once  move strays off the display once, with the
//                                  calling process's Accessibility permission
//
// The display touches the physical arrangement only at one corner, and a
// cursor fence warps the pointer back if it ever slips through that corner.
// A window guard moves any other app's window that lands on the display back
// to the screen the pointer is on, and a focus guard never lets a hidden lane
// keep the keyboard (which would make macOS open everything on this display).
// Both need the Accessibility permission, the only general way to move or
// focus another app's window; Chrome's own windows are left to the extension,
// which knows which of them are lanes.

#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
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

// Private but long-stable (window managers such as yabai and Hammerspoon rely
// on it): the CGWindowID behind an Accessibility window element.
extern AXError _AXUIElementGetWindow(AXUIElementRef element, CGWindowID *identifier);

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
// The running helper's own Accessibility state, recorded in state.json. A
// status check run from a terminal would report the terminal's permission.
static NSString *gGuardState = @"starting";

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
    @"windowGuard": gGuardState,
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

// Apps whose windows the guard never moves: Chrome (the extension places its
// windows and knows which are lanes) and the system AutoFill panel, which
// opens beside a login field in an agent's page and belongs with it.
static BOOL IsGuardExempt(NSString *bundleID) {
  if (!bundleID)
    return NO;
  return [bundleID isEqualToString:@"com.google.Chrome"] || [bundleID hasPrefix:@"com.google.Chrome."] ||
         [bundleID isEqualToString:@"com.apple.SafariPlatformSupport.Helper"];
}

// Where a stray window goes: the real display the pointer is on (the cursor
// fence keeps it off the agent display), else the main display. Inset so the
// window clears the menu bar and the Dock.
static CGRect GuardTargetArea(void) {
  CGDirectDisplayID target = CGMainDisplayID();
  CGEventRef event = CGEventCreate(NULL);
  if (event) {
    CGPoint location = CGEventGetLocation(event);
    CFRelease(event);
    CGDirectDisplayID underPointer = kCGNullDirectDisplay;
    uint32_t count = 0;
    if (CGGetDisplaysWithPoint(location, 1, &underPointer, &count) == kCGErrorSuccess && count == 1 &&
        underPointer != gDisplayID && !IsAgentDisplay(underPointer))
      target = underPointer;
  }
  CGRect bounds = CGDisplayBounds(target);
  return CGRectMake(bounds.origin.x + 20, bounds.origin.y + 60, bounds.size.width - 40, bounds.size.height - 150);
}

// Moves one window of another app off the agent display, without focusing or
// activating anything. Returns YES when the window was found and moved.
static BOOL MoveWindowOffAgentDisplay(pid_t pid, CGWindowID windowID, CGRect frame) {
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  if (!app)
    return NO;
  AXUIElementSetMessagingTimeout(app, 1.0);
  CFArrayRef windows = NULL;
  BOOL moved = NO;
  AXError listError = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, (CFTypeRef *)&windows);
  if (getenv("AGENT_LANE_DISPLAY_DEBUG"))
    Log(@"pid %d: AX windows error %d, count %ld, looking for %u", pid, listError,
        windows ? (long)CFArrayGetCount(windows) : -1L, windowID);
  if (listError == kAXErrorSuccess && windows) {
    for (CFIndex index = 0; index < CFArrayGetCount(windows) && !moved; index++) {
      AXUIElementRef window = (AXUIElementRef)CFArrayGetValueAtIndex(windows, index);
      CGWindowID candidate = 0;
      if (_AXUIElementGetWindow(window, &candidate) != kAXErrorSuccess || candidate != windowID)
        continue;
      CGRect area = GuardTargetArea();
      CGSize size = CGSizeMake(MIN(frame.size.width, area.size.width), MIN(frame.size.height, area.size.height));
      CGPoint origin = CGPointMake(area.origin.x + (area.size.width - size.width) / 2,
                                   area.origin.y + (area.size.height - size.height) / 2);
      if (!CGSizeEqualToSize(size, frame.size)) {
        AXValueRef sizeValue = AXValueCreate(kAXValueCGSizeType, &size);
        AXUIElementSetAttributeValue(window, kAXSizeAttribute, sizeValue);
        CFRelease(sizeValue);
      }
      AXValueRef originValue = AXValueCreate(kAXValueCGPointType, &origin);
      moved = AXUIElementSetAttributeValue(window, kAXPositionAttribute, originValue) == kAXErrorSuccess;
      CFRelease(originValue);
      if (moved)
        Log(@"moved window %u of pid %d from %@ to %@", windowID, pid,
            NSStringFromPoint(NSPointFromCGPoint(frame.origin)), NSStringFromPoint(NSPointFromCGPoint(origin)));
    }
    CFRelease(windows);
  }
  CFRelease(app);
  return moved;
}

// Once a second: any ordinary window of another app whose middle sits on the
// agent display goes back to a real screen. A window an app keeps putting back
// is left alone after three moves in a minute, so the guard never fights.
static void SetGuardState(NSString *state) {
  if ([gGuardState isEqualToString:state])
    return;
  dispatch_async(dispatch_get_main_queue(), ^{
    gGuardState = state;
    WriteState();
  });
}

static NSUInteger GuardWindows(void) {
  static NSMutableDictionary<NSNumber *, NSMutableArray<NSDate *> *> *history;
  static NSMutableDictionary<NSNumber *, NSDate *> *unmatchedUntil;
  static NSMutableSet<NSNumber *> *givenUp;
  static BOOL loggedUntrusted = NO;
  if (!history) {
    history = [NSMutableDictionary dictionary];
    unmatchedUntil = [NSMutableDictionary dictionary];
    givenUp = [NSMutableSet set];
  }
  if (gDisplayID == kCGNullDirectDisplay)
    return 0;
  if (!AXIsProcessTrusted()) {
    if (!loggedUntrusted)
      Log(@"window guard is off: grant Accessibility to %s in System Settings, Privacy & Security", getprogname());
    loggedUntrusted = YES;
    SetGuardState(@"needs-accessibility");
    return 0;
  }
  if (loggedUntrusted)
    Log(@"window guard is on");
  loggedUntrusted = NO;
  SetGuardState(@"active");
  CGRect agent = CGDisplayBounds(gDisplayID);
  CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionAll | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
  if (!list)
    return 0;
  NSDate *now = [NSDate date];
  NSUInteger movedCount = 0;
  for (NSDictionary *info in (__bridge NSArray *)list) {
    NSInteger layer = [info[(id)kCGWindowLayer] integerValue];
    pid_t pid = [info[(id)kCGWindowOwnerPID] intValue];
    NSNumber *windowNumber = info[(id)kCGWindowNumber];
    CGRect frame;
    if (layer < 0 || layer > 20 || pid == getpid() || !windowNumber ||
        !CGRectMakeWithDictionaryRepresentation((CFDictionaryRef)info[(id)kCGWindowBounds], &frame) ||
        frame.size.width < 60 || frame.size.height < 40 ||
        !CGRectContainsPoint(agent, CGPointMake(CGRectGetMidX(frame), CGRectGetMidY(frame))) ||
        [givenUp containsObject:windowNumber] || [unmatchedUntil[windowNumber] timeIntervalSinceDate:now] > 0)
      continue;
    NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    if (getenv("AGENT_LANE_DISPLAY_DEBUG"))
      Log(@"candidate window %@ pid %d layer %ld app %@ policy %ld", windowNumber, pid, (long)layer, app.bundleIdentifier,
          app ? (long)app.activationPolicy : -1L);
    if (app && (app.activationPolicy == NSApplicationActivationPolicyProhibited || IsGuardExempt(app.bundleIdentifier)))
      continue;
    NSMutableArray<NSDate *> *moves = history[windowNumber] ?: [NSMutableArray array];
    [moves filterUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(NSDate *when, NSDictionary *bindings) {
      return [now timeIntervalSinceDate:when] < 60;
    }]];
    if (moves.count >= 3) {
      [givenUp addObject:windowNumber];
      Log(@"%@ keeps putting window %@ back on the agent display; leaving it", app.bundleIdentifier, windowNumber);
      continue;
    }
    if (MoveWindowOffAgentDisplay(pid, (CGWindowID)windowNumber.unsignedIntValue, frame)) {
      [moves addObject:now];
      history[windowNumber] = moves;
      movedCount++;
    } else {
      // Not one of the app's Accessibility windows: usually a hidden one the
      // app keeps parked there (ChatGPT's launcher panel did) and will show
      // again in place. Look again in a few seconds rather than every second.
      unmatchedUntil[windowNumber] = [now dateByAddingTimeInterval:3];
    }
  }
  CFRelease(list);
  return movedCount;
}

static BOOL RaiseWindow(pid_t pid, CGWindowID windowID) {
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  if (!app)
    return NO;
  AXUIElementSetMessagingTimeout(app, 1.0);
  CFArrayRef windows = NULL;
  BOOL raised = NO;
  if (AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, (CFTypeRef *)&windows) == kAXErrorSuccess && windows) {
    for (CFIndex index = 0; index < CFArrayGetCount(windows) && !raised; index++) {
      AXUIElementRef window = (AXUIElementRef)CFArrayGetValueAtIndex(windows, index);
      CGWindowID candidate = 0;
      if (_AXUIElementGetWindow(window, &candidate) != kAXErrorSuccess || candidate != windowID)
        continue;
      AXUIElementSetAttributeValue(window, kAXMainAttribute, kCFBooleanTrue);
      raised = AXUIElementPerformAction(window, kAXRaiseAction) == kAXErrorSuccess;
    }
    CFRelease(windows);
  }
  CFRelease(app);
  return raised;
}

// The CGWindowID of the window that has the keyboard in this app, or 0.
static CGWindowID FocusedWindowID(pid_t pid) {
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  if (!app)
    return 0;
  AXUIElementSetMessagingTimeout(app, 0.5);
  CFTypeRef window = NULL;
  CGWindowID windowID = 0;
  if (AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute, &window) == kAXErrorSuccess && window) {
    if (_AXUIElementGetWindow((AXUIElementRef)window, &windowID) != kAXErrorSuccess)
      windowID = 0;
    CFRelease(window);
  }
  CFRelease(app);
  return windowID;
}

static BOOL WindowFrame(CGWindowID windowID, CGRect *frame) {
  CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, windowID);
  BOOL found = NO;
  if (list && CFArrayGetCount(list) > 0) {
    NSDictionary *info = ((__bridge NSArray *)list)[0];
    found = CGRectMakeWithDictionaryRepresentation((CFDictionaryRef)info[(id)kCGWindowBounds], frame);
  }
  if (list)
    CFRelease(list);
  return found;
}

// A hidden lane must never hold the keyboard. While it does, macOS treats the
// agent display as the main screen, so every app opens new windows, dialogs
// and launcher panels there. macOS gives a lane the keyboard when the user
// switches to a desktop holding a lane but none of their Chrome windows while
// Chrome is active, and through Cmd-`. Every 250 ms while Chrome is frontmost
// the guard asks Chrome which window has the keyboard (the window-level
// Accessibility query window managers use; z-order cannot tell, because lanes
// can sit above the key window). After a lane has held it for about a second
// (the extension's own hand-back gets the first chance), focus goes to the
// user's full-size Chrome window on the current desktop, or else to Finder,
// whose desktop is on every Space, so no desktop switch ever happens.
static void GuardFocus(void) {
  static int ticks = 0;
  static NSDate *lastAction;
  if (gDisplayID == kCGNullDirectDisplay || !AXIsProcessTrusted())
    return;
  __block NSRunningApplication *front = nil;
  dispatch_sync(dispatch_get_main_queue(), ^{
    front = NSWorkspace.sharedWorkspace.frontmostApplication;
  });
  if (![front.bundleIdentifier isEqualToString:@"com.google.Chrome"]) {
    ticks = 0;
    return;
  }
  pid_t chrome = front.processIdentifier;
  CGRect agent = CGDisplayBounds(gDisplayID);
  CGWindowID focused = FocusedWindowID(chrome);
  CGRect focusedFrame;
  if (!focused || !WindowFrame(focused, &focusedFrame) ||
      !CGRectContainsPoint(agent, CGPointMake(CGRectGetMidX(focusedFrame), CGRectGetMidY(focusedFrame)))) {
    ticks = 0;
    return;
  }
  NSDate *now = [NSDate date];
  if (++ticks < 4 || (lastAction && [now timeIntervalSinceDate:lastAction] < 2))
    return;
  ticks = 0;
  lastAction = now;
  CFArrayRef visible = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
  CGWindowID userWindow = 0;
  if (visible) {
    for (NSDictionary *info in (__bridge NSArray *)visible) {
      CGRect frame;
      // Browser windows only: Chrome's bubbles and bars are short strips.
      if ([info[(id)kCGWindowOwnerPID] intValue] != chrome || [info[(id)kCGWindowLayer] integerValue] != 0 ||
          !CGRectMakeWithDictionaryRepresentation((CFDictionaryRef)info[(id)kCGWindowBounds], &frame) ||
          frame.size.width < 400 || frame.size.height < 300 ||
          CGRectContainsPoint(agent, CGPointMake(CGRectGetMidX(frame), CGRectGetMidY(frame))))
        continue;
      userWindow = (CGWindowID)[info[(id)kCGWindowNumber] unsignedIntValue];
      break;
    }
    CFRelease(visible);
  }
  if (userWindow && RaiseWindow(chrome, userWindow)) {
    Log(@"hidden lane %u had the keyboard; focused Chrome window %u on this desktop", focused, userWindow);
    return;
  }
  NSRunningApplication *finder = [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.apple.finder"].firstObject;
  if (!finder)
    return;
  AXUIElementRef finderElement = AXUIElementCreateApplication(finder.processIdentifier);
  AXError error = AXUIElementSetAttributeValue(finderElement, kAXFrontmostAttribute, kCFBooleanTrue);
  CFRelease(finderElement);
  Log(@"hidden lane %u had the keyboard and no Chrome window of the user's is on this desktop; activated Finder (error %d)",
      focused, error);
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
  // The running helper's own state, from state.json: run from a terminal,
  // AXIsProcessTrusted would report the terminal's permission instead.
  NSData *stateData = [NSData dataWithContentsOfFile:[StateDirectory() stringByAppendingPathComponent:@"state.json"]];
  NSDictionary *state = stateData ? [NSJSONSerialization JSONObjectWithData:stateData options:0 error:nil] : nil;
  result[@"windowGuard"] = [state isKindOfClass:[NSDictionary class]] && [state[@"windowGuard"] isKindOfClass:[NSString class]]
      ? state[@"windowGuard"] : @"unknown";
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

  // Ask for Accessibility once per installed binary; the installer clears the
  // marker when it installs a new one. macOS shows its own prompt with a
  // button to System Settings.
  NSString *promptMarker = [StateDirectory() stringByAppendingPathComponent:@"accessibility-prompted"];
  if (!AXIsProcessTrusted() && ![[NSFileManager defaultManager] fileExistsAtPath:promptMarker]) {
    AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)@{(__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES});
    [[NSFileManager defaultManager] createFileAtPath:promptMarker contents:nil attributes:nil];
  }
  // Its own queue: an unresponsive app can hold an Accessibility call for up to
  // its one-second timeout, which must never delay the cursor fence.
  dispatch_queue_t guardQueue = dispatch_queue_create("agent-lane-display.guard", DISPATCH_QUEUE_SERIAL);
  dispatch_source_t guard = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, guardQueue);
  dispatch_source_set_timer(guard, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2 * NSEC_PER_SEC)), 1 * NSEC_PER_SEC, 100 * NSEC_PER_MSEC);
  dispatch_source_set_event_handler(guard, ^{
    @autoreleasepool {
      GuardWindows();
    }
  });
  dispatch_resume(guard);
  dispatch_source_t focusGuard = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, guardQueue);
  dispatch_source_set_timer(focusGuard, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2 * NSEC_PER_SEC)), 250 * NSEC_PER_MSEC, 50 * NSEC_PER_MSEC);
  dispatch_source_set_event_handler(focusGuard, ^{
    @autoreleasepool {
      GuardFocus();
    }
  });
  dispatch_resume(focusGuard);

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
    if ([command isEqualToString:@"guard-once"]) {
      // One guard pass against the running display, with the caller's own
      // Accessibility permission. For tests and for clearing strays by hand.
      gDisplayID = FindAgentDisplay();
      if (gDisplayID == kCGNullDirectDisplay) {
        fprintf(stderr, "agent-lane-display: the agent display is not online\n");
        return 1;
      }
      if (!AXIsProcessTrusted()) {
        fprintf(stderr, "agent-lane-display: this process has no Accessibility permission\n");
        return 1;
      }
      printf("{\"moved\":%lu}\n", (unsigned long)GuardWindows());
      return 0;
    }
    if ([command isEqualToString:@"guard-watch"] && argc > 2) {
      // Both guards for N seconds against the running display, with the
      // caller's own Accessibility permission. For live tests.
      gDisplayID = FindAgentDisplay();
      if (gDisplayID == kCGNullDirectDisplay || !AXIsProcessTrusted()) {
        fprintf(stderr, "agent-lane-display: needs the agent display online and Accessibility\n");
        return 1;
      }
      dispatch_queue_t queue = dispatch_queue_create("agent-lane-display.guard-watch", DISPATCH_QUEUE_SERIAL);
      dispatch_source_t focusTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, queue);
      dispatch_source_set_timer(focusTimer, DISPATCH_TIME_NOW, 250 * NSEC_PER_MSEC, 50 * NSEC_PER_MSEC);
      dispatch_source_set_event_handler(focusTimer, ^{ @autoreleasepool { GuardFocus(); } });
      dispatch_resume(focusTimer);
      dispatch_source_t windowTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, queue);
      dispatch_source_set_timer(windowTimer, DISPATCH_TIME_NOW, 1 * NSEC_PER_SEC, 100 * NSEC_PER_MSEC);
      dispatch_source_set_event_handler(windowTimer, ^{ @autoreleasepool { GuardWindows(); } });
      dispatch_resume(windowTimer);
      CFRunLoopRunInMode(kCFRunLoopDefaultMode, atof(argv[2]), false);
      return 0;
    }
    fprintf(stderr, "usage: agent-lane-display run|status|guard-once|guard-watch <seconds>\n");
    return 64;
  }
}
