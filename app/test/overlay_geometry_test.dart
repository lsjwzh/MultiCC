import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/utils/overlay_geometry.dart';

// 打开对话是一层浮层（三端同一套规矩）：默认盖满内容区、页头留在外面当快捷入口，
// 展开才连页头一起盖。App 这一侧的落点就是这两个数 —— 它们算错了，要么浮层盖住
// 页头（☰ 点不到，「换任务仍是一步」就不成立了），要么浮层缩在页头下面露出一条
// 底页。「0.9 那种按屏幕比例拍脑袋的停位」是这套规矩之前的写法，这一条看着它别回来。
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

  test('两个浮层用的是同一份停位，页头那条线也只有一个来源', () {
    final shell = File('lib/screens/main_shell.dart').readAsStringSync();
    // 对话浮层与目录详情浮层各两次（进场的动画目标 + 拖动落点/遮罩边界）。
    expect(
      RegExp(r'_overlaySnapFraction\(').allMatches(shell).length,
      greaterThanOrEqualTo(4),
      reason: '两个浮层都要按同一个停位摆；少一个就会一层压在另一层外面',
    );
    expect(
      RegExp(r'_overlayContentTop\(').allMatches(shell).length,
      greaterThanOrEqualTo(3),
      reason: '遮罩与浮层主体都要从内容区顶端开始',
    );
    // 老写法：按屏幕比例硬编码一个停位（0.9 = 盖住 90%，页头整个被压住）。
    expect(
      RegExp(r'_snap(Half|Default)\s*=\s*0\.\d+').hasMatch(shell),
      isFalse,
      reason: '停位只能来自 overlay_geometry，不能再按屏幕比例拍一个',
    );
    // 展开是用户的出口：默认态页头还在外面，展开之后页头被盖住 —— 这颗按钮是那会儿
    // 唯一的退路（加上下拉手势与 Android 返回键）。
    expect(shell, contains("ValueKey('chat-sheet-expand')"));
    expect(shell, contains('Icons.open_in_full_rounded'));
    expect(shell, contains('Icons.close_fullscreen_rounded'));
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
    expect(home, contains('await mgr.requestCloseFleetDir()'));
  });
}
