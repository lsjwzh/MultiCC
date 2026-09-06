import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/providers/chat_provider.dart';
import 'package:multicc_app/providers/session_manager.dart';
import 'package:multicc_app/services/chat_service.dart';
import 'package:multicc_app/services/settings_service.dart';
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
  void sendMessage(
    String text, {
    bool goal = false,
    Map<String, dynamic>? goalLimits,
  }) {
    sent.add(text);
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
}) {
  return MultiProvider(
    providers: [
      ChangeNotifierProvider<SessionManager>.value(value: manager),
      ChangeNotifierProvider<ChatProvider>.value(value: provider),
    ],
    child: MaterialApp(
      theme: ThemeData(platform: platform),
      home: const Scaffold(
        body: Column(
          children: [
            Expanded(
              child: ColoredBox(
                key: Key('chat-outside-surface'),
                color: Colors.black,
              ),
            ),
            InputBar(),
          ],
        ),
      ),
    ),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

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
      expect(tester.widget<Icon>(sendIcon).color, const Color(0xFF454b54));
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
