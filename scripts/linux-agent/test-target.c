/*
 * 一致性测试的靶子。不是产品的一部分，只给 conformance.sh 用。
 *
 * 两个模式：
 *
 *   multicc-linux-target X Y W H RRGGBB
 *     在 (X,Y) 开一扇 W×H 的纯色窗口、抢到输入焦点，然后盯着事件打日志：
 *       READY
 *       BTN <button> <press|release> <x>,<y>     ← x,y 是窗口内局部坐标
 *       SCROLL <up|down>
 *       MOV <x>,<y>
 *       KEY U+XXXX                               ← 收到的字符（码点）
 *       KEYSYM 0xXXXX                            ← 非字符键（Return、Escape……）
 *       FOCUS in|out
 *
 *   multicc-linux-target --png-has-color FILE RRGGBB
 *     PNG 解码后找这个颜色，找到退出 0，否则 1。
 *
 * 为什么要有真窗口：agent 回 ok:true 只证明「事件发出去了」，证明不了「落在了
 * 该落的地方」—— 坐标域搞错（物理像素 vs 逻辑点）、键码算错、事件发给了没人
 * 聚焦的窗口，这几种错都会一路 ok 到底，直到用户发现鼠标在乱点。
 *
 * 为什么点击要报**局部**坐标：agent 收的是全局坐标，窗口位置是测试自己定的，
 * 于是「全局 (winx+50, winy+50) 点进去 → 局部 (50,50)」把两边的换算关系钉死。
 * 只比全局坐标等于自己发出去的值，等于什么都没验。
 */

#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/keysym.h>
#include <X11/extensions/XTest.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <zlib.h>

/* ── PNG 解码（只认自家编码器写的 8bit truecolor）──────────────────────── */

static unsigned be32(const unsigned char *p) {
  return ((unsigned)p[0] << 24) | ((unsigned)p[1] << 16) | ((unsigned)p[2] << 8) | (unsigned)p[3];
}

static int png_has_color(const char *path, unsigned want) {
  FILE *f = fopen(path, "rb");
  if (!f) { fprintf(stderr, "打不开 %s\n", path); return 2; }
  fseek(f, 0, SEEK_END);
  long sz = ftell(f);
  fseek(f, 0, SEEK_SET);
  if (sz <= 0) { fclose(f); return 2; }
  unsigned char *buf = malloc((size_t)sz);
  if (!buf || fread(buf, 1, (size_t)sz, f) != (size_t)sz) { fclose(f); free(buf); return 2; }
  fclose(f);

  static const unsigned char SIG[8] = { 137, 80, 78, 71, 13, 10, 26, 10 };
  if (sz < 8 || memcmp(buf, SIG, 8)) { free(buf); fprintf(stderr, "不是 PNG\n"); return 2; }

  unsigned w = 0, h = 0;
  unsigned char *idat = NULL;
  size_t idlen = 0;
  for (long off = 8; off + 12 <= sz;) {
    unsigned len = be32(buf + off);
    const char *type = (const char *)(buf + off + 4);
    const unsigned char *data = buf + off + 8;
    if (off + 12 + (long)len > sz) { free(buf); free(idat); return 2; }
    if (!memcmp(type, "IHDR", 4)) {
      if (len < 13) { free(buf); free(idat); return 2; }
      w = be32(data);
      h = be32(data + 4);
      /* 位深/颜色类型不认就明确报错：静默返回「没找到这个颜色」会让
       * 「编码器变了」伪装成「截图是黑的」。 */
      if (data[8] != 8 || data[9] != 2 || data[12] != 0) {
        fprintf(stderr, "只支持 8bit truecolor 非隔行 PNG（拿到 bd=%u ct=%u il=%u）\n",
                data[8], data[9], data[12]);
        free(buf); free(idat); return 2;
      }
    } else if (!memcmp(type, "IDAT", 4)) {
      unsigned char *n = realloc(idat, idlen + len);
      if (!n) { free(buf); free(idat); return 2; }
      idat = n;
      memcpy(idat + idlen, data, len);
      idlen += len;
    } else if (!memcmp(type, "IEND", 4)) {
      break;
    }
    off += 12 + (long)len;
  }
  free(buf);
  if (!idat || !w || !h) { free(idat); return 2; }

  size_t stride = (size_t)w * 3;
  size_t rawlen = (stride + 1) * (size_t)h;
  unsigned char *raw = malloc(rawlen);
  uLongf got = (uLongf)rawlen;
  if (!raw || uncompress(raw, &got, idat, (uLong)idlen) != Z_OK || got != rawlen) {
    free(raw); free(idat); return 2;
  }
  free(idat);

  unsigned char *px = malloc(stride * (size_t)h);   /* 逐行反 filter 的结果 */
  if (!px) { free(raw); return 2; }
  int found = 0;
  for (unsigned y = 0; y < h && !found; y++) {
    const unsigned char *line = raw + (stride + 1) * (size_t)y;
    unsigned char ft = line[0];
    const unsigned char *src = line + 1;
    unsigned char *dst = px + stride * (size_t)y;
    const unsigned char *up = y ? px + stride * (size_t)(y - 1) : NULL;
    for (size_t i = 0; i < stride; i++) {
      unsigned char a = i >= 3 ? dst[i - 3] : 0;          /* 左 */
      unsigned char b = up ? up[i] : 0;                    /* 上 */
      unsigned char c = (up && i >= 3) ? up[i - 3] : 0;    /* 左上 */
      int v = src[i];
      switch (ft) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) / 2; break;
        case 4: {
          int p = a + b - c;
          int pa = p > a ? p - a : a - p;
          int pb = p > b ? p - b : b - p;
          int pc = p > c ? p - c : c - p;
          v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          break;
        }
        default:
          fprintf(stderr, "未知 PNG filter %u\n", ft);
          free(px); free(raw); return 2;
      }
      dst[i] = (unsigned char)(v & 0xff);
    }
    for (unsigned x = 0; x < w; x++) {
      unsigned have = ((unsigned)dst[x * 3] << 16) | ((unsigned)dst[x * 3 + 1] << 8) | dst[x * 3 + 2];
      if (have == want) { found = 1; break; }
    }
  }
  free(px);
  free(raw);
  if (!found) fprintf(stderr, "%ux%u 里没有 #%06x\n", w, h, want);
  return found ? 0 : 1;
}

/* ── 事件靶子 ─────────────────────────────────────────────────────────── */

/* 事件里的键码 → 码点。agent 的中文是「临时改键映射」打出来的，改完就还原，
 * 所以 Xlib 缓存里的映射可能是旧的：先查缓存，查不到就问 server 要一次
 * （一个往返，几微秒），而不是猜。 */
static unsigned key_codepoint(Display *d, XKeyEvent *e) {
  int idx = (e->state & ShiftMask) ? 1 : 0;
  KeySym ks = XLookupKeysym(e, idx);
  if (ks == NoSymbol) {
    int per = 0;
    KeySym *m = XGetKeyboardMapping(d, e->keycode, 1, &per);
    if (m) {
      ks = m[0];
      XFree(m);
    }
  }
  if ((ks & 0xff000000u) == 0x01000000u) return (unsigned)(ks & 0x00ffffffu);
  if (ks != NoSymbol && ks < 0x100) return (unsigned)ks;
  return 0;   /* 非字符键，交给调用方报 keysym */
}

static int run_target(int argc, char **argv) {
  if (argc < 6) { fprintf(stderr, "用法: test-target X Y W H RRGGBB\n"); return 2; }
  int wx = atoi(argv[1]), wy = atoi(argv[2]);
  int ww = atoi(argv[3]), wh = atoi(argv[4]);
  unsigned rgb = (unsigned)strtoul(argv[5], NULL, 16);
  if (ww < 1 || wh < 1) { fprintf(stderr, "尺寸不对\n"); return 2; }

  Display *d = XOpenDisplay(NULL);
  if (!d) { fprintf(stderr, "打不开 DISPLAY\n"); return 2; }
  int scr = DefaultScreen(d);
  Window root = RootWindow(d, scr);
  Colormap cmap = DefaultColormap(d, scr);
  XColor col, exact;
  char spec[16];
  snprintf(spec, sizeof(spec), "#%06x", rgb & 0xffffff);
  if (!XAllocNamedColor(d, cmap, spec, &col, &exact)) { fprintf(stderr, "分不到颜色 %s\n", spec); return 2; }

  XSetWindowAttributes at;
  memset(&at, 0, sizeof(at));
  at.background_pixel = col.pixel;
  at.event_mask = ButtonPressMask | ButtonReleaseMask | KeyPressMask
                  | FocusChangeMask | PointerMotionMask | StructureNotifyMask;
  Window win = XCreateWindow(d, root, wx, wy, (unsigned)ww, (unsigned)wh, 0,
                             CopyFromParent, InputOutput, CopyFromParent,
                             CWBackPixel | CWEventMask, &at);

  /* 故意不打 WM 提示、不请 WM 装饰：测试要在没有窗口管理器的 Xvfb 里也成立，
   * 而 XSetInputFocus 的落点就是「谁拿到键盘」。 */
  XStoreName(d, win, "multicc-target");
  /* 第 6 个参数给 WM_CLASS：用来扮成「敏感窗口」（gnome-control-center 之类），
   * 验证 agent 只挡打字、不挡点击。 */
  if (argc >= 7 && argv[6][0]) {
    XClassHint h;
    h.res_name = argv[6];
    h.res_class = argv[6];
    XSetClassHint(d, win, &h);
  }
  XMapWindow(d, win);
  XSetInputFocus(d, win, RevertToParent, CurrentTime);
  XSync(d, False);

  printf("READY\n");
  fflush(stdout);

  for (;;) {
    XEvent ev;
    XNextEvent(d, &ev);
    switch (ev.type) {
      case ButtonPress:
      case ButtonRelease: {
        int down = ev.type == ButtonPress;
        if (ev.xbutton.button == Button4 || ev.xbutton.button == Button5) {
          if (down) printf("SCROLL %s\n", ev.xbutton.button == Button4 ? "up" : "down");
        } else {
          printf("BTN %u %s %d,%d\n", ev.xbutton.button, down ? "press" : "release",
                 ev.xbutton.x, ev.xbutton.y);
        }
        break;
      }
      case MotionNotify:
        printf("MOV %d,%d\n", ev.xmotion.x, ev.xmotion.y);
        break;
      case KeyPress: {
        unsigned cp = key_codepoint(d, &ev.xkey);
        if (cp) printf("KEY U+%04X\n", cp);
        else printf("KEYSYM 0x%04lx\n", (unsigned long)XLookupKeysym(&ev.xkey, 0));
        break;
      }
      case FocusIn:  printf("FOCUS in\n");  break;
      case FocusOut: printf("FOCUS out\n"); break;
      default: continue;
    }
    fflush(stdout);
  }
}

/* 从**另一个进程**敲一下键 —— 用来演「用户自己按了 Esc」。
 * 必须另起进程：agent 自己发的键会被它标成「注入中」，不算急停。
 *
 * 默认按住 120ms 再松：XTEST 的 press+release 连着发，键只按下几微秒，那是任何轮询
 * 都测不准的（真人也按不这么快，机械键盘自己就要几十毫秒）。这个时长让这里测的
 * 是「观察线程能不能看到真人按键」，而不是「能不能撞上一次幸运采样」。
 * 时长可由第二个参数覆盖（--key Escape 1500），用来区分「采样太疏漏掉了」和
 * 「这个边沿根本不可见」—— 前者拉长就一定能抓到。 */
static int send_key(const char *name, int hold_ms) {
  Display *d = XOpenDisplay(NULL);
  if (!d) { fprintf(stderr, "打不开 DISPLAY\n"); return 2; }
  KeySym ks = XStringToKeysym(name);
  if (ks == NoSymbol) { fprintf(stderr, "未知按键 %s\n", name); XCloseDisplay(d); return 2; }
  KeyCode kc = XKeysymToKeycode(d, ks);
  if (!kc) { fprintf(stderr, "%s 没有对应键码\n", name); XCloseDisplay(d); return 2; }
  XTestFakeKeyEvent(d, kc, True, CurrentTime);
  XSync(d, False);
  usleep((useconds_t)hold_ms * 1000);
  XTestFakeKeyEvent(d, kc, False, CurrentTime);
  XSync(d, False);
  XCloseDisplay(d);
  return 0;
}

int main(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "--png-has-color") == 0) {
    if (argc < 4) { fprintf(stderr, "用法: --png-has-color FILE RRGGBB\n"); return 2; }
    return png_has_color(argv[2], (unsigned)strtoul(argv[3], NULL, 16));
  }
  if (argc >= 3 && strcmp(argv[1], "--key") == 0) {
    int hold = argc >= 4 ? atoi(argv[3]) : 120;
    if (hold <= 0) hold = 120;
    return send_key(argv[2], hold);
  }
  return run_target(argc, argv);
}
