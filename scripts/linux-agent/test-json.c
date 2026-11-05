/* Protocol regression tests also run on macOS without an X server. */
#include "agent.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static void invalid(const char *text) {
  jobject o; char error[128];
  assert(!json_parse(text, strlen(text), &o, error, sizeof(error)));
  json_free(&o);
}
int main(void) {
  jobject o; char error[128];
  const char *request = "{\"op\":\"click\",\"mods\":[\"ctrl\",\"shift\",\"ctrl\",\"unknown\"],\"x\":10,\"y\":20}";
  assert(json_parse(request, strlen(request), &o, error, sizeof(error)));
  assert(jmods(&o) == 3);
  assert(!strcmp(jstr(&o, "op"), "click"));
  json_free(&o);
  const char *crop = "{\"crop\":{\"width\":64},\"op\":{\"name\":\"click\"}}";
  assert(json_parse(crop, strlen(crop), &o, error, sizeof(error)));
  assert(jstr(&o, "op") == NULL);
  jobject nested;
  assert(jobj(&o, "crop", &nested));
  double width=0;
  assert(jnum(&nested, "width", &width) && width==64);
  json_free(&nested); json_free(&o);
  invalid("{} trailing");
  invalid("{\"op\":\"ping\"}{}");
  invalid("{\"text\":\"raw\nnewline\"}");
  invalid("{\"mods\":[\"ctrl\",]}");
  invalid("{\"mods\":[\"ctrl\"}");
  invalid("{\"text\":\"a\\u0000b\"}");
  puts("Linux JSON protocol regression checks passed");
  return 0;
}
