/*
 * PNG（zlib）与 JPEG（libjpeg-turbo）编码。输入一律 packed RGB。
 *
 * 为什么编码在 agent 里做，而不是像 macOS 那样在服务端调系统工具：
 * X11 上没有 sips / magick 这种「一定在」的命令行图像工具，让服务端做就等于
 * 要求用户装 ImageMagick。而 agent 手里本来就攥着帧缓冲，顺手裁切 + 编码比
 * 「落盘 PNG → 服务端再读回来 → 命令行走一遍」少两次全屏拷贝。
 *
 * JPEG 编码器必须能失败而不弄死进程：libjpeg 默认的错误处理是直接 exit()，
 * 那会让一次「quality 传了个怪值」变成整个 agent 下线。所以这里换成 longjmp，
 * 并且失败时把写了一半的文件删掉。
 */

#include "agent.h"

#include <errno.h>
#include <setjmp.h>
/* stdio.h 必须在 jpeglib.h **之前**：jpeglib.h 里直接拿 FILE* 做参数声明
 * （jpeg_stdio_dest/src），自己不 include stdio.h —— 顺序反了就是「unknown type
 * name 'FILE'」，而且报在 jpeglib.h 里，看着像系统的锅。 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>
#include <jpeglib.h>

/* ── PNG ──────────────────────────────────────────────────────────────── */

static void be32(unsigned char *p, unsigned v) {
  p[0] = (unsigned char)((v >> 24) & 0xff);
  p[1] = (unsigned char)((v >> 16) & 0xff);
  p[2] = (unsigned char)((v >> 8) & 0xff);
  p[3] = (unsigned char)(v & 0xff);
}

static int write_chunk(FILE *f, const char *type, const unsigned char *data, unsigned len) {
  unsigned char head[8];
  be32(head, len);
  memcpy(head + 4, type, 4);
  if (fwrite(head, 1, 8, f) != 8) return 0;
  if (len && fwrite(data, 1, len, f) != len) return 0;
  uLong crc = crc32(0L, Z_NULL, 0);
  crc = crc32(crc, (const Bytef *)type, 4);
  if (len) crc = crc32(crc, (const Bytef *)data, len);
  unsigned char tail[4];
  be32(tail, (unsigned)crc);
  return fwrite(tail, 1, 4, f) == 4;
}

int image_write_png(const char *path, const unsigned char *rgb, int w, int h, char *err, size_t errsz) {
  if (w <= 0 || h <= 0) { snprintf(err, errsz, "bad-size"); return 0; }
  FILE *f = fopen(path, "wb");
  if (!f) { snprintf(err, errsz, "open-failed: %s", strerror(errno)); return 0; }

  size_t stride = (size_t)w * 3;
  size_t rawlen = (stride + 1) * (size_t)h;
  unsigned char *raw = malloc(rawlen);
  unsigned char *comp = NULL;
  int ok = 0;
  uLongf clen = 0;

  if (!raw) { snprintf(err, errsz, "out-of-memory"); goto done; }
  for (int y = 0; y < h; y++) {
    /* filter 一律 None：这是中间产物（服务端马上要重新编码成 JPEG），
     * 省下的解码复杂度比省下的字节值钱。 */
    raw[(stride + 1) * (size_t)y] = 0;
    memcpy(raw + (stride + 1) * (size_t)y + 1, rgb + (size_t)y * stride, stride);
  }
  clen = compressBound((uLong)rawlen);
  comp = malloc(clen);
  if (!comp) { snprintf(err, errsz, "out-of-memory"); goto done; }
  if (compress2(comp, &clen, raw, (uLong)rawlen, Z_BEST_SPEED) != Z_OK) {
    snprintf(err, errsz, "zlib-failed");
    goto done;
  }

  {
    static const unsigned char SIG[8] = { 137, 80, 78, 71, 13, 10, 26, 10 };
    unsigned char ihdr[13];
    be32(ihdr, (unsigned)w);
    be32(ihdr + 4, (unsigned)h);
    ihdr[8] = 8;  /* bit depth */
    ihdr[9] = 2;  /* color type: truecolor RGB */
    ihdr[10] = 0; /* deflate */
    ihdr[11] = 0; /* adaptive filtering */
    ihdr[12] = 0; /* no interlace */
    ok = fwrite(SIG, 1, 8, f) == 8
         && write_chunk(f, "IHDR", ihdr, 13)
         && write_chunk(f, "IDAT", comp, (unsigned)clen)
         && write_chunk(f, "IEND", NULL, 0);
    if (!ok) snprintf(err, errsz, "write-failed: %s", strerror(errno));
  }

done:
  free(raw);
  free(comp);
  if (fclose(f) != 0 && ok) { ok = 0; snprintf(err, errsz, "close-failed: %s", strerror(errno)); }
  if (!ok) remove(path);
  return ok;
}

/* ── JPEG ─────────────────────────────────────────────────────────────── */

struct jerr {
  struct jpeg_error_mgr pub;
  jmp_buf jb;
  char msg[JMSG_LENGTH_MAX];
};

static void jpeg_fail(j_common_ptr cinfo) {
  struct jerr *e = (struct jerr *)cinfo->err;
  (*cinfo->err->format_message)(cinfo, e->msg);
  longjmp(e->jb, 1);
}

int image_write_jpeg(const char *path, const unsigned char *rgb, int w, int h, int quality,
                     char *err, size_t errsz) {
  struct jpeg_compress_struct cinfo;
  struct jerr jerr;
  FILE *f = NULL;

  if (w <= 0 || h <= 0) { snprintf(err, errsz, "bad-size"); return 0; }
  if (quality < 1) quality = 1;
  if (quality > 100) quality = 100;

  f = fopen(path, "wb");
  if (!f) { snprintf(err, errsz, "open-failed: %s", strerror(errno)); return 0; }

  memset(&cinfo, 0, sizeof(cinfo));
  memset(&jerr, 0, sizeof(jerr));
  cinfo.err = jpeg_std_error(&jerr.pub);
  jerr.pub.error_exit = jpeg_fail;

  if (setjmp(jerr.jb)) {
    jpeg_destroy_compress(&cinfo);
    fclose(f);
    remove(path);
    snprintf(err, errsz, "jpeg-encode-failed: %s", jerr.msg);
    return 0;
  }

  jpeg_create_compress(&cinfo);
  jpeg_stdio_dest(&cinfo, f);
  cinfo.image_width = (JDIMENSION)w;
  cinfo.image_height = (JDIMENSION)h;
  cinfo.input_components = 3;
  cinfo.in_color_space = JCS_RGB;
  jpeg_set_defaults(&cinfo);
  jpeg_set_quality(&cinfo, quality, TRUE);
  cinfo.dct_method = JDCT_FASTEST;   /* 屏幕内容不缺这点精度，缺的是延迟 */
  cinfo.optimize_coding = FALSE;     /* Huffman 优化会让编码慢好几倍 */
  jpeg_start_compress(&cinfo, TRUE);

  while (cinfo.next_scanline < cinfo.image_height) {
    JSAMPROW row = (JSAMPROW)(rgb + (size_t)cinfo.next_scanline * (size_t)w * 3);
    jpeg_write_scanlines(&cinfo, &row, 1);
  }

  jpeg_finish_compress(&cinfo);
  jpeg_destroy_compress(&cinfo);
  if (fclose(f) != 0) {
    remove(path);
    snprintf(err, errsz, "close-failed: %s", strerror(errno));
    return 0;
  }
  return 1;
}
