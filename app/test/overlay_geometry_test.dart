import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/utils/overlay_geometry.dart';

// 打开对话是一层浮层（三端同一套规矩）：对话默认满屏展开（顶部不留可拖的闲置区），
// 其它浮层按 overlay_geometry 的停位摆。App 这一侧的落点就是这两个数 —— 它们算错了，
// 要么浮层盖住页头（☰ 点不到，「换任务仍是一步」就不成立了），要么浮层缩在页头下面
// 露出一条底页。「0.9 那种按屏幕比例拍脑袋的停位」是这套规矩之前的写法，这一条看着
// 它别回来。
void main() {
  const phone = MediaQueryData(
    size: Size(390, 844),
    padding: EdgeInsets.only(top: 47, bottom: 34),
  );

  test('默认停位落在页头下沿：让出状态栏与 AppBar，剩下的都归浮层', () {
    expect(overlayContentTop(phone), 47 + kToolbarHeight); // 103
    expect(
      overlaySnapFraction(phone),
      closeTo((844 - (47 + kToolbarHeight)) / 844, 1e-9),
    );
    // 盖住的那一段 + 让出去的那一段 = 整屏，中间不留缝。
    final covered = 844 * overlaySnapFraction(phone);
    expect(covered + overlayContentTop(phone), closeTo(844, 1e-9));
  });

  test('没有刘海/状态栏的屏上，让出去的就是页头那一条', () {
    const flat = MediaQueryData(size: Size(800, 600));
    expect(overlayContentTop(flat), kToolbarHeight);
    expect(overlaySnapFraction(flat), closeTo((600 - kToolbarHeight) / 600, 1e-9));
  });

  test('窗口比页头还矮时盖满，而不是算出负数', () {
    const squat = MediaQueryData(
      size: Size(700, 100),
      padding: EdgeInsets.only(top: 47),
    );
    expect(overlaySnapFraction(squat), 1.0);
  });

  test('停位与页头那条线只有一个来源；对话浮层默认展开不再依赖停位', () {
    final shell = File('lib/screens/main_shell.dart').readAsStringSync();
    // 停位只从 overlay_geometry 取：main_shell 不再出现按屏幕比例拍出来的硬编码
    // 停位。对话浮层默认满屏展开（不再停在内容区顶端），目录详情浮层等其它浮层
    // 仍按同一份停位摆（overlay_geometry.dart 是这两个量的唯一来源）。
    expect(
      RegExp(r'_snap(Half|Default)\s*=\s*0\.\d+').hasMatch(shell),
      isFalse,
      reason: '停位只能来自 overlay_geometry，不能再按屏幕比例拍一个',
    );
    // 对话浮层默认展开：那颗「展开/收起」按钮整条收掉，不再出现在聊天顶部。
    expect(shell, isNot(contains("ValueKey('chat-sheet-expand')")));
    expect(shell, isNot(contains('Icons.open_in_full_rounded')));
    expect(shell, isNot(contains('Icons.close_fullscreen_rounded')));
    // 收起入口挪到聊天页自己：标题左侧 ⌄ + 标题区域往下拖。
    expect(shell, contains('onSheetDragUpdate'));
    expect(shell, contains('onSheetDragEnd'));
    // 两个量的唯一实现仍住在 utils/overlay_geometry.dart（被上面积分测试直接量）。
    final util = File('lib/utils/overlay_geometry.dart').readAsStringSync();
    expect(util, contains('double overlaySnapFraction'));
    expect(util, contains('double overlayContentTop'));
  });

  test('AppBar 的 ☰ 先让浮层让开再拉抽屉', () {
    final view = File('lib/widgets/air_tasks_view.dart').readAsStringSync();
    expect(view, contains('beforeOpenNavigation'));
    expect(
      view,
      contains('await before()'),
      reason: '抽屉属于内层 Scaffold，浮层不让开就会被压在底下（屏幕上什么也看不到）',
    );
    final home = File('lib/screens/main_shell.dart').readAsStringSync();
    expect(home, contains('beforeOpenNavigation: () async {'));
    expect(home, contains('await mgr.requestCloseChat()'));
  });
}
