import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/screens/chat_width_dialog.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/worktree_status.dart';

/// 工作树冲突横幅 / 强制同步按钮 / 聊天宽度弹窗的 widget 测试。
///
/// 这三块是 Web 已有一份、App 补齐的：`chat-worktree-status.js` 的冲突横幅、
/// `chat-worktree-sync.js` 的强制同步、`chat-layout.js` 的宽度设置。文案与显隐
/// 规则都容易改坏，所以在这里钉住。

Future<SettingsService> _settings() async {
  SharedPreferences.setMockInitialValues({
    'multicc_host': 'http://127.0.0.1:1',
    'multicc_token': '',
  });
  return SettingsService.getInstance();
}

Widget _host(Widget child) => MaterialApp(
      home: Scaffold(body: child),
    );

/// 弹窗要一个真实 context，且保存后会 SnackBar —— 所以挂一棵有 Scaffold 的树。
Widget _launcher(SettingsService settings) => MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => Center(
            child: TextButton(
              onPressed: () => showChatWidthDialog(context, settings),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() => I18n.init('zh'));

  group('WorktreeConflictBanner', () {
    testWidgets('报冲突文件数，三个动作 + 强制同步各自回调', (tester) async {
      final files = ['app/lib/screens/chat_screen.dart', 'src/git/service.js'];
      var helped = 0;
      var continued = 0;
      var aborted = 0;
      var forced = 0;

      await tester.pumpWidget(
        _host(
          WorktreeConflictBanner(
            files: files,
            onHelp: () => helped++,
            onContinue: () => continued++,
            onAbort: () => aborted++,
            onForceSync: () => forced++,
          ),
        ),
      );

      expect(find.byKey(const Key('worktree-conflict-bar')), findsOneWidget);
      // 横幅只报个数（文件多了放不下），完整清单在 tooltip 里。
      expect(find.text('⚠️ 同步冲突：2 个文件待解决'), findsOneWidget);
      expect(find.byTooltip(files.join('\n')), findsOneWidget);

      await tester.tap(find.text('如何解决'));
      expect(helped, 1);
      await tester.tap(find.text('继续'));
      expect(continued, 1);
      await tester.tap(find.text('放弃'));
      expect(aborted, 1);
      await tester.tap(find.text('强制同步'));
      expect(forced, 1);
    });

    testWidgets('文件数为 1 时单复数正确', (tester) async {
      await tester.pumpWidget(
        _host(
          WorktreeConflictBanner(
            files: const ['src/server.js'],
            onHelp: () {},
            onContinue: () {},
            onAbort: () {},
            onForceSync: () {},
          ),
        ),
      );
      expect(find.text('⚠️ 同步冲突：1 个文件待解决'), findsOneWidget);
    });
  });

  group('WorktreeForceSyncButton', () {
    testWidgets('在途时按钮禁用并改文案', (tester) async {
      var pressed = 0;
      await tester.pumpWidget(
        _host(
          WorktreeForceSyncButton(
            busy: false,
            onPressed: () => pressed++,
            color: const Color(0xFF1267b5),
          ),
        ),
      );
      expect(find.text('强制同步'), findsOneWidget);
      // 「指令是发给会话的」这层意思写在 tooltip 上。
      expect(find.byTooltip('发送同步指令，由会话保留改动并处理冲突；忙碌时排队'), findsOneWidget);
      await tester.tap(find.text('强制同步'));
      expect(pressed, 1);

      await tester.pumpWidget(
        _host(
          WorktreeForceSyncButton(
            busy: true,
            onPressed: () => pressed++,
            color: const Color(0xFF1267b5),
          ),
        ),
      );
      expect(find.text('正在发送…'), findsOneWidget);
      expect(find.text('强制同步'), findsNothing);
      // busy 时 onPressed 为 null：连点不会变成两条同步指令。
      final button = tester.widget<TextButton>(find.byType(TextButton));
      expect(button.onPressed, isNull);
      await tester.tap(find.text('正在发送…'), warnIfMissed: false);
      expect(pressed, 1);

      // 内置的 buttonKey 由调用方给：这里没传就不该有 id（两个容器可能同时在）。
      expect(find.byKey(const Key('worktree-force-sync-btn')), findsNothing);
    });
  });

  group('showChatWidthDialog', () {
    testWidgets('默认 980 且开着限制', (tester) async {
      final settings = await _settings();
      addTearDown(() => settings.chatWidth.value = ChatWidthSetting.defaults);

      await tester.pumpWidget(_launcher(settings));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      expect(find.text('980 px'), findsOneWidget);
      expect(
        tester.widget<Checkbox>(find.byKey(const Key('chat-width-limit'))).value,
        isTrue,
      );

      await tester.tap(find.byKey(const Key('chat-width-cancel')));
      await tester.pumpAndSettle();
    });

    testWidgets('拖滑杆实时改宽度（未保存也先预览）', (tester) async {
      final settings = await _settings();
      addTearDown(() => settings.chatWidth.value = ChatWidthSetting.defaults);

      await tester.pumpWidget(_launcher(settings));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      // 直接驱动 onChanged：drag 的落点取决于滑杆像素宽度，算不出整数步。
      final slider = tester.widget<Slider>(
        find.byKey(const Key('chat-width-slider')),
      );
      slider.onChanged!(1200);
      await tester.pump();

      // 吸到 40 的整数倍，且立刻写进 notifier（聊天区即时重排）。
      expect(settings.chatWidth.value.max, 1200);
      expect(settings.chatWidth.value.limited, isTrue);
      expect(find.text('1200 px'), findsOneWidget);

      // 取消要回滚，别把预览留在那儿。
      await tester.tap(find.byKey(const Key('chat-width-cancel')));
      await tester.pumpAndSettle();
      expect(settings.chatWidth.value, ChatWidthSetting.defaults);
    });

    testWidgets('关掉限制时滑杆变灰，保存后落盘', (tester) async {
      final settings = await _settings();
      addTearDown(() => settings.chatWidth.value = ChatWidthSetting.defaults);

      await tester.pumpWidget(_launcher(settings));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('chat-width-limit')));
      await tester.pumpAndSettle();

      expect(settings.chatWidth.value.limited, isFalse);
      // 铺满模式下那个数字不生效，让滑杆可拖等于骗人。
      expect(
        tester.widget<Slider>(find.byKey(const Key('chat-width-slider'))).onChanged,
        isNull,
      );

      await tester.tap(find.byKey(const Key('chat-width-save')));
      await tester.pumpAndSettle();

      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getBool('multicc_chat_width_limited'), isFalse);
      expect(find.text('✓ 已保存：聊天区铺满可用空间'), findsOneWidget);
      expect(settings.chatWidth.value.limited, isFalse);
    });

    testWidgets('恢复默认只拨草稿，保存后才落盘', (tester) async {
      final settings = await _settings();
      addTearDown(() => settings.chatWidth.value = ChatWidthSetting.defaults);

      await tester.pumpWidget(_launcher(settings));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      final slider = tester.widget<Slider>(
        find.byKey(const Key('chat-width-slider')),
      );
      slider.onChanged!(1600);
      await tester.pump();
      expect(find.text('1600 px'), findsOneWidget);

      await tester.tap(find.byKey(const Key('chat-width-reset')));
      await tester.pumpAndSettle();
      expect(find.text('980 px'), findsOneWidget);

      // 还没保存：此时取消应该回到打开前的 980（也就是默认值）。
      await tester.tap(find.byKey(const Key('chat-width-save')));
      await tester.pumpAndSettle();
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getInt('multicc_chat_width_max'), 980);
    });
  });
}
