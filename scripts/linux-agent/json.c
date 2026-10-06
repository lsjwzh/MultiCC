/*
 * 极简 JSON —— 只覆盖 docs/desktop-agent-protocol.md 里那条一行进一行出的载荷。
 *
 * 为什么不用现成的库：agent 是零外部依赖的单文件程序（除 X11/zlib/libjpeg 这些
 * 系统库），为几十个字段的形状引一个 JSON 库不划算。为什么不用「字符串里找
 * "op":"snap"」这种土办法：`type` 的文本是任意 Unicode，随手搜子串迟早会被
 * 用户输入里的引号骗到。
 *
 * 边界（写死在这里，超了就是协议变了）：
 *   · 顶层必须是对象；只支持一层嵌套对象（snap 的 crop）
 *   · 不支持数组
 *   · 字符串支持全部必需转义（\" \\ \/ \b \f \n \r \t \uXXXX，含代理对）
 *   · 数字交给 strtod，超过 63 字符的 token 当解析失败
 */

#include "agent.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct { const char *p, *end; } cur;

static void skip_ws(cur *c) {
  while (c->p < c->end) {
    char ch = *c->p;
    if (ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r') c->p++;
    else break;
  }
}

static int at(const cur *c) { return c->p < c->end ? (unsigned char)*c->p : -1; }

/* 把码点写成 UTF-8。调用方保证 out 至少有 4 字节余量。 */
static void utf8_put(char *out, size_t *n, unsigned cp) {
  if (cp < 0x80) {
    out[(*n)++] = (char)cp;
  } else if (cp < 0x800) {
    out[(*n)++] = (char)(0xC0 | (cp >> 6));
    out[(*n)++] = (char)(0x80 | (cp & 0x3F));
  } else if (cp < 0x10000) {
    out[(*n)++] = (char)(0xE0 | (cp >> 12));
    out[(*n)++] = (char)(0x80 | ((cp >> 6) & 0x3F));
    out[(*n)++] = (char)(0x80 | (cp & 0x3F));
  } else {
    out[(*n)++] = (char)(0xF0 | (cp >> 18));
    out[(*n)++] = (char)(0x80 | ((cp >> 12) & 0x3F));
    out[(*n)++] = (char)(0x80 | ((cp >> 6) & 0x3F));
    out[(*n)++] = (char)(0x80 | (cp & 0x3F));
  }
}

static int hex4(cur *c, unsigned *out) {
  unsigned v = 0;
  for (int i = 0; i < 4; i++) {
    if (c->p >= c->end) return 0;
    int ch = (unsigned char)*c->p++;
    v <<= 4;
    if (ch >= '0' && ch <= '9') v |= (unsigned)(ch - '0');
    else if (ch >= 'a' && ch <= 'f') v |= (unsigned)(ch - 'a' + 10);
    else if (ch >= 'A' && ch <= 'F') v |= (unsigned)(ch - 'A' + 10);
    else return 0;
  }
  *out = v;
  return 1;
}

/* 跳过（不解码）一个字符串字面量，用来先量长度。 */
static int skip_string(cur *c) {
  if (at(c) != '"') return 0;
  c->p++;
  while (c->p < c->end) {
    unsigned char ch = (unsigned char)*c->p++;
    if (ch == '\\') { if (c->p < c->end) c->p++; continue; }
    if (ch == '"') return 1;
  }
  return 0;
}

static int parse_string(cur *c, char *out, size_t cap, char *err, size_t errsz) {
  size_t n = 0;
  if (at(c) != '"') { snprintf(err, errsz, "expected string"); return 0; }
  c->p++;
  while (c->p < c->end) {
    unsigned char ch = (unsigned char)*c->p++;
    if (ch == '"') { out[n] = 0; return 1; }
    /* 按**这一步实际要写多少**留地方：这一轮要么原样写 1 字节，要么走转义
     * （转义里只有 \u 可能写 4 字节，闸门在下面）。上面的 cap 是缓冲总长，
     * 所以 1 字节的路径只需 n+2 <= cap —— 一律按 4 字节预留会让 "status"
     * 这种 6 个字符的短串在 n=5 时就被判 "string too long"。 */
    if (n + 1 >= cap) { snprintf(err, errsz, "string too long"); return 0; }
    if (ch != '\\') { out[n++] = (char)ch; continue; }
    if (c->p >= c->end) break;
    char e = *c->p++;
    switch (e) {
      case '"':  out[n++] = '"';  break;
      case '\\': out[n++] = '\\'; break;
      case '/':  out[n++] = '/';  break;
      case 'b':  out[n++] = '\b'; break;
      case 'f':  out[n++] = '\f'; break;
      case 'n':  out[n++] = '\n'; break;
      case 'r':  out[n++] = '\r'; break;
      case 't':  out[n++] = '\t'; break;
      case 'u': {
        unsigned cp;
        if (!hex4(c, &cp)) { snprintf(err, errsz, "bad \\u escape"); return 0; }
        if (cp >= 0xD800 && cp <= 0xDBFF && (size_t)(c->end - c->p) >= 6
            && c->p[0] == '\\' && c->p[1] == 'u') {
          cur save = *c;
          c->p += 2;
          unsigned lo;
          if (hex4(c, &lo) && lo >= 0xDC00 && lo <= 0xDFFF) {
            cp = 0x10000u + ((cp - 0xD800u) << 10) + (lo - 0xDC00u);
          } else {
            *c = save; /* 不是合法低位代理：当独立码点处理 */
          }
        }
        /* 唯一会一次写超过 1 字节的地方：一个码点最多 4 字节 + 结尾 NUL。 */
        if (n + 5 > cap) { snprintf(err, errsz, "string too long"); return 0; }
        utf8_put(out, &n, cp);
        break;
      }
      default: snprintf(err, errsz, "bad escape \\%c", e); return 0;
    }
  }
  snprintf(err, errsz, "unterminated string");
  return 0;
}

/* 把一段嵌套对象原样抄下来（含外层花括号），交给 jobj() 再解析一次。 */
static int parse_object_raw(cur *c, char **out, char *err, size_t errsz) {
  const char *start = c->p;
  int depth = 0;
  while (c->p < c->end) {
    char ch = *c->p;
    if (ch == '"') {
      if (!skip_string(c)) { snprintf(err, errsz, "bad string inside object"); return 0; }
      continue;
    }
    if (ch == '{') { depth++; c->p++; continue; }
    if (ch == '}') {
      depth--;
      c->p++;
      if (depth == 0) {
        size_t len = (size_t)(c->p - start);
        char *s = malloc(len + 1);
        if (!s) { snprintf(err, errsz, "out of memory"); return 0; }
        memcpy(s, start, len);
        s[len] = 0;
        *out = s;
        return 1;
      }
      continue;
    }
    c->p++;
  }
  snprintf(err, errsz, "unterminated object");
  return 0;
}

static int parse_value(cur *c, jfield *f, char *err, size_t errsz) {
  int ch = at(c);

  if (ch == '"') {
    cur probe = *c;
    if (!skip_string(&probe)) { snprintf(err, errsz, "bad string"); return 0; }
    size_t raw = (size_t)(probe.p - c->p); /* 含引号；解码后只会更短 */
    char *s = malloc(raw + 1);
    if (!s) { snprintf(err, errsz, "out of memory"); return 0; }
    if (!parse_string(c, s, raw + 1, err, errsz)) { free(s); return 0; }
    f->s = s;
    return 1;
  }
  if (ch == '{') {
    f->is_obj = 1;
    return parse_object_raw(c, &f->s, err, errsz);
  }
  if (ch == 't' && (size_t)(c->end - c->p) >= 4 && memcmp(c->p, "true", 4) == 0) {
    c->p += 4; f->is_bool = 1; f->b = 1; return 1;
  }
  if (ch == 'f' && (size_t)(c->end - c->p) >= 5 && memcmp(c->p, "false", 5) == 0) {
    c->p += 5; f->is_bool = 1; f->b = 0; return 1;
  }
  if (ch == 'n' && (size_t)(c->end - c->p) >= 4 && memcmp(c->p, "null", 4) == 0) {
    c->p += 4; f->is_null = 1; return 1;
  }

  {
    char tmp[64];
    size_t n = 0;
    const char *s0 = c->p;
    while (c->p < c->end && n + 1 < sizeof(tmp)) {
      char d = *c->p;
      if ((d >= '0' && d <= '9') || d == '-' || d == '+' || d == '.' || d == 'e' || d == 'E') {
        tmp[n++] = d;
        c->p++;
      } else break;
    }
    tmp[n] = 0;
    if (c->p == s0) { snprintf(err, errsz, "unexpected value"); return 0; }
    char *endp = NULL;
    double v = strtod(tmp, &endp);
    if (!endp || endp == tmp || *endp) { snprintf(err, errsz, "bad number '%s'", tmp); return 0; }
    f->is_num = 1;
    f->n = v;
    return 1;
  }
}

int json_parse(const char *text, size_t len, jobject *out, char *err, size_t errsz) {
  cur c = { text, text + len };
  int cap = 0;

  out->f = NULL;
  out->n = 0;
  skip_ws(&c);
  if (at(&c) != '{') { snprintf(err, errsz, "expected object"); return 0; }
  c.p++;
  skip_ws(&c);
  if (at(&c) == '}') return 1;

  for (;;) {
    if (out->n == cap) {
      cap = cap ? cap * 2 : 8;
      jfield *nf = realloc(out->f, (size_t)cap * sizeof(*nf));
      if (!nf) { snprintf(err, errsz, "out of memory"); return 0; }
      out->f = nf;
    }
    jfield *f = &out->f[out->n];
    memset(f, 0, sizeof(*f));

    skip_ws(&c);
    if (!parse_string(&c, f->key, sizeof(f->key), err, errsz)) return 0;
    skip_ws(&c);
    if (at(&c) != ':') { snprintf(err, errsz, "expected ':' after %s", f->key); return 0; }
    c.p++;
    skip_ws(&c);
    if (!parse_value(&c, f, err, errsz)) return 0;
    out->n++;

    skip_ws(&c);
    if (at(&c) == ',') { c.p++; continue; }
    if (at(&c) == '}') return 1;
    snprintf(err, errsz, "expected ',' or '}' after %s", f->key);
    return 0;
  }
}

void json_free(jobject *o) {
  if (!o || !o->f) return;
  for (int i = 0; i < o->n; i++) free(o->f[i].s);
  free(o->f);
  o->f = NULL;
  o->n = 0;
}

static const jfield *find(const jobject *o, const char *key) {
  if (!o || !o->f) return NULL;
  for (int i = 0; i < o->n; i++) {
    if (strcmp(o->f[i].key, key) == 0) return &o->f[i];
  }
  return NULL;
}

int jhas(const jobject *o, const char *key) { return find(o, key) != NULL; }

const char *jstr(const jobject *o, const char *key) {
  const jfield *f = find(o, key);
  return f && f->s ? f->s : NULL;
}

int jnum(const jobject *o, const char *key, double *out) {
  const jfield *f = find(o, key);
  if (!f) return 0;
  if (f->is_num) { *out = f->n; return 1; }
  /* 数字也可能是字符串形式（前端偶尔会 toString），能转就转。 */
  if (f->s && *f->s) {
    char *endp = NULL;
    double v = strtod(f->s, &endp);
    if (endp && endp != f->s && !*endp) { *out = v; return 1; }
  }
  return 0;
}

int jbool(const jobject *o, const char *key, int *out) {
  const jfield *f = find(o, key);
  if (!f) return 0;
  if (f->is_bool) { *out = f->b; return 1; }
  if (f->is_num) { *out = f->n != 0; return 1; }
  if (f->s) {
    if (!strcmp(f->s, "true") || !strcmp(f->s, "1")) { *out = 1; return 1; }
    if (!strcmp(f->s, "false") || !strcmp(f->s, "0")) { *out = 0; return 1; }
  }
  return 0;
}

int jobj(const jobject *o, const char *key, jobject *out) {
  const jfield *f = find(o, key);
  out->f = NULL;
  out->n = 0;
  if (!f || !f->is_obj || !f->s) return 0;
  char err[64];
  return json_parse(f->s, strlen(f->s), out, err, sizeof(err));
}

/* ── 响应构造 ─────────────────────────────────────────────────────────── */

static void putc_(jout *o, char ch) {
  if (o->len + 2 > o->cap) { o->trunc = 1; return; }
  o->buf[o->len++] = ch;
  o->buf[o->len] = 0;
}

static void puts_(jout *o, const char *s) {
  while (*s) putc_(o, *s++);
}

static void escaped(jout *o, const char *s) {
  if (!s) return;
  for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
    unsigned char ch = *p;
    switch (ch) {
      case '"':  puts_(o, "\\\""); break;
      case '\\': puts_(o, "\\\\"); break;
      case '\n': puts_(o, "\\n");  break;
      case '\r': puts_(o, "\\r");  break;
      case '\t': puts_(o, "\\t");  break;
      default:
        if (ch < 0x20) {
          char t[8];
          snprintf(t, sizeof(t), "\\u%04x", ch);
          puts_(o, t);
        } else {
          putc_(o, (char)ch);
        }
    }
  }
}

static void key_(jout *o, const char *k) {
  if (o->need_comma) putc_(o, ',');
  putc_(o, '"');
  escaped(o, k);
  puts_(o, "\":");
  o->need_comma = 1;
}

void jo_init(jout *o, char *buf, size_t cap) {
  o->buf = buf;
  o->cap = cap;
  o->len = 0;
  o->need_comma = 0;
  o->trunc = 0;
  o->depth = 0;
  if (cap > 1) {
    buf[o->len++] = '{';
    buf[o->len] = 0;
  } else {
    o->trunc = 1;
  }
}

void jo_str(jout *o, const char *k, const char *v) {
  key_(o, k);
  putc_(o, '"');
  escaped(o, v ? v : "");
  putc_(o, '"');
}

void jo_int(jout *o, const char *k, long long v) {
  char t[32];
  snprintf(t, sizeof(t), "%lld", v);
  key_(o, k);
  puts_(o, t);
}

void jo_bool(jout *o, const char *k, int v) { key_(o, k); puts_(o, v ? "true" : "false"); }
void jo_null(jout *o, const char *k) { key_(o, k); puts_(o, "null"); }

void jo_nest(jout *o, const char *k) {
  key_(o, k);
  putc_(o, '{');
  if (o->depth < 8) {
    o->commas[o->depth] = o->need_comma;
    o->depth++;
  }
  o->need_comma = 0;
}

void jo_end(jout *o) {
  putc_(o, '}');
  if (o->depth > 0) {
    o->depth--;
    o->need_comma = o->commas[o->depth];
  } else {
    o->need_comma = 1;
  }
}

void jo_finish(jout *o) { putc_(o, '}'); }

int jo_ok(const jout *o) { return !o->trunc; }
