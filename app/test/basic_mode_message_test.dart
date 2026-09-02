import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/message_bubble.dart';
import 'package:multicc_app/widgets/tool_card.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    SharedPreferences.setMockInitialValues(const {});
    await SettingsService.getInstance();
    await I18n.init('zh');
  });

  testWidgets(
    'basic mode summarizes tool work and reveals raw details on tap',
    (tester) async {
      final message = ChatMessage(
        role: MessageRole.assistant,
        content: '已经完成整理。',
        toolCalls: [
          ToolCall(
            id: 'tool-1',
            name: 'Read',
            inputJson: '{"file_path":"notes.md"}',
            result: 'ok',
            isDone: true,
          ),
        ],
      );
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(width: 390, child: MessageBubble(message: message)),
          ),
        ),
      );

      expect(find.byKey(const ValueKey('basic-tool-summary')), findsOneWidget);
      expect(find.text('处理步骤已完成'), findsOneWidget);
      expect(find.byType(ToolCardWidget), findsNothing);

      await tester.tap(find.byKey(const ValueKey('basic-tool-summary')));
      await tester.pump();
      expect(find.byType(ToolCardWidget), findsOneWidget);
    },
  );
}
