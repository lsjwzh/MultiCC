/*
 * X11 侧的全部动作：截图、注入、锁屏/敏感窗口判断、Esc 观察。
 *
 * 三条设计决定：
 *
 * 1. **每个线程自己一条 Display 连接**。服务端本来就是「一次 op 一条 unix
 *    socket」，这里跟着一条 X 连接，于是不需要给 Xlib 加锁，也不需要担心两条
 *    连接共享状态。（main 里仍会调一次 XInitThreads：它让 Xlib 自己那点全局
 *    状态变安全，代价是零。）
 *
 * 2. **截图判据是像素，不是返回值**。容器 / 无头环境里 MIT-SHM 会「调用成功但
 *    整帧全黑」，只判 Status 会把黑屏当成功。见 probe.c 的同名结论。
 *
 * 3. **锁屏判断是尽力而为，而且我们知道它不完美**。X11 没有「现在锁了没有」
 *    这种一等查询，只能靠焦点窗口的 WM_CLASS + XScreenSaver 扩展侧写。判错的
 *    代价不对称：把「锁着」误判成「没锁」会把注入打到锁屏窗口上（绝不能发生），
 *    把「没锁」误判成「锁着」只是多点一次不动。所以判据偏保守，并把依据写进
 *    status（`lockCheck`），现场好排查。
 */

#define _GNU_SOURCE
#include "agent.h"

#include <X11/Xatom.h>
#include <X11/XKBlib.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/XShm.h>
#include <X11/extensions/XTest.h>
#include <X11/extensions/scrnsaver.h>
#include <X11/keysym.h>

#include <ctype.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ipc.h>
#include <sys/shm.h>
#include <time.h>
#include <unistd.h>

static __thread Display *tdpy = NULL;
static __thread char terr[192] = "";

/* 「这一轮注入里我们自己发了 Escape」：x11_press 打标记，Esc 观察线程据此把那
 * 一次下降沿排除在急停之外（详细理由见观察线程那一段的注释）。 */
static volatile int g_self_esc = 0;

const char *x11_last_error(void) { return terr; }

static void fail(const char *msg) { snprintf(terr, sizeof(terr), "%s", msg); }

int x11_open(char *err, size_t errsz) {
  if (tdpy) return 1;
  const char *disp = getenv("DISPLAY");
  tdpy = XOpenDisplay(NULL);
  if (!tdpy) {
    snprintf(terr, sizeof(terr), "x11-open-failed: DISPLAY=%s", disp && *disp ? disp : "(unset)");
    if (err) snprintf(err, errsz, "%s", terr);
    return 0;
  }
  return 1;
}

void x11_close(void) {
  if (tdpy) { XCloseDisplay(tdpy); tdpy = NULL; }
}

int x11_screen_size(int *w, int *h) {
  if (!tdpy) return 0;
  int scr = DefaultScreen(tdpy);
  *w = DisplayWidth(tdpy, scr);
  *h = DisplayHeight(tdpy, scr);
  return *w > 0 && *h > 0;
}

/* ── 截图 ─────────────────────────────────────────────────────────────── */

void shot_free(shot *s) {
  if (!s) return;
  free(s->rgb);
  free(s);
}

/* XImage → packed RGB。24/32 位 TrueColor 走直拷（X11 桌面上的绝大多数情况），
 * 其余退到 XGetPixel + 掩码换算。
 * Visual 得由调用方传：XImage 里没有这个字段（结构体只有 depth/masks/data 那些），
 * 掩码得从创建这张图时用的那个 Visual 拿。 */
static void to_rgb(XImage *img, Visual *v, unsigned char *out) {
  int fast = img->bits_per_pixel == 32 && img->byte_order == LSBFirst
             && v->red_mask == 0xff0000UL && v->green_mask == 0xff00UL && v->blue_mask == 0xffUL;
  if (fast) {
    for (int y = 0; y < img->height; y++) {
      const unsigned char *row = (const unsigned char *)img->data + (size_t)y * (size_t)img->bytes_per_line;
      unsigned char *dst = out + (size_t)y * (size_t)img->width * 3;
      for (int x = 0; x < img->width; x++) {
        dst[x * 3 + 0] = row[x * 4 + 2]; /* R：X11 32bpp 小端是 B,G,R,X */
        dst[x * 3 + 1] = row[x * 4 + 1];
        dst[x * 3 + 2] = row[x * 4 + 0];
      }
    }
    return;
  }
  int rs = 0, gs = 0, bs = 0;
  unsigned long rm = v->red_mask, gm = v->green_mask, bm = v->blue_mask;
  while (rm && !(rm & 1UL)) { rm >>= 1; rs++; }
  while (gm && !(gm & 1UL)) { gm >>= 1; gs++; }
  while (bm && !(bm & 1UL)) { bm >>= 1; bs++; }
  for (int y = 0; y < img->height; y++) {
    unsigned char *dst = out + (size_t)y * (size_t)img->width * 3;
    for (int x = 0; x < img->width; x++) {
      unsigned long p = XGetPixel(img, x, y);
      dst[x * 3 + 0] = (unsigned char)(((p & v->red_mask) >> rs) & 0xff);
      dst[x * 3 + 1] = (unsigned char)(((p & v->green_mask) >> gs) & 0xff);
      dst[x * 3 + 2] = (unsigned char)(((p & v->blue_mask) >> bs) & 0xff);
    }
  }
}

shot *x11_capture(char *err, size_t errsz) {
  if (!tdpy) { fail("no-display"); if (err) snprintf(err, errsz, "%s", terr); return NULL; }
  Display *d = tdpy;
  int scr = DefaultScreen(d);
  Window root = RootWindow(d, scr);
  int w = DisplayWidth(d, scr), h = DisplayHeight(d, scr);

  XImage *img = NULL;
  XShmSegmentInfo shm;
  int have_shm = 0, attached = 0;
  memset(&shm, 0, sizeof(shm));
  shm.shmid = -1;

  if (w <= 0 || h <= 0) { fail("bad-screen-size"); if (err) snprintf(err, errsz, "%s", terr); return NULL; }

  if (XShmQueryExtension(d)) {
    img = XShmCreateImage(d, DefaultVisual(d, scr), (unsigned)DefaultDepth(d, scr), ZPixmap,
                          NULL, &shm, (unsigned)w, (unsigned)h);
    if (img) {
      shm.shmid = shmget(IPC_PRIVATE, (size_t)img->bytes_per_line * (size_t)img->height,
                         IPC_CREAT | 0600);
      if (shm.shmid >= 0) {
        shm.shmaddr = img->data = shmat(shm.shmid, NULL, 0);
        if (img->data != (char *)-1) {
          shm.readOnly = False;
          if (XShmAttach(d, &shm)) { attached = 1; have_shm = 1; }
          else {
            /* attach 失败也要把段删掉：IPC_PRIVATE 的段不会自己消失，
             * 每失败一次漏一块，agent 是长驻进程。 */
            shmdt(shm.shmaddr);
            shmctl(shm.shmid, IPC_RMID, NULL);
            img->data = NULL;
            XDestroyImage(img);
            img = NULL;
          }
        } else { img->data = NULL; XDestroyImage(img); img = NULL; shmctl(shm.shmid, IPC_RMID, NULL); }
      } else { XDestroyImage(img); img = NULL; }
    }
  }

  int got = 0;
  if (have_shm) {
    XSync(d, False);
    got = XShmGetImage(d, root, img, 0, 0, AllPlanes);
  }

  if (!got) {
    /* 回退路：慢，但容器里 MIT-SHM 常被禁，这条必须能用。 */
    if (have_shm) {
      XShmDetach(d, &shm);
      shmdt(shm.shmaddr);
      shmctl(shm.shmid, IPC_RMID, NULL);
      img->data = NULL; /* 别让 XDestroyImage 去 free 共享内存 */
      XDestroyImage(img);
      have_shm = attached = 0;
      img = NULL;
    }
    img = XGetImage(d, root, 0, 0, (unsigned)w, (unsigned)h, AllPlanes, ZPixmap);
    if (!img) { fail("capture-failed"); if (err) snprintf(err, errsz, "%s", terr); return NULL; }
  }

  shot *s = calloc(1, sizeof(*s));
  if (!s) { fail("out-of-memory"); }
  else {
    s->rgb = malloc((size_t)w * (size_t)h * 3);
    if (!s->rgb) { fail("out-of-memory"); free(s); s = NULL; }
    else { s->w = w; s->h = h; to_rgb(img, DefaultVisual(d, scr), s->rgb); }
  }

  if (have_shm) {
    XShmDetach(d, &shm);
    shmdt(shm.shmaddr);
    shmctl(shm.shmid, IPC_RMID, NULL);
    img->data = NULL;
    XDestroyImage(img);
  } else {
    XDestroyImage(img);
  }

  if (!s && err) snprintf(err, errsz, "%s", terr);
  return s;
}

/* 裁剪（区域已在逻辑点域，X11 上逻辑点 == 像素，所以直接切）。 */
shot *shot_crop(const shot *src, int x, int y, int w, int h, char *err, size_t errsz) {
  if (x < 0 || y < 0 || w < 1 || h < 1 || x + w > src->w || y + h > src->h) {
    snprintf(err, errsz, "region-outside-screen");
    return NULL;
  }
  shot *s = calloc(1, sizeof(*s));
  if (!s) { snprintf(err, errsz, "out-of-memory"); return NULL; }
  s->w = w;
  s->h = h;
  s->rgb = malloc((size_t)w * (size_t)h * 3);
  if (!s->rgb) { free(s); snprintf(err, errsz, "out-of-memory"); return NULL; }
  for (int row = 0; row < h; row++) {
    memcpy(s->rgb + (size_t)row * (size_t)w * 3,
           src->rgb + ((size_t)(y + row) * (size_t)src->w + (size_t)x) * 3,
           (size_t)w * 3);
  }
  return s;
}

/* ── 注入 ─────────────────────────────────────────────────────────────── */

static void nap_ms(int ms) {
  if (ms > 0) usleep((useconds_t)ms * 1000);
}

int x11_move(int x, int y) {
  if (!tdpy) { fail("no-display"); return 0; }
  XTestFakeMotionEvent(tdpy, -1, x, y, CurrentTime);
  XSync(tdpy, False);
  return 1;
}

int x11_click(int x, int y, int button, int count) {
  if (!tdpy) { fail("no-display"); return 0; }
  if (!x11_move(x, y)) return 0;
  nap_ms(20);
  for (int i = 0; i < count; i++) {
    XTestFakeButtonEvent(tdpy, (unsigned)button, True, CurrentTime);
    XSync(tdpy, False);
    nap_ms(12);
    XTestFakeButtonEvent(tdpy, (unsigned)button, False, CurrentTime);
    XSync(tdpy, False);
    if (i + 1 < count) nap_ms(60); /* 双击间隔 */
  }
  return 1;
}

/* amount > 0 **向上**滚，< 0 向下 —— 这是契约的方向，跟 macOS 那份对齐
 * （那边 wheel1 为正 / RFB button 4 也是向上），不要按 X11 的直觉来。
 *
 * 落到 X11 上要换成按钮：**4 = 上，5 = 下**，正好和契约反着，所以这里的映射
 * 写反了会变成一个「不报错、只是滚反了」的故障。X11 一次滚轮 = 一次按键，
 * 于是把「格子数」映射成有限次点击 —— 上限 20 是防呆：服务端允许 amount 到
 * ±50，真按 50 次会把页面滚飞。 */
int x11_scroll(int x, int y, int amount) {
  if (!tdpy) { fail("no-display"); return 0; }
  if (!x11_move(x, y)) return 0;
  int n = amount < 0 ? -amount : amount;
  if (n > 20) n = 20;
  unsigned btn = amount < 0 ? 5u : 4u;
  for (int i = 0; i < n; i++) {
    XTestFakeButtonEvent(tdpy, btn, True, CurrentTime);
    XTestFakeButtonEvent(tdpy, btn, False, CurrentTime);
    XSync(tdpy, False);
    nap_ms(14);
  }
  return 1;
}

int x11_drag(int x, int y, int x2, int y2, int ms) {
  if (!tdpy) { fail("no-display"); return 0; }
  if (ms < 80) ms = 80;
  if (ms > 3000) ms = 3000;
  XTestFakeMotionEvent(tdpy, -1, x, y, CurrentTime);
  XSync(tdpy, False);
  nap_ms(30);
  XTestFakeButtonEvent(tdpy, 1, True, CurrentTime);
  XSync(tdpy, False);
  int steps = ms / 16;
  if (steps < 4) steps = 4;
  for (int i = 1; i <= steps; i++) {
    int cx = x + (x2 - x) * i / steps;
    int cy = y + (y2 - y) * i / steps;
    XTestFakeMotionEvent(tdpy, -1, cx, cy, CurrentTime);
    XSync(tdpy, False);
    nap_ms(ms / steps);
  }
  XTestFakeButtonEvent(tdpy, 1, False, CurrentTime);
  XSync(tdpy, False);
  return 1;
}

/* 在键映射里找一个能产生 ks 的键码；顺便告诉调用方要不要按 Shift。
 * 直接问 X 比查表靠谱：用户换过布局、改过键都能对上。 */
static int find_keycode(Display *d, KeySym ks, KeyCode *kc, int *need_shift) {
  if (ks == NoSymbol) return 0;
  int min_kc = 0, max_kc = 0;
  XDisplayKeycodes(d, &min_kc, &max_kc);
  for (int k = min_kc; k <= max_kc; k++) {
    if (XkbKeycodeToKeysym(d, (KeyCode)k, 0, 0) == ks) { *kc = (KeyCode)k; *need_shift = 0; return 1; }
  }
  for (int k = min_kc; k <= max_kc; k++) {
    if (XkbKeycodeToKeysym(d, (KeyCode)k, 0, 1) == ks) { *kc = (KeyCode)k; *need_shift = 1; return 1; }
  }
  return 0;
}

/* 一次「按下 + 松开」，必要时带 Shift。 */
static int tap_keycode(Display *d, KeyCode kc, int need_shift) {
  KeyCode shift = XKeysymToKeycode(d, XK_Shift_L);
  if (need_shift) { XTestFakeKeyEvent(d, shift, True, CurrentTime); XSync(d, False); }
  XTestFakeKeyEvent(d, kc, True, CurrentTime);
  XTestFakeKeyEvent(d, kc, False, CurrentTime);
  XSync(d, False);
  if (need_shift) { XTestFakeKeyEvent(d, shift, False, CurrentTime); XSync(d, False); }
  return 1;
}

/* 非 ASCII 码点（中文、emoji……）：XTEST 只能发键码，发不出「字符」。
 * 老办法（xdotool 同款）：挑一个没人映射的键码，临时把它映射成 Unicode
 * keysym，按一下。
 *
 * 两个地方和「教科书版本」不同：
 *   · **还原推迟到整串输完之后**。按一下还原一次的话，接收方收到 KeyPress 后
 *     去反查 keysym 时映射可能已经变回去了（中文就变成「输进去了但对方认不出」
 *     这种最难查的故障）。代价是这几十毫秒里那个键位的映射是临时的 —— 用本来
 *     就没人映射的键码，影响面最小。
 *   · **轮换一小撮空闲键码**，而不是每按一次来回改同一个。同一个键码反复改会
 *     给所有客户端刷 MappingNotify，中文长句能把别的程序刷到卡。 */
#define SPARE_SLOTS 4

typedef struct {
  KeyCode kc[SPARE_SLOTS];
  unsigned cp[SPARE_SLOTS];   /* 当前映射成哪个码点，0 = 空位 */
  KeySym orig[SPARE_SLOTS][2];
  int used;
} keymap_pool;

static void pool_init(Display *d, keymap_pool *pool) {
  memset(pool, 0, sizeof(*pool));
  int min_kc = 0, max_kc = 0;
  XDisplayKeycodes(d, &min_kc, &max_kc);
  for (int k = max_kc; k >= min_kc && pool->used < SPARE_SLOTS; k--) {
    if (XkbKeycodeToKeysym(d, (KeyCode)k, 0, 0) == NoSymbol
        && XkbKeycodeToKeysym(d, (KeyCode)k, 0, 1) == NoSymbol) {
      pool->kc[pool->used] = (KeyCode)k;
      pool->orig[pool->used][0] = NoSymbol;
      pool->orig[pool->used][1] = NoSymbol;
      pool->used++;
    }
  }
}

static void pool_restore(Display *d, keymap_pool *pool) {
  int touched = 0;
  for (int i = 0; i < pool->used; i++) {
    if (!pool->cp[i]) continue;
    XChangeKeyboardMapping(d, pool->kc[i], 2, pool->orig[i], 1);
    pool->cp[i] = 0;
    touched = 1;
  }
  if (touched) { XSync(d, False); nap_ms(4); }
}

static int pool_type(Display *d, keymap_pool *pool, unsigned cp) {
  if (!pool->used) return 0;
  int slot = -1;
  for (int i = 0; i < pool->used; i++) {
    if (pool->cp[i] == cp) { slot = i; break; }          /* 同一个字复用它 */
  }
  if (slot < 0) {
    slot = pool->used > 0 ? (int)(cp % (unsigned)pool->used) : 0;  /* 轮换，别老改同一个 */
    KeySym tmp[2] = { (KeySym)(0x01000000u | cp), (KeySym)(0x01000000u | cp) };
    if (pool->cp[slot]) { XChangeKeyboardMapping(d, pool->kc[slot], 2, pool->orig[slot], 1); }
    XChangeKeyboardMapping(d, pool->kc[slot], 2, tmp, 1);
    pool->cp[slot] = cp;
    XSync(d, False);
    nap_ms(14); /* 让 X server 把新映射推下去并稳定 */
  }
  XTestFakeKeyEvent(d, pool->kc[slot], True, CurrentTime);
  XTestFakeKeyEvent(d, pool->kc[slot], False, CurrentTime);
  XSync(d, False);
  return 1;
}

/* UTF-8 → 逐个码点。ASCII 走正常键码，其余走临时重映射。 */
int x11_type(const char *utf8) {
  if (!tdpy) { fail("no-display"); return 0; }
  Display *d = tdpy;
  const unsigned char *p = (const unsigned char *)utf8;
  keymap_pool pool;
  int bad = 0;

  pool_init(d, &pool);

  while (*p) {
    unsigned cp = 0;
    int extra = 0;
    if (p[0] < 0x80) { cp = p[0]; }
    else if ((p[0] & 0xE0) == 0xC0) { cp = p[0] & 0x1Fu; extra = 1; }
    else if ((p[0] & 0xF0) == 0xE0) { cp = p[0] & 0x0Fu; extra = 2; }
    else if ((p[0] & 0xF8) == 0xF0) { cp = p[0] & 0x07u; extra = 3; }
    else { p++; continue; } /* 非法字节：跳过而不是中断整段输入 */
    for (int i = 1; i <= extra; i++) {
      if ((p[i] & 0xC0) != 0x80) { cp = 0; break; }
      cp = (cp << 6) | (unsigned)(p[i] & 0x3Fu);
    }
    if (!cp) { p++; continue; }
    p += 1 + extra;

    if (cp < 0x80) {
      KeyCode kc = 0;
      int shift = 0;
      KeySym ks = (KeySym)cp;
      if (find_keycode(d, ks, &kc, &shift)) {
        tap_keycode(d, kc, shift);
      } else {
        /* ASCII 但当前布局打不出来（不是 US 布局）：同样借重映射。 */
        if (!pool_type(d, &pool, cp)) bad = 1;
      }
    } else if (!pool_type(d, &pool, cp)) {
      bad = 1;
    }
    nap_ms(10);
  }

  /* 映射的还原放在整串输完之后 —— 见上面 pool 的注释。哪怕中途出错也要还原，
   * 否则会把一个临时键位留在用户的键盘里。 */
  pool_restore(d, &pool);
  if (bad) {
    snprintf(terr, sizeof(terr), "cannot-type-codepoint");
    return 0;
  }
  return 1;
}

/* tok 的前 len 个字节是不是等于名字 n（ASCII 大小写不敏感）。 */
static int ci_eq(const char *n, const char *tok, size_t len) {
  if (strlen(n) != len) return 0;
  for (size_t i = 0; i < len; i++) {
    char a = n[i], b = tok[i];
    if (a >= 'A' && a <= 'Z') a = (char)(a - 'A' + 'a');
    if (b >= 'A' && b <= 'Z') b = (char)(b - 'A' + 'a');
    if (a != b) return 0;
  }
  return 1;
}

/* "ctrl+shift+a" / "ctrl+c" / "Return"。服务端保证 ≤40 字符、不含空格。 */
static KeySym named_keysym(const char *tok, size_t len) {
  static const struct { const char *n; KeySym ks; } TABLE[] = {
    { "ctrl", XK_Control_L }, { "control", XK_Control_L }, { "alt", XK_Alt_L },
    { "shift", XK_Shift_L }, { "cmd", XK_Super_L }, { "super", XK_Super_L },
    { "meta", XK_Super_L }, { "win", XK_Super_L }, { "return", XK_Return },
    { "enter", XK_Return }, { "esc", XK_Escape }, { "escape", XK_Escape },
    { "tab", XK_Tab }, { "space", XK_space }, { "backspace", XK_BackSpace },
    { "delete", XK_Delete }, { "del", XK_Delete }, { "up", XK_Up }, { "down", XK_Down },
    { "left", XK_Left }, { "right", XK_Right }, { "home", XK_Home }, { "end", XK_End },
    { "pageup", XK_Page_Up }, { "pagedown", XK_Page_Down }, { "insert", XK_Insert },
    { "minus", XK_minus }, { "plus", XK_plus }, { "equal", XK_equal },
    { "comma", XK_comma }, { "period", XK_period }, { "slash", XK_slash },
    { "semicolon", XK_semicolon }, { "apostrophe", XK_apostrophe },
    { "backslash", XK_backslash }, { "grave", XK_grave }, { "bracketleft", XK_bracketleft },
    { "bracketright", XK_bracketright },
  };
  /* 大小写不敏感：契约里同一个键两种写法都出现过（`ctrl+c` 是全小写，
   * 而功能键是 `Return`），表里只写一份小写、这里统一折叠。 */
  for (size_t i = 0; i < sizeof(TABLE) / sizeof(TABLE[0]); i++) {
    if (ci_eq(TABLE[i].n, tok, len)) return TABLE[i].ks;
  }
  if (len >= 2 && (tok[0] == 'f' || tok[0] == 'F') && tok[1] >= '1' && tok[1] <= '9') {
    int n = atoi(tok + 1);
    if (n >= 1 && n <= 12) return XK_F1 + (n - 1);
  }
  return NoSymbol;
}

int x11_press(const char *keys) {
  if (!tdpy) { fail("no-display"); return 0; }
  Display *d = tdpy;

  KeyCode codes[8];
  int shifts[8];
  KeyCode kc;
  int sh = 0;
  int n = 0;

  const char *p = keys;
  while (*p && n < 8) {
    const char *plus = strchr(p, '+');
    size_t len = plus ? (size_t)(plus - p) : strlen(p);
    if (len) {
      char tok[24];
      if (len >= sizeof(tok)) len = sizeof(tok) - 1;
      memcpy(tok, p, len);
      tok[len] = 0;

      KeySym ks = named_keysym(tok, len);
      if (ks == NoSymbol) {
        /* 我们那张表只管常用键（以及 "enter"/"esc" 这类别名）；剩下的一律交给
         * Xlib 自己的键名表 —— Return / Escape / Left / Page_Up / F1… 那张是全的，
         * 但**大小写敏感**（"Return" 查得到、"return" 查不到），所以才需要先过一遍
         * 我们这张折叠过大小写的。单字符也归这条：XStringToKeysym("a") 就是 XK_a，
         * "!" 这类符号它按 Latin-1 直接给出码点。 */
        ks = XStringToKeysym(tok);
      }
      if (ks == NoSymbol) { snprintf(terr, sizeof(terr), "unknown-key '%s'", tok); return 0; }
      /* 记下「这一次注入里我们自己发了 Escape」：观察线程只把这种情况排除在急停之外
       * （见 g_self_esc）。 */
      if (ks == XK_Escape) g_self_esc = 1;
      if (!find_keycode(d, ks, &kc, &sh)) {
        /* 有些符号（比如 '+'）只在 level 0 的某个键上，直接按 keysym 反查失败时
         * 用 XKeysymToKeycode 兜底，它认标准键盘表。 */
        kc = XKeysymToKeycode(d, ks);
        sh = 0;
        if (!kc) { snprintf(terr, sizeof(terr), "no-keycode-for '%s'", tok); return 0; }
      }
      codes[n] = kc;
      shifts[n] = sh;
      n++;
    }
    if (!plus) break;
    p = plus + 1;
  }
  if (!n) { fail("empty-keys"); return 0; }

  /* 修饰键先按下（数组里靠前的就是修饰键：服务端拼的是 "ctrl+c" 这种顺序），
   * 主键最后按、最先松。倒序释放，避免组合键半路失效。 */
  for (int i = 0; i < n; i++) {
    if (shifts[i]) XTestFakeKeyEvent(d, XKeysymToKeycode(d, XK_Shift_L), True, CurrentTime);
    XTestFakeKeyEvent(d, codes[i], True, CurrentTime);
    XSync(d, False);
    nap_ms(12);
  }
  for (int i = n - 1; i >= 0; i--) {
    XTestFakeKeyEvent(d, codes[i], False, CurrentTime);
    if (shifts[i]) XTestFakeKeyEvent(d, XKeysymToKeycode(d, XK_Shift_L), False, CurrentTime);
    XSync(d, False);
    nap_ms(8);
  }
  return 1;
}

/* 兜底。注入中途出错 / 连接断掉时，修饰键可能还按着 —— 那种状态下用户整个
 * 桌面都是坏的（比如一直 Ctrl）。release / resume 时顺手松开。 */
int x11_release_all(void) {
  if (!tdpy) return 0;
  static const KeySym MODS[] = { XK_Control_L, XK_Control_R, XK_Shift_L, XK_Shift_R,
                                 XK_Alt_L, XK_Alt_R, XK_Super_L, XK_Super_R };
  for (size_t i = 0; i < sizeof(MODS) / sizeof(MODS[0]); i++) {
    KeyCode kc = XKeysymToKeycode(tdpy, MODS[i]);
    if (kc) XTestFakeKeyEvent(tdpy, kc, False, CurrentTime);
  }
  XTestFakeButtonEvent(tdpy, 1, False, CurrentTime);
  XTestFakeButtonEvent(tdpy, 2, False, CurrentTime);
  XTestFakeButtonEvent(tdpy, 3, False, CurrentTime);
  XSync(tdpy, False);
  return 1;
}

/* ── 锁屏 / 敏感窗口 ──────────────────────────────────────────────────── */

/* 已知的锁屏程序。判据是 WM_CLASS 里的子串（大小写不敏感）。 */
static const char *LOCKERS[] = {
  "gnome-screensaver", "gnome-shell", "gsd-", "light-locker", "lightdm",
  "xscreensaver", "xfce4-screensaver", "mate-screensaver", "cinnamon-screensaver",
  "i3lock", "slock", "kscreenlocker", "ksmserver", "unity-screensaver",
  "gdm", "sddm", "lxdm", "swaylock", "hyprlock", NULL,
};
/* 已知的「要密码 / 改系统设置」的窗口：这些上面拒绝自动输入。 */
static const char *SENSITIVE[] = {
  "gnome-control-center", "systemsettings", "gnome-keyring-prompt", "gcr-prompter",
  "polkit-gnome-authentication-agent", "polkit-kde-authentication-agent",
  "seahorse", "gnome-initial-setup", "gparted", "timeshift", NULL,
};

static int ci_contains(const char *hay, const char *needle) {
  if (!hay || !needle || !*needle) return 0;
  size_t nl = strlen(needle);
  for (const char *p = hay; *p; p++) {
    size_t i = 0;
    while (i < nl && p[i] && (char)tolower((unsigned char)p[i]) == (char)tolower((unsigned char)needle[i])) i++;
    if (i == nl) return 1;
  }
  return 0;
}

static int match_any(const char *cls, const char *const *list) {
  for (int i = 0; list[i]; i++) {
    if (ci_contains(cls, list[i])) return 1;
  }
  return 0;
}

/* 焦点窗口通常是某个子窗口，WM_CLASS 挂在顶层。往上走到 root 的直接子窗口。 */
static Window toplevel_of(Display *d, Window w) {
  Window root = DefaultRootWindow(d);
  for (int guard = 0; guard < 64 && w != None && w != root; guard++) {
    Window r = None, parent = None, *kids = NULL;
    unsigned nkids = 0;
    if (!XQueryTree(d, w, &r, &parent, &kids, &nkids)) return w;
    if (kids) XFree(kids);
    if (parent == None || parent == root) return w;
    w = parent;
  }
  return w;
}

static int window_class(Display *d, Window w, char *out, size_t cap) {
  out[0] = 0;
  XClassHint hint;
  memset(&hint, 0, sizeof(hint));
  if (XGetClassHint(d, w, &hint)) {
    snprintf(out, cap, "%s %s", hint.res_name ? hint.res_name : "",
             hint.res_class ? hint.res_class : "");
    if (hint.res_name) XFree(hint.res_name);
    if (hint.res_class) XFree(hint.res_class);
    if (out[0]) return 1;
  }
  /* 有些合成器只留 _NET_WM_NAME。 */
  Atom net_name = XInternAtom(d, "_NET_WM_NAME", True);
  Atom utf8 = XInternAtom(d, "UTF8_STRING", True);
  if (net_name != None && utf8 != None) {
    XTextProperty tp;
    memset(&tp, 0, sizeof(tp));
    if (XGetTextProperty(d, w, &tp, net_name) && tp.nitems > 0) {
      snprintf(out, cap, "%s", (const char *)tp.value);
      if (tp.value) XFree(tp.value);
      return out[0] != 0;
    }
  }
  return 0;
}

int x11_screen_locked(const char **how) {
  if (how) *how = "none";
  if (!tdpy) return 0;
  Display *d = tdpy;

  Window focus = None;
  int revert = 0;
  XGetInputFocus(d, &focus, &revert);
  Window top = (focus == None || focus == PointerRoot) ? None : toplevel_of(d, focus);
  char cls[256];
  if (top != None && window_class(d, top, cls, sizeof(cls))) {
    /* 这里**只**判锁屏。敏感窗口是另一回事（只挡打字，不挡点），由
     * x11_focus_is_sensitive 单独报 —— 两件事混在一起的话，点一下控制中心
     * 会收到「屏幕已锁」这种把人带偏的错。 */
    if (match_any(cls, LOCKERS)) { if (how) *how = "focus-class"; return 1; }
  }

  /* XScreenSaver 扩展：state=On 且 kind 不是单纯「熄屏」时，认为有人在锁屏。
   * 只熄屏（DPMS blank）不算锁 —— 那种情况下注入本来就该把屏幕叫醒。 */
  int ev = 0, err = 0;
  if (XScreenSaverQueryExtension(d, &ev, &err)) {
    XScreenSaverInfo *info = XScreenSaverAllocInfo();
    if (info) {
      if (XScreenSaverQueryInfo(d, DefaultRootWindow(d), info)) {
        int on = info->state == ScreenSaverOn;
        int blank_only = info->kind == ScreenSaverBlanked;
        XFree(info);
        if (on && !blank_only) { if (how) *how = "screensaver"; return 1; }
        if (how) *how = blank_only ? "screensaver-blanked" : "screensaver-off";
        return 0;
      }
      XFree(info);
    }
  }
  if (how) *how = "focus-clean";
  return 0;
}

int x11_focus_is_sensitive(void) {
  if (!tdpy) return 0;
  Window focus = None;
  int revert = 0;
  XGetInputFocus(tdpy, &focus, &revert);
  if (focus == None || focus == PointerRoot) return 0;
  Window top = toplevel_of(tdpy, focus);
  char cls[256];
  if (!window_class(tdpy, top, cls, sizeof(cls))) return 0;
  return match_any(cls, SENSITIVE);
}

/* ── Esc 观察 ─────────────────────────────────────────────────────────── */

static pthread_t g_watch;
static volatile int g_watch_run = 0;
static volatile int g_injecting = 0;
/* g_self_esc（文件头上声明）在这里被消费：注入期间照样采样键态，只把「我们自己
 * 刚发的那个 Escape」的下降沿排除掉。早先的写法是「整段注入窗口一律当成按着
 * Esc」，那会让一次点击/打字后面的真急停被吞掉 —— 注入期间 prev 被强行置 1，
 * 注入结束后的第一次采样看到 Esc 已经按下，「down=1 && prev=1」不成边沿。 */
static int (*g_on_esc)(void) = NULL;
static int (*g_lease_active)(void) = NULL;

/* 观察线程睡在条件变量上，为的是能被叫醒（理由见 ESC_POLL_IDLE_US 那段注释）。
 * 谁负责叫醒：任何「有人在操作了」的动作 —— 开始注入、拿到租约。 */
static pthread_mutex_t g_sleep_mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t g_sleep_cv = PTHREAD_COND_INITIALIZER;

void x11_watch_nudge(void) {
  pthread_mutex_lock(&g_sleep_mu);
  pthread_cond_broadcast(&g_sleep_cv);
  pthread_mutex_unlock(&g_sleep_mu);
}

void x11_injecting(int on) {
  if (!on) { g_injecting = 0; return; }
  g_injecting = 1;
  g_self_esc = 0;      /* 新一轮注入，先忘掉上一轮「我们自己发过 Esc」的印象 */
  x11_watch_nudge();   /* 有人在操作：立刻从空闲档切快档 */
}

/* 轮询间隔按「有没有人在操作」分两档，这是为了不漏掉一次很轻的点按：
 * 人按 Esc 可以只按住 30~50ms，固定 40ms 采样有实打实的概率整段跳过 —— 而漏掉
 * 的后果是「用户想停，我们没停」，这是这套护栏里唯一一条不该有概率性失效的。
 *
 * 为什么不干脆一直快轮询：这是长驻进程，MultiCC 本身就在治理电池掉电，空闲时
 * 每秒 100+ 次定时唤醒没有道理 —— 而**没人持租约时根本没有东西可停**。
 *
 * 两档之间的**切换必须是即时的**：空闲档一次睡 150ms，比人按 Esc 的 120ms 还长，
 * 这一觉要是正好横跨那次按下，整次急停就看不见（栅格盖住的概率是 (150-120)/150）。
 * 所以睡眠放在条件变量上，任何「有人在操作」的动作（开始注入、拿到租约）都立刻
 * 叫醒它切快档 —— 否则「刚拿到租约后按的第一下 Esc」要赌这 150ms 的相位。
 *
 * 为什么不换 XRecord：它要额外扩展、要单独一条控制连接、没有干净的超时退出。
 * 为什么不用 XGrabKey：那会把 Esc 从用户正在用的程序手里抢走（owner_events 也
 * 救不了：被动抓取激活期间事件是报到抓取窗口的）。 */
#define ESC_POLL_ACTIVE_US 8000
#define ESC_POLL_IDLE_US 150000

/* 睡一会儿，但随时可以被 x11_watch_nudge() 提前叫醒。 */
static void watch_sleep(long us) {
  struct timespec ts;
  clock_gettime(CLOCK_REALTIME, &ts);
  ts.tv_sec += us / 1000000L;
  ts.tv_nsec += (us % 1000000L) * 1000L;
  if (ts.tv_nsec >= 1000000000L) { ts.tv_sec += 1; ts.tv_nsec -= 1000000000L; }
  pthread_mutex_lock(&g_sleep_mu);
  pthread_cond_timedwait(&g_sleep_cv, &g_sleep_mu, &ts);
  pthread_mutex_unlock(&g_sleep_mu);
}

static void *watch_main(void *arg) {
  (void)arg;
  Display *d = XOpenDisplay(NULL);
  if (!d) return NULL;
  KeyCode esc = XKeysymToKeycode(d, XK_Escape);
  char keys[32];
  int prev = 0;

  while (g_watch_run) {
    int active = g_lease_active ? g_lease_active() : 0;
    /* 注入期间**照样采样**：那些键在服务器上就是按下状态，看得见总比盲着好。
     * 要排除的只有「我们自己刚发的 Escape」这一次下降沿。 */
    memset(keys, 0, sizeof(keys));
    XQueryKeymap(d, keys);
    int down = (keys[esc / 8] >> (esc % 8)) & 1;
    if (down && !prev && g_on_esc && !(g_injecting && g_self_esc)) g_on_esc();
    prev = down;
    watch_sleep((active || g_injecting) ? ESC_POLL_ACTIVE_US : ESC_POLL_IDLE_US);
  }
  XCloseDisplay(d);
  return NULL;
}

void x11_watch_start(int (*on_esc_edge)(void), int (*lease_active)(void)) {
  if (g_watch_run) return;
  g_on_esc = on_esc_edge;
  g_lease_active = lease_active;
  g_watch_run = 1;
  if (pthread_create(&g_watch, NULL, watch_main, NULL) == 0) {
    pthread_detach(g_watch);
  } else {
    g_watch_run = 0;
  }
}
