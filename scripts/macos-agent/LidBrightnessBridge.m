#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#import <dlfcn.h>
#import <math.h>
#import "LidBrightnessBridge.h"

// CoreBrightness is private. Check its actual runtime shape before calling any
// primitive-argument selectors; an unrecognized or changed ABI must fail shut.
@interface NSObject (MCCKeyboardBrightness)
- (NSArray *)copyKeyboardBacklightIDs;
- (BOOL)isKeyboardBuiltIn:(uint64_t)identifier;
- (float)brightnessForKeyboard:(uint64_t)identifier;
- (float)backlightLevelForKeyboard:(uint64_t)identifier;
- (BOOL)isBacklightSuppressedOnKeyboard:(uint64_t)identifier;
- (BOOL)setBrightness:(float)value forKeyboard:(uint64_t)identifier;
@end

static BOOL mcType(Method method, unsigned index, const char *expected) {
  char *actual = method_copyArgumentType(method, index);
  BOOL ok = actual && strchr(expected, actual[0]) != NULL;
  free(actual);
  return ok;
}

static BOOL mcMethod(Class cls, SEL selector, unsigned arguments, const char *result,
                     const char *first, const char *second) {
  Method method = class_getInstanceMethod(cls, selector);
  if (!method || method_getNumberOfArguments(method) != arguments) return NO;
  char *actual = method_copyReturnType(method);
  BOOL ok = actual && strchr(result, actual[0]) != NULL;
  free(actual);
  if (first) ok = ok && mcType(method, 2, first);
  if (second) ok = ok && mcType(method, 3, second);
  return ok;
}

static id mcClient(void) {
  static void *framework;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    framework = dlopen("/System/Library/PrivateFrameworks/CoreBrightness.framework/CoreBrightness", RTLD_NOW);
  });
  if (!framework) return nil;
  Class cls = NSClassFromString(@"KeyboardBrightnessClient");
  if (!cls ||
      !mcMethod(cls, @selector(copyKeyboardBacklightIDs), 2, "@", NULL, NULL) ||
      !mcMethod(cls, @selector(isKeyboardBuiltIn:), 3, "cB", "qQ", NULL) ||
      !mcMethod(cls, @selector(brightnessForKeyboard:), 3, "f", "qQ", NULL) ||
      !mcMethod(cls, @selector(backlightLevelForKeyboard:), 3, "f", "qQ", NULL) ||
      !mcMethod(cls, @selector(isBacklightSuppressedOnKeyboard:), 3, "cB", "qQ", NULL) ||
      !mcMethod(cls, @selector(setBrightness:forKeyboard:), 4, "cB", "f", "qQ")) return nil;
  return [[cls alloc] init];
}

static int mcRead(id client, NSNumber *identifier, MCKeyboardBrightness *result) {
  if (!result || !identifier) return -1;
  uint64_t key = identifier.unsignedLongLongValue;
  float brightness = [client brightnessForKeyboard:key];
  float level = [client backlightLevelForKeyboard:key];
  if (!isfinite(brightness) || brightness < 0 || brightness > 1 ||
      !isfinite(level) || level < 0) return -2;
  *result = (MCKeyboardBrightness){ key, brightness, level,
    [client isBacklightSuppressedOnKeyboard:key] ? 1 : 0 };
  return 0;
}

int MCKeyboardRead(MCKeyboardBrightness *result) {
  @autoreleasepool { @try {
    id client = mcClient();
    if (!client) return -1;
    NSArray *identifiers = [client copyKeyboardBacklightIDs];
    if (![identifiers isKindOfClass:[NSArray class]]) return -1;
    for (id value in identifiers) {
      if (![value isKindOfClass:[NSNumber class]]) continue;
      NSNumber *number = value;
      if ([client isKeyboardBuiltIn:number.unsignedLongLongValue]) return mcRead(client, number, result);
    }
    return -1;
  } @catch (NSException *exception) { return -1; } }
}

int MCKeyboardSet(uint64_t identifier, float brightness, MCKeyboardBrightness *result) {
  @autoreleasepool { @try {
    if (!isfinite(brightness) || brightness < 0 || brightness > 1) return -1;
    id client = mcClient();
    if (!client) return -1;
    NSArray *identifiers = [client copyKeyboardBacklightIDs];
    if (![identifiers isKindOfClass:[NSArray class]]) return -1;
    for (id value in identifiers) {
      if (![value isKindOfClass:[NSNumber class]]) continue;
      NSNumber *number = value;
      if (number.unsignedLongLongValue == identifier && [client isKeyboardBuiltIn:identifier]) {
        if (![client setBrightness:brightness forKeyboard:identifier]) return -2;
        return mcRead(client, number, result);
      }
    }
    return -1;
  } @catch (NSException *exception) { return -1; } }
}
