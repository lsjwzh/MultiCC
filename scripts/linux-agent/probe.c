/*
 * MultiCC Linux agent 环境探针
 *
 * 「🖥 屏幕」在 Linux 上要成立，卡在三件 X11 原语上。这个探针把它们逐个验一遍，
 * 每一条都给**可断言**的证据，而不是「进程没报错」：
 *
 *   1. 截图    XShm（快路）与 XGetImage（回退路）都能取到屏幕内容 ——
 *              判据是「截出来的图里确实有我刚才画上去的那个颜色」。
 *              容器里 MIT-SHM 最常见的退化是「调用成功但整帧是黑的」，
 *              只判返回值会漏掉，所以必须按像素判。
 *   2. 注入    XTEST 的移动 / 按键 / 按键事件能被同一 display 上的窗口真实收到，
 *              且**坐标对得上**（不是「发出去没报错」）。
 *   3. 按键观察 Esc 急停需要一个「看得到 Esc、但不把它吞掉」的机制。
 *              XQueryKeymap 轮询是保底（一定有）；XRecord 是更精确的对应物
 *              （macOS 那边是 CGEventTap listenOnly），可用性随 X server 而异，
 *              因此它只报 INFO，不参与门禁。
 *
 * 退出码：0 = 三个原语都可用（XRecord 除外）；1 = 有原语不可用。
 *
 * 为什么先写探针而不是直接写 agent：这三个原语在无头 / 容器环境里会**静默退化**，
 * 而退化后的现象（黑帧、点击落到空处）和「agent 写错了」长得一模一样。
 * 先在这里把环境因素摘干净，后面那两千行 C 的调试成本才可控。
 *
 * 编译：gcc -O2 -Wall -Wextra -o multicc-linux-probe probe.c -lX11 -lXext -lXtst
 */

#define _GNU_SOURCE

#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/keysym.h>
#include <X11/extensions/XShm.h>
#include <X11/extensions/XTest.h>
#include <X11/extensions/record.h>

#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ipc.h>
#include <sys/shm.h>
#include <sys/wait.h>
#include <unistd.h>

static int g_fail = 0;

static void report(const char *tag, const char *name, const char *detail) {
  printf("[%s] %s%s%s\n", tag, name, detail && *detail ? " — " : "",
         detail && *detail ? detail : "");
  fflush(stdout);
  if (strcmp(tag, "FAIL") == 0) g_fail++;
}

static void note(const char *name) { report("INFO", name, ""); }

/* TrueColor / DirectColor 下按通道掩码拼一个像素值，免得依赖 XAllocColor 的
 * 只读返回（我们要的是「写下去什么、读回来还是什么」）。 */
static int mask_shift(unsigned long mask) {
  int s = 0;
  if (!mask) return 0;
  while (!(mask & 1UL)) { mask >>= 1; s++; }
  return s;
}

static unsigned long pixel_for(Display *d, int scr, int r, int g, int b) {
  Visual *v = DefaultVisual(d, scr);
  return ((unsigned long)r << mask_shift(v->red_mask)) |
         ((unsigned long)g << mask_shift(v->green_mask)) |
         ((unsigned long)b << mask_shift(v->blue_mask));
}

/* 在屏幕坐标 (sx,sy) 起画一块纯色，作为「截图有没有真的取到屏幕」的靶子。 */
static void paint_patch(Display *d, Window root, unsigned long color, int x, int y, int w, int h) {
  GC gc = XCreateGC(d, root, 0, NULL);
  XSetForeground(d, gc, color);
  XFillRectangle(d, root, gc, x, y, w, h);
  XFreeGC(d, gc);
  XSync(d, False);
}

static int count_pixel(XImage *img, unsigned long want, int step, int *first_x, int *first_y) {
  int n = 0;
  for (int y = 0; y < img->height; y += step) {
    for (int x = 0; x < img->width; x += step) {
      if (((unsigned long)XGetPixel(img, x, y)) == want) {
        if (n == 0) { *first_x = x; *first_y = y; }
        n++;
      }
    }
  }
  return n;
}

/* ── 1. 截图 ─────────────────────────────────────────────────────────────── */

/* XShm 取一帧；成功返回 1，并把 img 交给调用方（用完调 shm_release）。 */
static int shm_grab(Display *d, int scr, XShmSegmentInfo *shm, XImage **out) {
  Window root = RootWindow(d, scr);
  int w = DisplayWidth(d, scr), h = DisplayHeight(d, scr);

  *out = NULL;
  memset(shm, 0, sizeof(*shm));
  shm->shmid = -1;

  XImage *img = XShmCreateImage(d, DefaultVisual(d, scr), (unsigned)DefaultDepth(d, scr),
                                ZPixmap, NULL, shm, (unsigned)w, (unsigned)h);
  if (!img) return 0;

  shm->shmid = shmget(IPC_PRIVATE, (size_t)img->bytes_per_line * (size_t)img->height,
                      IPC_CREAT | 0600);
  if (shm->shmid < 0) { XDestroyImage(img); return 0; }

  shm->shmaddr = img->data = shmat(shm->shmid, NULL, 0);
  if (img->data == (char *)-1) {
    img->data = NULL;
    XDestroyImage(img);
    shmctl(shm->shmid, IPC_RMID, NULL);
    return 0;
  }
  shm->readOnly = False;

  if (!XShmAttach(d, shm)) {
    shmdt(shm->shmaddr);
    shmctl(shm->shmid, IPC_RMID, NULL);
    img->data = NULL;
    XDestroyImage(img);
    return 0;
  }
  XSync(d, False);

  Status got = XShmGetImage(d, root, img, 0, 0, AllPlanes);
  if (!got) {
    XShmDetach(d, shm);
    shmdt(shm->shmaddr);
    shmctl(shm->shmid, IPC_RMID, NULL);
    img->data = NULL;
    XDestroyImage(img);
    return 0;
  }
  *out = img;
  return 1;
}

static void shm_release(Display *d, XImage *img, XShmSegmentInfo *shm) {
  if (!img) return;
  XShmDetach(d, shm);
  shmdt(shm->shmaddr);
  shmctl(shm->shmid, IPC_RMID, NULL);
  /* XDestroyImage 会对 img->data 调 free()，而它指向共享内存 —— 必须先摘掉。 */
  img->data = NULL;
  XDestroyImage(img);
}

static void probe_capture(Display *d, int scr) {
  Window root = RootWindow(d, scr);
  const unsigned long want = pixel_for(d, scr, 0x2b, 0xa6, 0x7a); /* #2ba67a */
  int fx = -1, fy = -1, hits = 0;
  char buf[160];

  /* 靶子放在左上角，后面的测试窗口都在 400,300 以远，不会盖住它。 */
  paint_patch(d, root, want, 16, 16, 96, 96);

  if (!XShmQueryExtension(d)) {
    report("FAIL", "截图 / XShm 可用性", "server 没报 MIT-SHM 扩展");
  } else {
    XShmSegmentInfo shm;
    XImage *img = NULL;
    if (!shm_grab(d, scr, &shm, &img)) {
      report("FAIL", "截图 / XShm", "XShmGetImage 失败（回退路下面单测）");
    } else {
      /* 步长 4：1280x800 全扫太慢，而 96x96 的色块按 4 步长必被采到。 */
      hits = count_pixel(img, want, 4, &fx, &fy);
      snprintf(buf, sizeof(buf), "%dx%d，命中 %d 像素@(%d,%d)", img->width, img->height, hits, fx, fy);
      report(hits > 0 ? "PASS" : "FAIL", "截图 / XShm", buf);
      shm_release(d, img, &shm);
    }
  }

  {
    XImage *img = XGetImage(d, root, 0, 0, (unsigned)DisplayWidth(d, scr),
                            (unsigned)DisplayHeight(d, scr), AllPlanes, ZPixmap);
    if (!img) {
      report("FAIL", "截图 / XGetImage 回退", "XGetImage 返回空");
    } else {
      hits = count_pixel(img, want, 4, &fx, &fy);
      snprintf(buf, sizeof(buf), "命中 %d 像素@(%d,%d)", hits, fx, fy);
      report(hits > 0 ? "PASS" : "FAIL", "截图 / XGetImage 回退", buf);
      XDestroyImage(img);
    }
  }
}

/* ── 2. 注入 ─────────────────────────────────────────────────────────────── */

/* 读到 event_type 为止（带超时），顺带把该事件的坐标填回 x/y。 */
static int drain_for(Display *d, int event_type, int *x, int *y, int wait_ms) {
  for (int spent = 0; spent < wait_ms; spent += 10) {
    XSync(d, False);
    while (XPending(d)) {
      XEvent ev;
      XNextEvent(d, &ev);
      if (ev.type == event_type) {
        if (x) *x = ev.xbutton.x;
        if (y) *y = ev.xbutton.y;
        return 1;
      }
    }
    usleep(10 * 1000);
  }
  return 0;
}

static void probe_input(Display *d, int scr) {
  char buf[200];
  int ev_base = 0, err_base = 0, maj = 0, min = 0;

  if (!XTestQueryExtension(d, &ev_base, &err_base, &maj, &min)) {
    report("FAIL", "注入 / XTEST 可用性", "server 没报 XTEST 扩展");
    return;
  }
  snprintf(buf, sizeof(buf), "XTEST %d.%d", maj, min);
  note(buf);

  /* 窗口挪到 400,300，既不盖住截图的靶子，也不受任何 WM 影响（容器里没有 WM）。 */
  const int wx = 400, wy = 300, ww = 200, wh = 200;
  Window win = XCreateSimpleWindow(d, RootWindow(d, scr), wx, wy, (unsigned)ww, (unsigned)wh,
                                   0, BlackPixel(d, scr), WhitePixel(d, scr));
  XSelectInput(d, win, ButtonPressMask | ButtonReleaseMask | PointerMotionMask | KeyPressMask);
  XMapWindow(d, win);
  XSync(d, False);
  usleep(120 * 1000);

  /* 移动 + 左键按下：目标是窗口内 (50,50)。 */
  XTestFakeMotionEvent(d, -1, wx + 50, wy + 50, 0);
  XSync(d, False);
  usleep(30 * 1000);
  XTestFakeButtonEvent(d, 1, True, 0);
  XTestFakeButtonEvent(d, 1, False, 0);
  XSync(d, False);

  int rx = -1, ry = -1;
  if (!drain_for(d, ButtonPress, &rx, &ry, 1000)) {
    report("FAIL", "注入 / XTEST 点击", "点下去了，但目标窗口没收到 ButtonPress");
  } else {
    snprintf(buf, sizeof(buf), "窗口收到 ButtonPress，局部坐标 (%d,%d)，期望 (50,50)", rx, ry);
    report((rx == 50 && ry == 50) ? "PASS" : "FAIL", "注入 / XTEST 点击", buf);
  }

  /* 键盘：XTEST 的键事件要求窗口拿到输入焦点。容器里没有 WM 帮忙，得自己设。 */
  XSetInputFocus(d, win, RevertToParent, CurrentTime);
  XSync(d, False);
  usleep(30 * 1000);
  KeyCode esc = XKeysymToKeycode(d, XK_Escape);
  XTestFakeKeyEvent(d, esc, True, 0);
  XTestFakeKeyEvent(d, esc, False, 0);
  XSync(d, False);

  if (!drain_for(d, KeyPress, NULL, NULL, 1000)) {
    report("FAIL", "注入 / XTEST 按键", "键按下去了，但焦点窗口没收到 KeyPress");
  } else {
    report("PASS", "注入 / XTEST 按键", "焦点窗口收到 KeyPress（type/press 两个 op 的地基）");
  }

  XDestroyWindow(d, win);
  XSync(d, False);
}

/* ── 3. 按键观察（Esc 急停的地基） ──────────────────────────────────────── */

/* XRecord 的回调。只记录，不做任何动作 —— 这就是「看得到但不吞掉」。 */
static int g_record_hit = 0;
static void record_cb(XPointer closure, XRecordInterceptData *data) {
  (void)closure;
  if (data->category == XRecordFromServer) {
    /* data->data 是线上事件的原始 32 字节，头一个字节就是事件类型。
     * 直接读字节而不是转成 XEvent*：XEvent 里有 long，这条 buffer 不保证按它对齐。 */
    unsigned char *raw = (unsigned char *)data->data;
    if (raw[0] == KeyPress) g_record_hit = 1;
  }
  XRecordFreeData(data);
}

/* XRecord 的 EnableContext 会永久阻塞，且没有干净的「超时取消」。
 * 与其在主进程里跟它斗，不如 fork 一个子进程去阻塞，用管道把结果带回来。 */
static void probe_keywatch_record(void) {
  int to_parent[2];
  if (pipe(to_parent) != 0) {
    report("INFO", "急停 / XRecord", "pipe 建不起来，跳过");
    return;
  }

  pid_t pid = fork();
  if (pid < 0) {
    report("INFO", "急停 / XRecord", "fork 失败，跳过");
    close(to_parent[0]);
    close(to_parent[1]);
    return;
  }

  if (pid == 0) {
    /* 子进程：自己开一条独立连接（XRecord 不能用正在跑请求的那条）。 */
    close(to_parent[0]);
    Display *rdpy = XOpenDisplay(NULL);
    if (!rdpy) { _exit(2); }

    int maj = 0, min = 0;
    if (!XRecordQueryVersion(rdpy, &maj, &min)) { _exit(3); }

    XRecordRange *range = XRecordAllocRange();
    if (!range) _exit(4);
    range->device_events.first = KeyPress;
    range->device_events.last = KeyRelease;
    XRecordClientSpec clients = XRecordAllClients;
    XRecordContext ctx = XRecordCreateContext(rdpy, 0, &clients, 1, &range, 1);
    XFree(range);
    if (!ctx) _exit(5);

    /* 告诉父进程「我准备好收事件了」，让它在注入前等一小会儿。 */
    if (write(to_parent[1], "R", 1) != 1) _exit(6);

    XRecordEnableContext(rdpy, ctx, record_cb, NULL);
    _exit(g_record_hit ? 0 : 7);
  }

  /* 父进程：等 ready，再注入 Esc，然后等子进程的结论。 */
  close(to_parent[1]);
  char ready = 0;
  if (read(to_parent[0], &ready, 1) != 1) {
    report("INFO", "急停 / XRecord", "子进程没起来（该 server 可能没有 RECORD 扩展）");
    kill(pid, SIGKILL);
    waitpid(pid, NULL, 0);
    close(to_parent[0]);
    return;
  }

  usleep(300 * 1000); /* 让 EnableContext 真正进入监听 */

  Display *d = XOpenDisplay(NULL);
  if (d) {
    KeyCode esc = XKeysymToKeycode(d, XK_Escape);
    for (int i = 0; i < 2; i++) {
      XTestFakeKeyEvent(d, esc, True, 0);
      XTestFakeKeyEvent(d, esc, False, 0);
      XSync(d, False);
      usleep(100 * 1000);
    }
    XCloseDisplay(d);
  }

  int status = 0, waited = 0;
  while (waited < 1500) {
    pid_t r = waitpid(pid, &status, WNOHANG);
    if (r == pid) break;
    usleep(50 * 1000);
    waited += 50;
  }
  if (waited >= 1500) {
    kill(pid, SIGKILL);
    waitpid(pid, NULL, 0);
    report("INFO", "急停 / XRecord", "该 server 没有 RECORD（或不通），改用 XQueryKeymap 轮询");
  } else if (WIFEXITED(status) && WEXITSTATUS(status) == 0) {
    report("INFO", "急停 / XRecord", "可用：看得到按键且不吞掉它");
  } else {
    report("INFO", "急停 / XRecord", "不可用，改用 XQueryKeymap 轮询");
  }
  close(to_parent[0]);
}

static void probe_keywatch_poll(Display *d) {
  KeyCode esc = XKeysymToKeycode(d, XK_Escape);
  char keys[32];
  int seen = 0;

  XTestFakeKeyEvent(d, esc, True, 0);
  XSync(d, False);
  for (int i = 0; i < 40 && !seen; i++) { /* 最多等 400ms */
    memset(keys, 0, sizeof(keys));
    XQueryKeymap(d, keys);
    if ((keys[esc / 8] >> (esc % 8)) & 1) seen = 1;
    else usleep(10 * 1000);
  }
  XTestFakeKeyEvent(d, esc, False, 0);
  XSync(d, False);

  report(seen ? "PASS" : "FAIL", "急停 / XQueryKeymap 轮询",
         seen ? "按下 Esc 期间能读到键按下状态（保底方案成立）"
              : "读不到 Esc 的按下状态");
}

/* ── main ───────────────────────────────────────────────────────────────── */

int main(void) {
  Display *d = XOpenDisplay(NULL);
  if (!d) {
    fprintf(stderr, "连不上 X server（DISPLAY=%s）。这个探针需要一个可用的 X11 会话。\n",
            getenv("DISPLAY") ? getenv("DISPLAY") : "(未设置)");
    return 1;
  }

  int scr = DefaultScreen(d);
  char buf[256];
  snprintf(buf, sizeof(buf), "DISPLAY=%s  vendor=%s  屏幕 %dx%d  depth %d",
           DisplayString(d), ServerVendor(d), DisplayWidth(d, scr), DisplayHeight(d, scr),
           DefaultDepth(d, scr));
  note(buf);

  const char *session = getenv("XDG_SESSION_TYPE");
  if (session) {
    snprintf(buf, sizeof(buf), "XDG_SESSION_TYPE=%s%s", session,
             (strcmp(session, "wayland") == 0)
                 ? "  ← Wayland 会话：XWayland 下抓不到原生窗口，别把它当 X11 用" : "");
    note(buf);
  }

  probe_capture(d, scr);
  probe_input(d, scr);
  probe_keywatch_poll(d);
  probe_keywatch_record();

  printf("\n%s（%d 项失败）\n", g_fail ? "有原语不可用" : "三个原语都可用", g_fail);
  XCloseDisplay(d);
  return g_fail ? 1 : 0;
}
