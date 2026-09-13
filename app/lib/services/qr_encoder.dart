/// QR 码编码器（byte 模式、纠错等级 M、版本自动）。
///
/// 侧栏那个「扫码打开 MultiCC Air」要画一张二维码。Web 用的是
/// `public/qrcode.min.js`（qrcode-generator），App 里没有能画二维码的包
/// （pubspec 里既没有 qr_flutter 也没有 qr），服务端也不出这个图，所以这一份
/// 是自己写的：数据和纠错码字按 ISO/IEC 18004 算，矩阵逐格与那份参照实现对过
/// （见 test/qr_encoder_test.dart，参照矩阵由 test/fixtures 里的脚本生成）。
///
/// 两处与 Web 不同，都是有意的：
///  * 字节化用 UTF-8。qrcode-generator 默认按 `charCodeAt(i) & 0xff` 取字节，
///    非 ASCII 的高位会被丢掉（「主机」→ 0x3B 0x3A），扫出来是乱码；byte 模式
///    按标准本来就该是 UTF-8。ASCII 下两者逐字节相同，所以日常的局域网地址
///    与 Web 完全一致。
///  * 只做纠错等级 M。这个编码器只有一个用途，另外三张分块表没被验证过就是
///    负债，需要时再补。
library;

import 'dart:convert';

/// 一张编好的二维码：边长 [size] 格，[modules] 是 `[行][列]`。
class QrCode {
  QrCode._(this.version, this.modules);

  /// 1..40。由内容长度自动选定。
  final int version;

  final List<List<bool>> modules;

  int get size => version * 4 + 17;

  bool isDark(int row, int column) => modules[row][column];
}

/// 把 [text] 编成一张二维码。内容超过版本 40 的容量时抛 [ArgumentError]。
QrCode encodeQr(String text) {
  final data = utf8.encode(text);
  final version = _pickVersion(data.length);
  if (version == null) {
    throw ArgumentError.value(
      text.length,
      'text',
      '内容太长，版本 40 也放不下（${data.length} 字节）',
    );
  }
  final codewords = _buildCodewords(version, data);
  final matrix = _buildMatrix(
    version,
    codewords,
    maskPattern: _bestMask(version, codewords),
  );
  // 走到这一步每个格子都落定了：null 只是构建中途「这儿还空着」的记号。
  return QrCode._(version, <List<bool>>[
    for (final row in matrix) <bool>[for (final cell in row) cell ?? false],
  ]);
}

// ── 容量与分块 ────────────────────────────────────────────────────────────
// 下面两张表来自 public/qrcode.min.js（qrcode-generator）里的 RS_BLOCK_TABLE
// 与 PATTERN_POSITION_TABLE，只取纠错等级 M 那一列 —— 手抄 40 行 160 个数
// 一定会抄错，而且错了只会表现为「扫不出来」，所以表是从参照实现里提出来的，
// 正确性由逐格比对兜底。
const List<List<int>> _rsBlocksM = <List<int>>[
  <int>[1, 26, 16], // v1
  <int>[1, 44, 28], // v2
  <int>[1, 70, 44], // v3
  <int>[2, 50, 32], // v4
  <int>[2, 67, 43], // v5
  <int>[4, 43, 27], // v6
  <int>[4, 49, 31], // v7
  <int>[2, 60, 38, 2, 61, 39], // v8
  <int>[3, 58, 36, 2, 59, 37], // v9
  <int>[4, 69, 43, 1, 70, 44], // v10
  <int>[1, 80, 50, 4, 81, 51], // v11
  <int>[6, 58, 36, 2, 59, 37], // v12
  <int>[8, 59, 37, 1, 60, 38], // v13
  <int>[4, 64, 40, 5, 65, 41], // v14
  <int>[5, 65, 41, 5, 66, 42], // v15
  <int>[7, 73, 45, 3, 74, 46], // v16
  <int>[10, 74, 46, 1, 75, 47], // v17
  <int>[9, 69, 43, 4, 70, 44], // v18
  <int>[3, 70, 44, 11, 71, 45], // v19
  <int>[3, 67, 41, 13, 68, 42], // v20
  <int>[17, 68, 42], // v21
  <int>[17, 74, 46], // v22
  <int>[4, 75, 47, 14, 76, 48], // v23
  <int>[6, 73, 45, 14, 74, 46], // v24
  <int>[8, 75, 47, 13, 76, 48], // v25
  <int>[19, 74, 46, 4, 75, 47], // v26
  <int>[22, 73, 45, 3, 74, 46], // v27
  <int>[3, 73, 45, 23, 74, 46], // v28
  <int>[21, 73, 45, 7, 74, 46], // v29
  <int>[19, 75, 47, 10, 76, 48], // v30
  <int>[2, 74, 46, 29, 75, 47], // v31
  <int>[10, 74, 46, 23, 75, 47], // v32
  <int>[14, 74, 46, 21, 75, 47], // v33
  <int>[14, 74, 46, 23, 75, 47], // v34
  <int>[12, 75, 47, 26, 76, 48], // v35
  <int>[6, 75, 47, 34, 76, 48], // v36
  <int>[29, 74, 46, 14, 75, 47], // v37
  <int>[13, 74, 46, 32, 75, 47], // v38
  <int>[40, 75, 47, 7, 76, 48], // v39
  <int>[18, 75, 47, 31, 76, 48], // v40
];

/// 对齐图案的中心坐标（按版本）。
const List<List<int>> _alignmentPositions = <List<int>>[
  <int>[], // v1
  <int>[6, 18], // v2
  <int>[6, 22], // v3
  <int>[6, 26], // v4
  <int>[6, 30], // v5
  <int>[6, 34], // v6
  <int>[6, 22, 38], // v7
  <int>[6, 24, 42], // v8
  <int>[6, 26, 46], // v9
  <int>[6, 28, 50], // v10
  <int>[6, 30, 54], // v11
  <int>[6, 32, 58], // v12
  <int>[6, 34, 62], // v13
  <int>[6, 26, 46, 66], // v14
  <int>[6, 26, 48, 70], // v15
  <int>[6, 26, 50, 74], // v16
  <int>[6, 30, 54, 78], // v17
  <int>[6, 30, 56, 82], // v18
  <int>[6, 30, 58, 86], // v19
  <int>[6, 34, 62, 90], // v20
  <int>[6, 28, 50, 72, 94], // v21
  <int>[6, 26, 50, 74, 98], // v22
  <int>[6, 30, 54, 78, 102], // v23
  <int>[6, 28, 54, 80, 106], // v24
  <int>[6, 32, 58, 84, 110], // v25
  <int>[6, 30, 58, 86, 114], // v26
  <int>[6, 34, 62, 90, 118], // v27
  <int>[6, 26, 50, 74, 98, 122], // v28
  <int>[6, 30, 54, 78, 102, 126], // v29
  <int>[6, 26, 52, 78, 104, 130], // v30
  <int>[6, 30, 56, 82, 108, 134], // v31
  <int>[6, 34, 60, 86, 112, 138], // v32
  <int>[6, 30, 58, 86, 114, 142], // v33
  <int>[6, 34, 62, 90, 118, 146], // v34
  <int>[6, 30, 54, 78, 102, 126, 150], // v35
  <int>[6, 24, 50, 76, 102, 128, 154], // v36
  <int>[6, 28, 54, 80, 106, 132, 158], // v37
  <int>[6, 32, 58, 84, 110, 136, 162], // v38
  <int>[6, 26, 54, 82, 110, 138, 166], // v39
  <int>[6, 30, 58, 86, 114, 142, 170], // v40
];


/// byte 模式的数据位数：版本 1-9 用 8 位记长度，10 起用 16 位。
int _lengthBits(int version) => version < 10 ? 8 : 16;

List<_RsBlock> _blocks(int version) {
  final spec = _rsBlocksM[version - 1];
  final blocks = <_RsBlock>[];
  // 每三项一组：块数、每块总码字数、每块数据码字数。两种规格就写两组。
  for (var i = 0; i < spec.length; i += 3) {
    for (var n = 0; n < spec[i]; n++) {
      blocks.add(_RsBlock(total: spec[i + 1], data: spec[i + 2]));
    }
  }
  return blocks;
}

int _dataCodewords(int version) {
  var total = 0;
  for (final block in _blocks(version)) {
    total += block.data;
  }
  return total;
}

/// 能装下就返回版本号，1..40 都不行返回 null。
int? _pickVersion(int byteLength) {
  for (var version = 1; version <= 40; version++) {
    final capacity = _dataCodewords(version) * 8;
    final needed = 4 + _lengthBits(version) + byteLength * 8;
    if (needed <= capacity) return version;
  }
  return null;
}

// ── 码字 ──────────────────────────────────────────────────────────────────

List<int> _buildCodewords(int version, List<int> data) {
  final blocks = _blocks(version);
  var capacity = 0;
  for (final block in blocks) {
    capacity += block.data;
  }

  final bits = _BitBuffer();
  bits.put(_modeByte, 4);
  bits.put(data.length, _lengthBits(version));
  for (final byte in data) {
    bits.put(byte, 8);
  }
  if (bits.length > capacity * 8) {
    throw ArgumentError('内容放不进版本 $version');
  }
  // 终止符，然后补齐到整字节。
  if (bits.length + 4 <= capacity * 8) bits.put(0, 4);
  while (bits.length % 8 != 0) {
    bits.putBit(false);
  }
  // 剩下的位置两个填充字节轮流填，直到填满。
  while (bits.length < capacity * 8) {
    bits.put(_pad0, 8);
    if (bits.length >= capacity * 8) break;
    bits.put(_pad1, 8);
  }

  // 按块切数据码字、各算各的纠错，再按标准交织：先所有块的第 0 个数据码字、
  // 再第 1 个……纠错码字同理。
  final dataBlocks = <List<int>>[];
  final ecBlocks = <List<int>>[];
  var offset = 0;
  for (final block in blocks) {
    final chunk = bits.bytes(offset, block.data);
    offset += block.data;
    dataBlocks.add(chunk);
    ecBlocks.add(_rsRemainder(chunk, _rsGenerator(block.total - block.data)));
  }

  final result = <int>[];
  final maxData = dataBlocks.map((b) => b.length).reduce((a, b) => a > b ? a : b);
  final maxEc = ecBlocks.map((b) => b.length).reduce((a, b) => a > b ? a : b);
  for (var i = 0; i < maxData; i++) {
    for (final block in dataBlocks) {
      if (i < block.length) result.add(block[i]);
    }
  }
  for (var i = 0; i < maxEc; i++) {
    for (final block in ecBlocks) {
      if (i < block.length) result.add(block[i]);
    }
  }
  return result;
}

class _RsBlock {
  const _RsBlock({required this.total, required this.data});

  final int total;
  final int data;
}

class _BitBuffer {
  final List<int> _bytes = <int>[];
  int _bitLength = 0;

  int get length => _bitLength;

  void put(int value, int bits) {
    for (var i = bits - 1; i >= 0; i--) {
      putBit(((value >> i) & 1) == 1);
    }
  }

  void putBit(bool bit) {
    final index = _bitLength ~/ 8;
    if (_bitLength % 8 == 0) _bytes.add(0);
    if (bit) _bytes[index] |= 0x80 >> (_bitLength % 8);
    _bitLength++;
  }

  List<int> bytes(int offset, int count) =>
      List<int>.generate(count, (i) => _bytes[offset + i]);
}

// ── GF(256) 与 Reed-Solomon ───────────────────────────────────────────────

final List<int> _exp = _buildExp();
final List<int> _log = _buildLog(_exp);

List<int> _buildExp() {
  // 长度翻倍，乘法里就不用再取模。
  final exp = List<int>.filled(512, 0);
  var value = 1;
  for (var i = 0; i < 255; i++) {
    exp[i] = value;
    value <<= 1;
    if (value & 0x100 != 0) value ^= 0x11D;
  }
  for (var i = 255; i < 512; i++) {
    exp[i] = exp[i - 255];
  }
  return exp;
}

List<int> _buildLog(List<int> exp) {
  final log = List<int>.filled(256, 0);
  for (var i = 0; i < 255; i++) {
    log[exp[i]] = i;
  }
  return log;
}

int _gfMul(int a, int b) {
  if (a == 0 || b == 0) return 0;
  return _exp[_log[a] + _log[b]];
}

/// 生成多项式，降幂排列（首项恒为 1）。
List<int> _rsGenerator(int degree) {
  var poly = <int>[1];
  for (var i = 0; i < degree; i++) {
    final next = List<int>.filled(poly.length + 1, 0);
    for (var j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= _gfMul(poly[j], _exp[i]);
    }
    poly = next;
  }
  return poly;
}

/// 数据码字除以生成多项式取余，长度就是纠错码字数。
List<int> _rsRemainder(List<int> data, List<int> generator) {
  final degree = generator.length - 1;
  final remainder = List<int>.filled(degree, 0);
  for (final byte in data) {
    final factor = byte ^ remainder[0];
    for (var i = 0; i < degree - 1; i++) {
      remainder[i] = remainder[i + 1];
    }
    remainder[degree - 1] = 0;
    if (factor == 0) continue;
    for (var i = 0; i < degree; i++) {
      remainder[i] ^= _gfMul(generator[i + 1], factor);
    }
  }
  return remainder;
}

// ── 矩阵 ──────────────────────────────────────────────────────────────────

/// null = 还没写；[test] 时不写格式/版本信息，用于比较掩码。
List<List<bool?>> _buildMatrix(
  int version,
  List<int> codewords, {
  int maskPattern = 0,
  bool test = false,
}) {
  final count = version * 4 + 17;
  final modules = List<List<bool?>>.generate(
    count,
    (_) => List<bool?>.filled(count, null),
  );

  _setupProbe(modules, 0, 0);
  _setupProbe(modules, count - 7, 0);
  _setupProbe(modules, 0, count - 7);
  for (final row in _alignmentPositions[version - 1]) {
    for (final col in _alignmentPositions[version - 1]) {
      if (modules[row][col] != null) continue;
      for (var r = -2; r <= 2; r++) {
        for (var c = -2; c <= 2; c++) {
          modules[row + r][col + c] =
              r == -2 || r == 2 || c == -2 || c == 2 || (r == 0 && c == 0);
        }
      }
    }
  }
  for (var i = 8; i < count - 8; i++) {
    if (modules[i][6] == null) modules[i][6] = i % 2 == 0;
    if (modules[6][i] == null) modules[6][i] = i % 2 == 0;
  }

  _setupTypeInfo(modules, maskPattern, test);
  if (version >= 7) _setupTypeNumber(modules, version, test);
  _mapData(modules, codewords, maskPattern);

  return modules;
}

void _setupProbe(List<List<bool?>> modules, int row, int col) {
  final count = modules.length;
  for (var r = -1; r <= 7; r++) {
    if (row + r < 0 || row + r >= count) continue;
    for (var c = -1; c <= 7; c++) {
      if (col + c < 0 || col + c >= count) continue;
      final dark =
          (r >= 0 && r <= 6 && (c == 0 || c == 6)) ||
          (c >= 0 && c <= 6 && (r == 0 || r == 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      modules[row + r][col + c] = dark;
    }
  }
}

void _setupTypeInfo(List<List<bool?>> modules, int maskPattern, bool test) {
  final count = modules.length;
  final bits = _bchTypeInfo((_ecLevelM << 3) | maskPattern);
  for (var i = 0; i < 15; i++) {
    final dark = !test && ((bits >> i) & 1) == 1;
    if (i < 6) {
      modules[i][8] = dark;
    } else if (i < 8) {
      modules[i + 1][8] = dark;
    } else {
      modules[count - 15 + i][8] = dark;
    }
  }
  for (var i = 0; i < 15; i++) {
    final dark = !test && ((bits >> i) & 1) == 1;
    if (i < 8) {
      modules[8][count - i - 1] = dark;
    } else if (i < 9) {
      modules[8][15 - i] = dark;
    } else {
      modules[8][15 - i - 1] = dark;
    }
  }
  // 固定暗模块。
  modules[count - 8][8] = !test;
}

void _setupTypeNumber(List<List<bool?>> modules, int version, bool test) {
  final count = modules.length;
  final bits = _bchTypeNumber(version);
  for (var i = 0; i < 18; i++) {
    final dark = !test && ((bits >> i) & 1) == 1;
    modules[i ~/ 3][i % 3 + count - 11] = dark;
    modules[i % 3 + count - 11][i ~/ 3] = dark;
  }
}

void _mapData(List<List<bool?>> modules, List<int> data, int maskPattern) {
  final count = modules.length;
  var inc = -1;
  var row = count - 1;
  var bitIndex = 7;
  var byteIndex = 0;
  for (var col = count - 1; col > 0; col -= 2) {
    if (col == 6) col--;
    for (;;) {
      for (var c = 0; c < 2; c++) {
        if (modules[row][col - c] != null) continue;
        var dark = false;
        if (byteIndex < data.length) {
          dark = ((data[byteIndex] >> bitIndex) & 1) == 1;
        }
        if (_mask(maskPattern, row, col - c)) dark = !dark;
        modules[row][col - c] = dark;
        bitIndex--;
        if (bitIndex == -1) {
          byteIndex++;
          bitIndex = 7;
        }
      }
      row += inc;
      if (row < 0 || row >= count) {
        row -= inc;
        inc = -inc;
        break;
      }
    }
  }
}

int _bestMask(int version, List<int> codewords) {
  var best = 0;
  double? bestPoint;
  for (var i = 0; i < 8; i++) {
    final modules = _buildMatrix(version, codewords, maskPattern: i, test: true);
    final point = _lostPoint(modules);
    if (bestPoint == null || point < bestPoint) {
      bestPoint = point;
      best = i;
    }
  }
  return best;
}

bool _mask(int pattern, int i, int j) => switch (pattern) {
  0 => (i + j) % 2 == 0,
  1 => i % 2 == 0,
  2 => j % 3 == 0,
  3 => (i + j) % 3 == 0,
  4 => (i ~/ 2 + j ~/ 3) % 2 == 0,
  5 => (i * j) % 2 + (i * j) % 3 == 0,
  6 => ((i * j) % 2 + (i * j) % 3) % 2 == 0,
  7 => ((i * j) % 3 + (i + j) % 2) % 2 == 0,
  _ => throw ArgumentError.value(pattern, 'pattern', '掩码编号只到 7'),
};

/// 掩码评分，与参照实现同一套算法（它和标准的四条规则略有出入，但既然要逐格
/// 对齐，就按它来）。评分是浮点数，这里不能四舍五入——最后那一点点小数正是
/// 两个掩码分高下的地方。
double _lostPoint(List<List<bool?>> modules) {
  final count = modules.length;
  bool dark(int row, int col) => modules[row][col] == true;
  var point = 0.0;

  for (var row = 0; row < count; row++) {
    for (var col = 0; col < count; col++) {
      var same = 0;
      final isDark = dark(row, col);
      for (var r = -1; r <= 1; r++) {
        if (row + r < 0 || row + r >= count) continue;
        for (var c = -1; c <= 1; c++) {
          if (col + c < 0 || col + c >= count) continue;
          if (r == 0 && c == 0) continue;
          if (isDark == dark(row + r, col + c)) same++;
        }
      }
      if (same > 5) point += 3 + same - 5;
    }
  }

  for (var row = 0; row < count - 1; row++) {
    for (var col = 0; col < count - 1; col++) {
      var hits = 0;
      if (dark(row, col)) hits++;
      if (dark(row + 1, col)) hits++;
      if (dark(row, col + 1)) hits++;
      if (dark(row + 1, col + 1)) hits++;
      if (hits == 0 || hits == 4) point += 3;
    }
  }

  for (var row = 0; row < count; row++) {
    for (var col = 0; col < count - 6; col++) {
      if (dark(row, col) &&
          !dark(row, col + 1) &&
          dark(row, col + 2) &&
          dark(row, col + 3) &&
          dark(row, col + 4) &&
          !dark(row, col + 5) &&
          dark(row, col + 6)) {
        point += 40;
      }
    }
  }
  for (var col = 0; col < count; col++) {
    for (var row = 0; row < count - 6; row++) {
      if (dark(row, col) &&
          !dark(row + 1, col) &&
          dark(row + 2, col) &&
          dark(row + 3, col) &&
          dark(row + 4, col) &&
          !dark(row + 5, col) &&
          dark(row + 6, col)) {
        point += 40;
      }
    }
  }

  var darkCount = 0;
  for (var row = 0; row < count; row++) {
    for (var col = 0; col < count; col++) {
      if (dark(row, col)) darkCount++;
    }
  }
  final ratio = ((100 * darkCount / count / count) - 50).abs() / 5;
  point += ratio * 10;

  return point;
}

// ── BCH ───────────────────────────────────────────────────────────────────

const int _ecLevelM = 0;
const int _modeByte = 4;
const int _pad0 = 0xEC;
const int _pad1 = 0x11;

int _bchDigit(int value) {
  var digit = 0;
  var v = value;
  while (v != 0) {
    digit++;
    v >>= 1;
  }
  return digit;
}

int _bchTypeInfo(int data) {
  const g15 = 0x537;
  const g15Mask = 0x5412;
  var d = data << 10;
  while (_bchDigit(d) - _bchDigit(g15) >= 0) {
    d ^= g15 << (_bchDigit(d) - _bchDigit(g15));
  }
  return ((data << 10) | d) ^ g15Mask;
}

int _bchTypeNumber(int data) {
  const g18 = 0x1F25;
  var d = data << 12;
  while (_bchDigit(d) - _bchDigit(g18) >= 0) {
    d ^= g18 << (_bchDigit(d) - _bchDigit(g18));
  }
  return (data << 12) | d;
}
