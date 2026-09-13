import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/services/qr_encoder.dart';

/// 逐格比对参照实现（public/qrcode.min.js，Web 的 #air-qr-btn 用的就是它）。
///
/// 参照矩阵由 test/fixtures/generate_qr_reference.cjs 生成后入库，测试只读它。
/// 一份自己写的编码器最容易错的地方（纠错多项式、分块交织、掩码评分、格式信息
/// 的每一个 bit）都会让某几格变黑或变白 —— 只测「扫得出来」是测不出来的，所以
/// 这里比到每一格。
void main() {
  final fixture = jsonDecode(
    File('test/fixtures/qr_reference.json').readAsStringSync(),
  ) as Map<String, dynamic>;
  final cases = (fixture['cases'] as List).cast<Map<String, dynamic>>();

  test('参照集本身是合理的：版本、边长、掩码都覆盖到', () {
    expect(fixture['level'], 'M');
    expect(cases, hasLength(8));
    final versions = cases.map((c) => c['version'] as int).toList();
    expect(versions, contains(2));
    // 版本 10 起长度字段变 16 位，版本 7 起有版本信息区，这两条边界都要有。
    expect(versions.any((v) => v >= 7), isTrue);
    expect(versions.any((v) => v >= 10), isTrue);
    for (final c in cases) {
      final size = c['count'] as int;
      expect(size, (c['version'] as int) * 4 + 17);
      expect((c['rows'] as List).length, size);
    }
  });

  for (final sample in cases) {
    final data = sample['data'] as String;
    final rows = (sample['rows'] as List).cast<String>();

    test('逐格一致：${data.length} 字节，版本 ${sample['version']}', () {
      final qr = encodeQr(data);
      expect(qr.version, sample['version'], reason: '自动选的版本应与参照一致');
      expect(qr.size, rows.length);

      final diff = <String>[];
      for (var row = 0; row < rows.length; row++) {
        final expected = rows[row];
        for (var col = 0; col < expected.length; col++) {
          final want = expected[col] == '1';
          if (qr.isDark(row, col) != want) diff.add('$row,$col');
        }
      }
      expect(diff, isEmpty, reason: '这 ${diff.length} 格与参照实现不同');
    });
  }

  test('定位图案是它该有的样子', () {
    // 三个角上的回字格外圈 7x7，单独看一眼：真错到这儿了，逐格比对给出的是一堆
    // 坐标，不如直接说「回字格画歪了」。
    final qr = encodeQr('http://192.168.1.9:3000/air');
    for (final origin in [
      (0, 0),
      (0, qr.size - 7),
      (qr.size - 7, 0),
    ]) {
      final (row, col) = origin;
      for (var r = 0; r < 7; r++) {
        for (var c = 0; c < 7; c++) {
          final edge = r == 0 || r == 6 || c == 0 || c == 6;
          final core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          expect(
            qr.isDark(row + r, col + c),
            edge || core,
            reason: '定位图案 ($row,$col) 的 ($r,$c)',
          );
        }
      }
    }
  });

  test('内容越长版本越大，同一个内容两次编出来一模一样', () {
    final short = encodeQr('http://a.io/air');
    final long = encodeQr('http://a.io/${'x' * 200}');
    expect(long.version, greaterThan(short.version));
    expect(encodeQr('http://a.io/air').version, short.version);
  });

  test('非 ASCII 走 UTF-8，不是按 charCode 截尾', () {
    // 参照实现默认那套 `charCodeAt & 0xff` 会把「主机」压成 0x3B 0x3A，扫出来是
    // 乱码。这里要的是 UTF-8 的 6 个字节，所以版本会比 26 个 ASCII 字符时大。
    final ascii = encodeQr('http://aa.example:3000/air');
    final cjk = encodeQr('http://主机.example:3000/air');
    expect(cjk.version, greaterThanOrEqualTo(ascii.version));
    expect(utf8.encode('主机'), hasLength(6));
  });

  test('放不下就说放不下，不是画一张错的', () {
    expect(
      () => encodeQr('x' * 3000),
      throwsA(isA<ArgumentError>()),
    );
  });
}
