/*
 * MultiCC Linux desktop agent
 *
 * 与 macOS 那份（scripts/macos-agent/MultiCCAgent.swift）同一份契约、同一套 op、
 * 同一套护栏（见 docs/desktop-agent-protocol.md），只是传输从 unix socket +
 * getpeereid 换成 unix socket + SO_PEERCRED，实现从 ScreenCaptureKit/CGEvent
 * 换成 X11（XShm + XTEST）。
 *
 * 用法：
 *   multicc-agent-linux [--socket PATH] [--verbose]      服务模式（前台跑）
 *   multicc-agent-linux --print-socket                   只打印默认 socket 路径
 *   multicc-agent-linux status | snap <path> | click <x> <y> | …   CLI 镜像
 *
 * 安全边界：X11 没有 macOS 那种 TCC 权限模型 —— 谁能连上 X server 谁就能注入。
 * 所以这里的边界只有两条，都必须真的成立：
 *   1. socket 落在 $XDG_RUNTIME_DIR（0700 目录 + 0600 文件），并且每次连接都
 *      用 SO_PEERCRED 校验同 uid；同机其他用户连不上。
 *   2. op 集合是封闭的，且服务端那侧还有一层白名单。agent 不执行命令、不任意
 *      读写路径（snap 的 path 必须是绝对路径且不含 ..）。
 * 另外三道「对人的护栏」（锁屏拒绝 / Esc 急停 / 敏感窗口）在 §handle 里，不是
 * 可选项：远程的人在操作，机器前的人必须随时能喊停。
 */

#define _GNU_SOURCE
#include "agent.h"

#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#include <X11/Xlib.h>

#define AGENT_VERSION "1.0.0"
#define MAX_LINE (64 * 1024)
#define RESP_CAP 8192
#define MAX_CONNS 16
#define MAX_REQ_PER_CONN 64

/* 租约空闲这么久没再有输入就自动失效：远程的人关掉页面后不该把桌面永远锁住。 */
#define LEASE_IDLE_SEC 120

static int g_verbose = 0;

/* ── 租约 / 急停 ──────────────────────────────────────────────────────── */

static pthread_mutex_t g_mu = PTHREAD_MUTEX_INITIALIZER;
static char g_lease[64] = "";
static time_t g_lease_at = 0;
static int g_halted = 0;
static int g_conns = 0;

static time_t now_s(void) { return time(NULL); }

/* Esc 边沿回调，跑在观察线程里。**在按下的那一刻**判断算不算急停：放到
 * 「下一次请求到达时」再判断，会漏掉「拿着租约但一直没操作」那种情况。
 * 返回 1 = 这次算急停（x11.c 那边会顺手松开可能卡住的修饰键）。 */
static int on_esc_edge(void) {
  pthread_mutex_lock(&g_mu);
  time_t t = now_s();
  int active = g_lease[0] != '\0' && (t - g_lease_at) <= LEASE_IDLE_SEC;
  int counted = 0;
  if (active && !g_halted) {
    g_halted = 1;
    g_lease[0] = '\0';
    counted = 1;
  }
  pthread_mutex_unlock(&g_mu);
  if (counted && g_verbose) fprintf(stderr, "[agent] 本机按了 Esc：急停生效，租约已撤销\n");
  return counted;
}

/* session 拿租约。别人正拿着且没超时就拒绝。 */
static int lease_take(const char *session) {
  pthread_mutex_lock(&g_mu);
  time_t t = now_s();
  int ok = 1;
  if (g_lease[0] && strcmp(g_lease, session) != 0 && (t - g_lease_at) < LEASE_IDLE_SEC) ok = 0;
  if (ok) {
    snprintf(g_lease, sizeof(g_lease), "%s", session);
    g_lease_at = t;
  }
  pthread_mutex_unlock(&g_mu);
  return ok;
}

static void lease_touch(const char *session) {
  pthread_mutex_lock(&g_mu);
  if (g_lease[0] && strcmp(g_lease, session) == 0) g_lease_at = now_s();
  pthread_mutex_unlock(&g_mu);
}

static void lease_release(const char *session) {
  pthread_mutex_lock(&g_mu);
  if (!session || !g_lease[0] || strcmp(g_lease, session) == 0) g_lease[0] = '\0';
  pthread_mutex_unlock(&g_mu);
}

/* 观察线程拿它决定采样频率：有人真拿着租约时才快采样。判据与 on_esc_edge
 * 那句必须一致 —— 不然会出现「快采样期间按 Esc 不算数」这种最坏组合。 */
static int lease_held(void) {
  pthread_mutex_lock(&g_mu);
  int active = g_lease[0] != '\0' && (now_s() - g_lease_at) <= LEASE_IDLE_SEC;
  pthread_mutex_unlock(&g_mu);
  return active;
}

/* ── 响应小工具 ───────────────────────────────────────────────────────── */

static void fail_with(jout *out, const char *error, const char *hint) {
  jo_bool(out, "ok", 0);
  jo_str(out, "error", error);
  if (hint && *hint) jo_str(out, "hint", hint);
}

/* ── op 实现 ──────────────────────────────────────────────────────────── */

/* snap：抓主屏 →（可选）裁剪 → 编码到 path。
 *
 * 与契约 §4.1 的差别：Linux 上编码也在这里做。crop 用逻辑点（X11 上逻辑点 ==
 * 像素），服务端不用自己换算。响应里 width/height 是**整屏**尺寸，crop 是实际
 * 生效的裁剪区 —— 前端要靠整屏尺寸把图上的点映射回逻辑点。 */
static void do_snap(const jobject *req, jout *out) {
  const char *path = jstr(req, "path");
  char err[192] = "";

  if (!path || !*path) { fail_with(out, "path-required", NULL); return; }
  /* 不任意读写路径：绝对路径 + 不含 ..。服务端给的一定是 assistDir 下的文件。 */
  if (path[0] != '/' || strstr(path, "..")) { fail_with(out, "bad-path", "path must be absolute, without .."); return; }
  if (!x11_open(err, sizeof(err))) { fail_with(out, "no-display", err); return; }

  int jpeg = 0;
  jbool(req, "jpeg", &jpeg);
  if (!jpeg) {
    size_t n = strlen(path);
    if (n > 4 && (!strcasecmp(path + n - 4, ".jpg") || (n > 5 && !strcasecmp(path + n - 5, ".jpeg")))) jpeg = 1;
  }
  double quality = 60;
  jnum(req, "quality", &quality);

  struct timeval t0, t1;
  gettimeofday(&t0, NULL);

  shot *full = x11_capture(err, sizeof(err));
  if (!full) { fail_with(out, "capture-failed", err); return; }

  shot *use = full;
  shot *cropped = NULL;
  double cx = 0, cy = 0, cw = 0, ch = 0;
  jobject crop;
  int have_crop = 0;

  if (jobj(req, "crop", &crop)) {
    int okc = jnum(&crop, "x", &cx) && jnum(&crop, "y", &cy)
              && jnum(&crop, "width", &cw) && jnum(&crop, "height", &ch);
    json_free(&crop);
    if (!okc) { shot_free(full); fail_with(out, "bad-crop", NULL); return; }
    cropped = shot_crop(full, (int)cx, (int)cy, (int)cw, (int)ch, err, sizeof(err));
    if (!cropped) {
      const char *code = err[0] ? err : "crop-failed";
      shot_free(full);
      fail_with(out, code, code[0] ? NULL : err);
      return;
    }
    use = cropped;
    have_crop = 1;
  }

  int ok = jpeg
    ? image_write_jpeg(path, use->rgb, use->w, use->h, (int)quality, err, sizeof(err))
    : image_write_png(path, use->rgb, use->w, use->h, err, sizeof(err));

  int sw = full->w, sh = full->h;
  shot_free(cropped);
  shot_free(full);

  if (!ok) { fail_with(out, "encode-failed", err); return; }

  gettimeofday(&t1, NULL);
  long ms = (t1.tv_sec - t0.tv_sec) * 1000 + (t1.tv_usec - t0.tv_usec) / 1000;

  jo_bool(out, "ok", 1);
  jo_str(out, "path", path);
  jo_int(out, "width", sw);
  jo_int(out, "height", sh);
  if (have_crop) {
    jo_nest(out, "crop");
    jo_int(out, "x", (long long)cx);
    jo_int(out, "y", (long long)cy);
    jo_int(out, "width", (long long)cw);
    jo_int(out, "height", (long long)ch);
    jo_int(out, "pixelX", (long long)cx);
    jo_int(out, "pixelY", (long long)cy);
    jo_int(out, "pixelWidth", (long long)cw);
    jo_int(out, "pixelHeight", (long long)ch);
    jo_end(out);
  } else {
    jo_null(out, "crop");
  }
  jo_int(out, "ms", ms);
}

static void do_status(jout *out) {
  char err[192] = "";
  if (!x11_open(err, sizeof(err))) {
    fail_with(out, "no-display", err);
    return;
  }
  const char *how = "none";
  int locked = x11_screen_locked(&how);
  int sw = 0, sh = 0;
  x11_screen_size(&sw, &sh);

  const char *holder = NULL;
  int halted = 0;
  pthread_mutex_lock(&g_mu);
  if (g_lease[0] && (now_s() - g_lease_at) < LEASE_IDLE_SEC) holder = g_lease;
  halted = g_halted;
  pthread_mutex_unlock(&g_mu);

  jo_bool(out, "ok", 1);
  jo_bool(out, "screenLocked", locked);
  jo_str(out, "lockCheck", how);
  /* Linux 没有「辅助功能 / 屏幕录制」这两种授权：能连上 X server 就能看和注入。
   * 如实报 true，别让上层以为有个开关没打开。 */
  jo_bool(out, "accessibility", 1);
  jo_bool(out, "screenRecording", 1);
  jo_nest(out, "control");
  if (holder) jo_str(out, "leaseHolder", holder);
  else jo_null(out, "leaseHolder");
  jo_bool(out, "halted", halted);
  jo_end(out);
  jo_nest(out, "screen");
  jo_int(out, "width", sw);
  jo_int(out, "height", sh);
  jo_end(out);
  jo_str(out, "backend", "x11");
  jo_str(out, "display", getenv("DISPLAY") ? getenv("DISPLAY") : "");
  jo_str(out, "version", AGENT_VERSION);
}

/* 输入 op 的公共前置：护栏三道 + 拿租约。返回 0 表示已经写好了拒绝响应。 */
static int gate(jobject *req, const char *op, jout *out, int needs_system) {
  char err[192] = "";

  if (!x11_open(err, sizeof(err))) { fail_with(out, "no-display", err); return 0; }

  int halted = 0;
  pthread_mutex_lock(&g_mu);
  halted = g_halted;
  pthread_mutex_unlock(&g_mu);
  if (halted) { fail_with(out, "user-stopped", "press resume to clear"); return 0; }

  if (x11_screen_locked(NULL)) { fail_with(out, "screen-locked", NULL); return 0; }

  /* 受保护窗口：只挡「往里打字 / 点」这类会泄露或改变系统状态的动作，
   * 不动指针移动 —— 后者没有副作用，挡住只会让拖动看起来卡住。 */
  if (strcmp(op, "type") == 0 || strcmp(op, "press") == 0) {
    if (x11_focus_is_sensitive()) { fail_with(out, "protected-app", NULL); return 0; }
  }

  if (needs_system) {
    int allow = 0;
    jbool(req, "allowSystem", &allow);
    if (!allow) { fail_with(out, "not-allowed", "missing allowSystem"); return 0; }
  }

  const char *session = jstr(req, "session");
  if (!session || !*session) { fail_with(out, "session-required", NULL); return 0; }
  if (!lease_take(session)) { fail_with(out, "busy", "another session holds the lease"); return 0; }
  lease_touch(session);
  /* 拿到租约 = 有人开始操作了：立刻把 Esc 观察线程从空闲档叫醒。
   * 少了这一步，「拿到租约之后的第一次 Esc」要等最长 150ms 才被采样到，
   * 而人按 Esc 只按住 120ms —— 会整次漏判。 */
  x11_watch_nudge();
  return 1;
}

/* 注入期间告诉观察线程「别把我自己发的键当成用户的急停」。 */
static void do_input(const jobject *req, const char *op, jout *out) {
  double x = 0, y = 0, x2 = 0, y2 = 0, amount = 0, ms = 300, count = 1;
  int ok = 0;
  const char *errmsg = NULL;

  x11_injecting(1);
  if (strcmp(op, "move") == 0) {
    if (!jnum(req, "x", &x) || !jnum(req, "y", &y)) { x11_injecting(0); fail_with(out, "x-and-y-required", NULL); return; }
    ok = x11_move((int)x, (int)y);
  } else if (strcmp(op, "click") == 0) {
    if (!jnum(req, "x", &x) || !jnum(req, "y", &y)) { x11_injecting(0); fail_with(out, "x-and-y-required", NULL); return; }
    jnum(req, "count", &count);
    if (count < 1) count = 1;
    if (count > 3) count = 3;
    const char *btn = jstr(req, "button");
    int b = 1;
    if (btn && !strcmp(btn, "right")) b = 3;
    else if (btn && !strcmp(btn, "middle")) b = 2;
    ok = x11_click((int)x, (int)y, b, (int)count);
  } else if (strcmp(op, "scroll") == 0) {
    if (!jnum(req, "x", &x) || !jnum(req, "y", &y)) { x11_injecting(0); fail_with(out, "x-and-y-required", NULL); return; }
    jnum(req, "amount", &amount);
    ok = x11_scroll((int)x, (int)y, (int)amount);
  } else if (strcmp(op, "drag") == 0) {
    if (!jnum(req, "x", &x) || !jnum(req, "y", &y) || !jnum(req, "x2", &x2) || !jnum(req, "y2", &y2)) {
      x11_injecting(0);
      fail_with(out, "x-y-x2-y2-required", NULL);
      return;
    }
    jnum(req, "ms", &ms);
    ok = x11_drag((int)x, (int)y, (int)x2, (int)y2, (int)ms);
  } else if (strcmp(op, "type") == 0) {
    const char *text = jstr(req, "text");
    if (!text) { x11_injecting(0); fail_with(out, "text-required", NULL); return; }
    ok = x11_type(text);
  } else if (strcmp(op, "press") == 0) {
    const char *keys = jstr(req, "keys");
    if (!keys) { x11_injecting(0); fail_with(out, "keys-required", NULL); return; }
    ok = x11_press(keys);
  }
  x11_injecting(0);

  if (ok) {
    jo_bool(out, "ok", 1);
    jo_str(out, "op", op);
  } else {
    errmsg = x11_last_error();
    fail_with(out, "inject-failed", errmsg);
  }
}

static int is_input_op(const char *op) {
  return strcmp(op, "click") == 0 || strcmp(op, "move") == 0 || strcmp(op, "scroll") == 0
      || strcmp(op, "drag") == 0 || strcmp(op, "type") == 0 || strcmp(op, "press") == 0;
}

static void dispatch(jobject *req, jout *out) {
  const char *op = jstr(req, "op");
  if (!op || !*op) { fail_with(out, "op-required", NULL); return; }

  if (strcmp(op, "snap") == 0) { do_snap(req, out); return; }
  if (strcmp(op, "status") == 0) { do_status(out); return; }
  if (strcmp(op, "ping") == 0) { jo_bool(out, "ok", 1); jo_bool(out, "pong", 1); jo_str(out, "version", AGENT_VERSION); return; }

  if (strcmp(op, "release") == 0) {
    const char *session = jstr(req, "session");
    lease_release(session);
    if (x11_open(NULL, 0)) x11_release_all();
    jo_bool(out, "ok", 1);
    return;
  }
  if (strcmp(op, "resume") == 0) {
    pthread_mutex_lock(&g_mu);
    g_halted = 0;
    pthread_mutex_unlock(&g_mu);
    if (x11_open(NULL, 0)) x11_release_all();
    jo_bool(out, "ok", 1);
    return;
  }
  /* 契约 §5.5：不能解锁的平台也必须**接受**这个 op 并回 ok:false + 原因，
   * 而不是断连。X11 的锁屏是另一个会话的窗口，本来也够不到。 */
  if (strcmp(op, "unlock") == 0) {
    fail_with(out, "unlock-unsupported", "Linux agent 不支持自动解锁");
    return;
  }

  if (is_input_op(op)) {
    int needs_system = 1;
    if (!gate(req, op, out, needs_system)) return;
    do_input(req, op, out);
    return;
  }

  fail_with(out, "unknown-op", op);
}

/* ── socket 一侧 ──────────────────────────────────────────────────────── */

static void respond(const char *line, size_t len, char *resp, size_t respcap) {
  jobject req;
  jout out;
  char err[128] = "";

  jo_init(&out, resp, respcap);
  if (!json_parse(line, len, &req, err, sizeof(err))) {
    fail_with(&out, "bad-json", err);
  } else {
    dispatch(&req, &out);
    json_free(&req);
  }
  jo_finish(&out);
  if (!jo_ok(&out)) {
    /* 响应被截断了：宁可回一个明确的错误，也不要发半条 JSON 出去。 */
    snprintf(resp, respcap, "{\"ok\":false,\"error\":\"response-too-large\"}");
  }
}

static void *conn_main(void *arg) {
  int fd = (int)(intptr_t)arg;
  char *buf = malloc(MAX_LINE);
  char *resp = malloc(RESP_CAP);
  size_t len = 0;
  int served = 0;

  if (buf && resp) {
    for (;;) {
      if (len >= MAX_LINE - 1) break;
      ssize_t n = read(fd, buf + len, MAX_LINE - 1 - len);
      if (n <= 0) break;
      len += (size_t)n;
      for (;;) {
        char *nl = memchr(buf, '\n', len);
        if (!nl) break;
        size_t linelen = (size_t)(nl - buf);
        if (linelen > 0) {
          respond(buf, linelen, resp, RESP_CAP);
          size_t rl = strlen(resp);
          if (write(fd, resp, rl) != (ssize_t)rl || write(fd, "\n", 1) != 1) { len = 0; break; }
        }
        memmove(buf, nl + 1, len - linelen - 1);
        len -= linelen + 1;
        if (++served >= MAX_REQ_PER_CONN) { len = 0; break; }
      }
    }
  }
  free(buf);
  free(resp);
  close(fd);

  pthread_mutex_lock(&g_mu);
  g_conns--;
  pthread_mutex_unlock(&g_mu);
  return NULL;
}

static int peer_is_same_uid(int fd) {
  struct ucred cr;
  socklen_t len = sizeof(cr);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cr, &len) != 0) return 0;
  return cr.uid == geteuid();
}

static int listen_unix(const char *path, char *err, size_t errsz) {
  struct sockaddr_un sa;
  char dir[sizeof(sa.sun_path)];
  char *slash;

  if (strlen(path) >= sizeof(sa.sun_path)) { snprintf(err, errsz, "socket path too long"); return -1; }

  snprintf(dir, sizeof(dir), "%s", path);
  slash = strrchr(dir, '/');
  if (slash) {
    *slash = 0;
    if (mkdir(dir, 0700) != 0 && errno != EEXIST) {
      snprintf(err, errsz, "mkdir %s: %s", dir, strerror(errno));
      return -1;
    }
  }

  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) { snprintf(err, errsz, "socket: %s", strerror(errno)); return -1; }

  unlink(path); /* 上次没退干净的残留 socket */
  memset(&sa, 0, sizeof(sa));
  sa.sun_family = AF_UNIX;
  snprintf(sa.sun_path, sizeof(sa.sun_path), "%s", path);

  if (bind(fd, (struct sockaddr *)&sa, sizeof(sa)) != 0) {
    snprintf(err, errsz, "bind %s: %s", path, strerror(errno));
    close(fd);
    return -1;
  }
  chmod(path, 0600);
  if (listen(fd, 16) != 0) {
    snprintf(err, errsz, "listen: %s", strerror(errno));
    close(fd);
    return -1;
  }
  return fd;
}

/* ── CLI 镜像 ─────────────────────────────────────────────────────────── */

/* 不是「另一条实现」，只是把 argv 拼成同一份 JSON 再走同一个 socket：
 * 手工调试和一致性脚本都直接用它，于是 CLI 与 socket 不可能跑偏。 */
static char *cli_request(int argc, char **argv) {
  static char buf[8192];
  const char *op = argv[0];

  if (!strcmp(op, "status")) {
    snprintf(buf, sizeof(buf), "{\"op\":\"status\",\"session\":\"cli\"}");
  } else if (!strcmp(op, "release") || !strcmp(op, "resume") || !strcmp(op, "ping")) {
    snprintf(buf, sizeof(buf), "{\"op\":\"%s\",\"session\":\"cli\"}", op);
  } else if (!strcmp(op, "snap") && argc >= 2) {
    snprintf(buf, sizeof(buf), "{\"op\":\"snap\",\"session\":\"cli\",\"path\":\"%s\"}", argv[1]);
  } else if (!strcmp(op, "move") && argc >= 3) {
    snprintf(buf, sizeof(buf), "{\"op\":\"move\",\"session\":\"cli\",\"x\":%s,\"y\":%s,\"allowSystem\":true}", argv[1], argv[2]);
  } else if (!strcmp(op, "click") && argc >= 3) {
    snprintf(buf, sizeof(buf), "{\"op\":\"click\",\"session\":\"cli\",\"x\":%s,\"y\":%s,\"allowSystem\":true}", argv[1], argv[2]);
  } else if (!strcmp(op, "type") && argc >= 2) {
    /* 文本要过一遍 JSON 转义，否则带引号的内容会拼出坏 JSON。 */
    size_t n = (size_t)snprintf(buf, sizeof(buf),
                                "{\"op\":\"type\",\"session\":\"cli\",\"allowSystem\":true,\"allowTerminal\":true,\"text\":\"");
    for (const unsigned char *p = (const unsigned char *)argv[1]; *p && n + 8 < sizeof(buf); p++) {
      if (*p == '"' || *p == '\\') { buf[n++] = '\\'; buf[n++] = (char)*p; }
      else if (*p == '\n') { buf[n++] = '\\'; buf[n++] = 'n'; }
      else if (*p < 0x20) { n += (size_t)snprintf(buf + n, sizeof(buf) - n, "\\u%04x", *p); }
      else buf[n++] = (char)*p;
    }
    snprintf(buf + n, sizeof(buf) - n, "\"}");
  } else if (!strcmp(op, "press") && argc >= 2) {
    snprintf(buf, sizeof(buf),
             "{\"op\":\"press\",\"session\":\"cli\",\"allowSystem\":true,\"allowTerminal\":true,\"keys\":\"%s\"}", argv[1]);
  } else {
    return NULL;
  }
  return buf;
}

static int cli_main(int argc, char **argv, const char *sockpath, const char *self) {
  char *req = NULL;

  if (argc >= 1 && !strcmp(argv[0], "--raw")) {
    /* 原样发一段 JSON —— 一致性脚本靠它构造「正常客户端不会发」的请求
     * （畸形 JSON、未知 op、越权、缺字段）。没有这个口子，那些分支就只能
     * 靠读代码相信它们是对的。JSON 缺省从 stdin 读一行，于是畸形字节也能发。 */
    static char rb[MAX_LINE];
    if (argc >= 2) {
      req = argv[1];
    } else {
      size_t n = fread(rb, 1, sizeof(rb) - 1, stdin);
      rb[n] = 0;
      char *nl = strchr(rb, '\n');
      if (nl) *nl = 0;
      req = rb;
    }
    if (!req || !*req) { fprintf(stderr, "--raw 需要一段 JSON\n"); return 2; }
  } else {
    req = cli_request(argc, argv);
  }

  struct sockaddr_un sa;
  int fd;
  char resp[RESP_CAP];
  size_t len = 0;

  if (!req) {
    fprintf(stderr,
            "用法：\n"
            "  %s [--socket PATH] [--verbose]          服务模式\n"
            "  %s --print-socket                       打印默认 socket 路径\n"
            "  %s --raw '<json>'                       原样发一段请求（调试/测试）\n"
            "  %s status | snap <path> | move <x> <y> | click <x> <y> | type <text> | press <keys> | release | resume\n",
            self, self, self, self);
    return 2;
  }
  if (strlen(sockpath) >= sizeof(sa.sun_path)) { fprintf(stderr, "socket 路径太长\n"); return 2; }

  fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) { perror("socket"); return 1; }
  memset(&sa, 0, sizeof(sa));
  sa.sun_family = AF_UNIX;
  snprintf(sa.sun_path, sizeof(sa.sun_path), "%s", sockpath);
  if (connect(fd, (struct sockaddr *)&sa, sizeof(sa)) != 0) {
    fprintf(stderr, "连不上 agent（%s）：%s\n", sockpath, strerror(errno));
    close(fd);
    return 1;
  }
  if (write(fd, req, strlen(req)) < 0 || write(fd, "\n", 1) != 1) { perror("write"); close(fd); return 1; }
  for (;;) {
    ssize_t n = read(fd, resp + len, sizeof(resp) - 1 - len);
    if (n <= 0) break;
    len += (size_t)n;
    if (memchr(resp, '\n', len)) break;
    if (len >= sizeof(resp) - 1) break;
  }
  close(fd);
  resp[len] = 0;
  char *nl = strchr(resp, '\n');
  if (nl) *nl = 0;
  printf("%s\n", resp[0] ? resp : "{\"ok\":false,\"error\":\"no-response\"}");
  return strstr(resp, "\"ok\":true") ? 0 : 1;
}

/* ── main ─────────────────────────────────────────────────────────────── */

static const char *default_socket(void) {
  static char buf[256];
  const char *xdg = getenv("XDG_RUNTIME_DIR");
  if (xdg && *xdg) snprintf(buf, sizeof(buf), "%s/multicc-agent/agent.sock", xdg);
  else snprintf(buf, sizeof(buf), "/run/user/%d/multicc-agent/agent.sock", (int)geteuid());
  return buf;
}

int main(int argc, char **argv) {
  const char *sockpath = NULL;
  int i = 1;

  /* Xlib 内部有点全局状态；每个线程自己一条连接本身是安全的，这一句是买保险。 */
  XInitThreads();
  /* 对端关掉连接后 write 会变成 SIGPIPE —— 默认动作是弄死整个 agent。 */
  signal(SIGPIPE, SIG_IGN);

  for (; i < argc; i++) {
    if (!strcmp(argv[i], "--socket") && i + 1 < argc) sockpath = argv[++i];
    else if (!strcmp(argv[i], "--verbose") || !strcmp(argv[i], "-v")) g_verbose = 1;
    else if (!strcmp(argv[i], "serve") || !strcmp(argv[i], "--serve")) continue;
    else if (!strcmp(argv[i], "--print-socket") || !strcmp(argv[i], "--help") || !strcmp(argv[i], "-h")) {
      printf("%s\n", sockpath ? sockpath : default_socket());
      if (argv[i][1] == 'h') {
        fprintf(stderr,
                "MultiCC Linux agent %s\n"
                "  %s [--socket PATH] [--verbose]   服务模式（前台）\n"
                "  %s --print-socket                打印默认 socket 路径\n"
                "  %s <op> [args]                   CLI 镜像（见 --help 全文）\n",
                AGENT_VERSION, argv[0], argv[0], argv[0]);
      }
      return 0;
    }
    else break;
  }

  if (i < argc) {
    return cli_main(argc - i, argv + i, sockpath ? sockpath : default_socket(), argv[0]);
  }

  if (!sockpath) sockpath = default_socket();

  char err[192] = "";
  int sfd = listen_unix(sockpath, err, sizeof(err));
  if (sfd < 0) { fprintf(stderr, "multicc-agent: %s\n", err); return 1; }

  x11_watch_start(on_esc_edge, lease_held);

  fprintf(stderr, "multicc-agent %s 已启动：%s\n", AGENT_VERSION, sockpath);
  if (g_verbose) {
    const char *disp = getenv("DISPLAY");
    fprintf(stderr, "[agent] DISPLAY=%s\n", disp && *disp ? disp : "(未设置)");
  }

  for (;;) {
    int fd = accept(sfd, NULL, NULL);
    if (fd < 0) {
      if (errno == EINTR) continue;
      fprintf(stderr, "multicc-agent: accept: %s\n", strerror(errno));
      break;
    }
    if (!peer_is_same_uid(fd)) {
      /* 同 uid 之外的连接直接丢：socket 权限其实已经挡住了，这里是第二道。 */
      if (g_verbose) fprintf(stderr, "[agent] 拒绝了一个非本用户的连接\n");
      close(fd);
      continue;
    }
    pthread_mutex_lock(&g_mu);
    int busy = g_conns >= MAX_CONNS;
    if (!busy) g_conns++;
    pthread_mutex_unlock(&g_mu);
    if (busy) { close(fd); continue; }

    pthread_t th;
    if (pthread_create(&th, NULL, conn_main, (void *)(intptr_t)fd) != 0) {
      pthread_mutex_lock(&g_mu);
      g_conns--;
      pthread_mutex_unlock(&g_mu);
      close(fd);
      continue;
    }
    pthread_detach(th);
  }

  close(sfd);
  unlink(sockpath);
  return 0;
}
