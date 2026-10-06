/*
 * MultiCC Linux desktop agent —— 公共声明
 *
 * 契约见 docs/desktop-agent-protocol.md。这个进程是 Linux 上**唯一**碰系统 API 的
 * 东西：服务端只说一小段固定 JSON（一行进、一行出），agent 自己决定怎么做到。
 * 所以这里没有「平台分支」，只有 op。
 *
 * 与 macOS 那份（scripts/macos-agent/MultiCCAgent.swift）的分工差异：
 *   · 图像处理在 agent 里做完（macOS 用 sips 在服务端做）。X11 上没有 sips 这种
 *     系统自带的命令行图像工具，硬要服务端做就得让用户装 ImageMagick；而 agent
 *     手里本来就攥着帧缓冲，顺手裁切 + 编码比落盘再读回来更省。见 §snap。
 *   · 没有 unlock：X11 的锁屏是另一个会话的窗口，agent 够不到也不该够到。
 */
#ifndef MULTICC_AGENT_H
#define MULTICC_AGENT_H

#include <stddef.h>

/* ── 极简 JSON（json.c）────────────────────────────────────────────────────
 * 只做契约需要的部分：扁平对象 + 一层嵌套（snap 的 crop）。值域是字符串 /
 * 数字 / 布尔 / null。不实现数组、不实现任意深度 —— 请求里出现这些就是协议
 * 变了，宁可解析失败也不要维护一个「看起来能跑」的半吊子解析器。
 * 字符串支持全部 JSON 必需转义（含 \uXXXX 与代理对）：type 的文本是任意
 * Unicode，中文必须原样穿过。 */
typedef struct {
  char key[64];
  char *s;              /* 字符串值（已解码）；对象值时为原文（用 jobj 再解析） */
  double n;
  int is_num, is_bool, is_null, is_obj, b;
} jfield;

typedef struct { jfield *f; int n; } jobject;

int json_parse(const char *text, size_t len, jobject *out, char *err, size_t errsz);
void json_free(jobject *o);
int jhas(const jobject *o, const char *key);
const char *jstr(const jobject *o, const char *key);          /* 无 → NULL */
int jnum(const jobject *o, const char *key, double *out);     /* 无 → 0 */
int jbool(const jobject *o, const char *key, int *out);       /* 无 → 0 */
int jobj(const jobject *o, const char *key, jobject *out);    /* 嵌套对象 → 再解析 */

/* 单行 JSON 响应构造器。容量由调用方给（本 agent 的响应都很小，没有图像数据
 * 走 JSON —— 截图落文件）。 */
typedef struct { char *buf; size_t cap, len; int need_comma, trunc; int commas[8]; int depth; } jout;

void jo_init(jout *o, char *buf, size_t cap);
void jo_str(jout *o, const char *k, const char *v);
void jo_int(jout *o, const char *k, long long v);
void jo_bool(jout *o, const char *k, int v);
void jo_null(jout *o, const char *k);
void jo_nest(jout *o, const char *k);
void jo_end(jout *o);
void jo_finish(jout *o);
int  jo_ok(const jout *o);                                    /* 没被截断 */

/* ── 图像编码（image.c）──
 * 输入一律是 packed RGB（3 字节/像素），捕获那一侧负责把 XImage 转过来。 */
int image_write_png(const char *path, const unsigned char *rgb, int w, int h, char *err, size_t errsz);
int image_write_jpeg(const char *path, const unsigned char *rgb, int w, int h, int quality, char *err, size_t errsz);

/* ── X11（x11.c）──
 * 每次请求自己开一条 Display —— 服务端本来就是一次 op 一条 unix socket，
 * 这里跟着一条 X 连接，于是不需要 XInitThreads、也不需要给 Xlib 加锁。
 * 唯一的例外是按键观察线程，它有自己那条。 */
typedef struct { int w, h; unsigned char *rgb; } shot;

int  x11_open(char *err, size_t errsz);      /* 线程本地：给当前线程开连接 */
int  x11_screen_size(int *w, int *h);
shot *x11_capture(char *err, size_t errsz);
void shot_free(shot *s);
shot *shot_crop(const shot *src, int x, int y, int w, int h, char *err, size_t errsz);

int x11_move(int x, int y);
int x11_click(int x, int y, int button, int count);
int x11_scroll(int x, int y, int amount);
int x11_drag(int x, int y, int x2, int y2, int ms);
int x11_type(const char *utf8);
int x11_press(const char *keys);
int x11_release_all(void);                   /* 兜底：松开所有被按住的修饰键 */
void x11_injecting(int on);                  /* 注入期间别把自己的按键当急停 */
void x11_watch_nudge(void);                  /* 「有人在操作」：叫醒 Esc 观察线程切快档 */
const char *x11_last_error(void);            /* 上面几个失败时的原因（线程本地） */

/* 锁屏与敏感窗口：X11 没有权限模型，也没有「现在锁没锁」这种一等查询，
 * 只能靠「焦点窗口是谁」+ XScreenSaver 扩展尽力而为。返回 1/0，另外把判据
 * 写进 *how（给 status 用，便于现场排查）。 */
int x11_screen_locked(const char **how);
int x11_focus_is_sensitive(void);

/* 起按键观察线程。每次看到「Esc 刚被按下」就回调一次 on_esc_edge()——
 * 判断「这次算不算急停」要用当时的租约状态，所以决定权在 agent.c 那边，
 * 这里只负责报告边沿。
 *
 * lease_active 决定轮询频率：有人持租约时快采样（人按 Esc 可以只按住几十毫秒，
 * 慢采样会整段跳过 —— 漏掉的后果是「用户想停但没停」，不该有概率性失效），
 * 空闲时慢采样（长驻进程，空闲时每秒上百次定时唤醒没有道理，且没人持租约时
 * 本来也没有东西可停）。两个回调都由 agent.c 提供。 */
void x11_watch_start(int (*on_esc_edge)(void), int (*lease_active)(void));
#endif
