import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/providers/chat_provider.dart';
import 'package:multicc_app/providers/session_manager.dart';
import 'package:multicc_app/models/dispatch_queue.dart';
import 'package:multicc_app/services/chat_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/chat_notice_scroller.dart';
import 'package:multicc_app/widgets/dispatch_floating_dock.dart';
import 'package:multicc_app/widgets/input_bar.dart';

class _ConnectedChatProvider extends ChatProvider {
  final sent = <String>[];
  ChatConnectionState _connectionState = ChatConnectionState.connected;

  _ConnectedChatProvider({required super.settings})
    : super(sessionName: 'keyboard-test', sessionCwd: '/tmp');

  @override
  ChatConnectionState get connectionState => _connectionState;

  void setConnectionState(ChatConnectionState value) {
    _connectionState = value;
    notifyListeners();
  }

  @override
  bool get isStreaming => false;

  @override
  String? sendMessage(String text, {String? clientMsgId, String? voiceRaw}) {
    sent.add(text);
    return 'test-msg';
  }
}

Future<SettingsService> _settings() async {
  SharedPreferences.setMockInitialValues({
    'multicc_host': 'http://127.0.0.1:1',
    'multicc_token': '',
  });
  return SettingsService.getInstance();
}

Widget _host({
  required TargetPlatform platform,
  required SessionManager manager,
  required ChatProvider provider,
  bool withDock = false,
}) {
  return MultiProvider(
    providers: [
      ChangeNotifierProvider<SessionManager>.value(value: manager),
      ChangeNotifierProvider<ChatProvider>.value(value: provider),
    ],
    child: MaterialApp(
      theme: ThemeData(platform: platform),
      home: Scaffold(
        body: Column(
          children: [
            Expanded(
              child: ChatNoticeScroller(
                keyboardVisible: false,
                notices: const [],
                messageList: const ColoredBox(
                  key: Key('chat-outside-surface'),
                  color: Colors.black,
                ),
                overlays: [
                  if (withDock)
                    DispatchFloatingDock(
                      entries: const [
                        DispatchQueueEntry(
                          operationId: 'layout-test',
                          relation: 'owner',
                          targetSessionId: 'worker',
                          mode: 'async',
                          queueState: 'running',
                        ),
                      ],
                      resolveName: (id) => id,
                      leftMinBottom: 12,
                      rightMinBottom: 12,
                    ),
                ],
              ),
            ),
            const InputBar(),
          ],
        ),
      ),
    ),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  for (final textScale in [1.0, 1.3]) {
    testWidgets(
      'Android composer clears docks through keyboard and draft resizing at scale $textScale',
      (tester) async {
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = const Size(384, 854);
        tester.platformDispatcher.textScaleFactorTestValue = textScale;
        addTearDown(tester.view.resetDevicePixelRatio);
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetViewInsets);
        addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
        final settings = await _settings();
        final manager = SessionManager(settings: settings);
        final provider = _ConnectedChatProvider(settings: settings);
        await tester.pumpWidget(
          _host(
            platform: TargetPlatform.android,
            manager: manager,
            provider: provider,
            withDock: true,
          ),
        );
        await tester.pump();

        for (final keyboardHeight in [320.0, 380.0, 0.0]) {
          tester.view.viewInsets = FakeViewPadding(bottom: keyboardHeight);
          for (final draft in [
            'one line',
            List.filled(6, 'draft line').join('\n'),
          ]) {
            final input = find.byKey(const Key('chat-message-input'));
            await tester.enterText(input, draft);
            await tester.pump();
            final composer = tester.getRect(find.byType(InputBar));
            final dock = tester.getRect(
              find.byKey(const Key('dispatch-dock-icon')),
            );
            final band = tester.getRect(
              find.byKey(const Key('chat-composer-band')),
            );
            final card = tester.getRect(
              find.byKey(const Key('chat-composer-card')),
            );
            expect(composer.bottom, 854 - keyboardHeight);
            expect(dock.bottom, lessThanOrEqualTo(composer.top));
            expect(dock.overlaps(band), isFalse);
            expect(dock.overlaps(card), isFalse);
            expect(band.bottom, card.top);
            expect(tester.widget<TextField>(input).focusNode!.hasFocus, isTrue);
            expect(tester.widget<TextField>(input).controller!.text, draft);
            expect(tester.takeException(), isNull);
          }
        }

        await tester.pumpWidget(const SizedBox.shrink());
        provider.dispose();
        manager.dispose();
      },
    );
  }

  testWidgets('iOS send hides the keyboard after dispatching the message', (
    tester,
  ) async {
    final settings = await _settings();
    final manager = SessionManager(settings: settings);
    final provider = _ConnectedChatProvider(settings: settings);

    await tester.pumpWidget(
      _host(platform: TargetPlatform.iOS, manager: manager, provider: provider),
    );
    await tester.enterText(
      find.byKey(const Key('chat-message-input')),
      'send from ios',
    );
    await tester.pump();
    final input = tester.widget<TextField>(
      find.byKey(const Key('chat-message-input')),
    );
    expect(input.focusNode!.hasFocus, isTrue);

    await tester.tap(find.byIcon(Icons.send_rounded));
    await tester.pump();

    expect(provider.sent, ['send from ios']);
    expect(input.focusNode!.hasFocus, isFalse);
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('chat-message-input')))
          .controller!
          .text,
      isEmpty,
    );

    await tester.pumpWidget(const SizedBox.shrink());
    provider.dispose();
    manager.dispose();
  });

  testWidgets('iOS outside tap hides keyboard and preserves the draft', (
    tester,
  ) async {
    final settings = await _settings();
    final manager = SessionManager(settings: settings);
    final provider = _ConnectedChatProvider(settings: settings);

    await tester.pumpWidget(
      _host(platform: TargetPlatform.iOS, manager: manager, provider: provider),
    );
    final input = find.byKey(const Key('chat-message-input'));
    await tester.enterText(input, 'draft remains');
    await tester.pump();
    final inputWidget = tester.widget<TextField>(input);
    expect(inputWidget.focusNode!.hasFocus, isTrue);

    await tester.tapAt(const Offset(10, 10));
    await tester.pump();

    expect(inputWidget.focusNode!.hasFocus, isFalse);
    expect(tester.widget<TextField>(input).controller!.text, 'draft remains');
    expect(provider.sent, isEmpty);

    await tester.pumpWidget(const SizedBox.shrink());
    provider.dispose();
    manager.dispose();
  });

  testWidgets(
    'disconnect keeps the composer focused and editable while Send stays gated',
    (tester) async {
      final settings = await _settings();
      final manager = SessionManager(settings: settings);
      final provider = _ConnectedChatProvider(settings: settings);

      await tester.pumpWidget(
        _host(
          platform: TargetPlatform.android,
          manager: manager,
          provider: provider,
        ),
      );
      final input = find.byKey(const Key('chat-message-input'));
      await tester.enterText(input, 'draft before disconnect');
      await tester.pump();
      final sendIcon = find.byIcon(Icons.send_rounded);
      final sendGesture = find.ancestor(
        of: sendIcon,
        matching: find.byType(GestureDetector),
      );
      final staleConnectedSend = tester
          .widget<GestureDetector>(sendGesture)
          .onTap;
      expect(staleConnectedSend, isNotNull);

      provider.setConnectionState(ChatConnectionState.disconnected);
      await tester.pump();

      var inputWidget = tester.widget<TextField>(input);
      expect(inputWidget.enabled, isNot(false));
      expect(inputWidget.focusNode!.hasFocus, isTrue);
      expect(inputWidget.controller!.text, 'draft before disconnect');

      await tester.enterText(input, 'draft while offline');
      await tester.pump();
      inputWidget = tester.widget<TextField>(input);
      expect(inputWidget.focusNode!.hasFocus, isTrue);
      expect(inputWidget.controller!.text, 'draft while offline');

      expect(tester.widget<GestureDetector>(sendGesture).onTap, isNull);
      // Gated also means "reads as gated": the icon keeps the muted disabled
      // ink, not the enabled on-accent white. Asserted against the enabled
      // colour rather than a hex, so re-theming does not red this test.
      expect(tester.widget<Icon>(sendIcon).color, isNot(Colors.white));
      expect(provider.sent, isEmpty);

      // A callback captured just before the socket dropped must still fail
      // closed, explain why, and preserve the offline draft.
      staleConnectedSend!();
      await tester.pump();
      expect(provider.sent, isEmpty);
      expect(inputWidget.controller!.text, 'draft while offline');
      expect(find.text(t('connectionLostRetry')), findsOneWidget);

      provider.setConnectionState(ChatConnectionState.connecting);
      await tester.pump();
      inputWidget = tester.widget<TextField>(input);
      expect(inputWidget.focusNode!.hasFocus, isTrue);
      expect(inputWidget.controller!.text, 'draft while offline');
      expect(tester.widget<GestureDetector>(sendGesture).onTap, isNull);

      provider.setConnectionState(ChatConnectionState.connected);
      await tester.pump();

      inputWidget = tester.widget<TextField>(input);
      expect(inputWidget.focusNode!.hasFocus, isTrue);
      expect(inputWidget.controller!.text, 'draft while offline');
      expect(tester.widget<GestureDetector>(sendGesture).onTap, isNotNull);

      await tester.pumpWidget(const SizedBox.shrink());
      provider.dispose();
      manager.dispose();
    },
  );

  testWidgets('Android send keeps the existing keyboard behaviour', (
    tester,
  ) async {
    final settings = await _settings();
    final manager = SessionManager(settings: settings);
    final provider = _ConnectedChatProvider(settings: settings);

    await tester.pumpWidget(
      _host(
        platform: TargetPlatform.android,
        manager: manager,
        provider: provider,
      ),
    );
    await tester.enterText(
      find.byKey(const Key('chat-message-input')),
      'send from android',
    );
    await tester.pump();
    final input = tester.widget<TextField>(
      find.byKey(const Key('chat-message-input')),
    );

    await tester.tap(find.byIcon(Icons.send_rounded));
    await tester.pump();

    expect(provider.sent, ['send from android']);
    expect(input.focusNode!.hasFocus, isTrue);

    await tester.pumpWidget(const SizedBox.shrink());
    provider.dispose();
    manager.dispose();
  });
}
