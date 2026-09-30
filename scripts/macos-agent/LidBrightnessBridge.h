#ifndef MULTICC_LID_BRIGHTNESS_BRIDGE_H
#define MULTICC_LID_BRIGHTNESS_BRIDGE_H
#include <stdint.h>

typedef struct {
  uint64_t identifier;
  float brightness;
  float backlightLevel;
  int suppressed;
} MCKeyboardBrightness;

// Returns zero only when the private API is present and all readings are valid.
int MCKeyboardRead(MCKeyboardBrightness *result);
int MCKeyboardSet(uint64_t identifier, float brightness, MCKeyboardBrightness *result);

#endif
