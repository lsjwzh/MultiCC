import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/widgets/chat_notice_scroller.dart';
import 'package:multicc_app/widgets/worktree_status.dart';

Widget _chatLayout(double keyboardInset) => MaterialApp(
  home: MediaQuery(
    data: MediaQueryData(
      size: const Size(390, 844),
      viewInsets: EdgeInsets.only(bottom: keyboardInset),
    ),
    child: Scaffold(
      body: Column(
        children: [
          const SizedBox(height: 90, child: Text('Chat header')),
          ChatNoticeScroller(
            keyboardVisible: keyboardInset > 0,
            children: [
              const SizedBox(height: 120, child: Text('Other notices')),
              WorktreeBehindBanner(
                behind: 4,
                baseBranch: 'main',
                onSync: () {},
                onForceSync: () {},
              ),
            ],
          ),
          const Expanded(child: SizedBox()),
          const SizedBox(
            key: ValueKey('composer'),
            height: 180,
            child: Text('Focused composer'),
          ),
        ],
      ),
    ),
  ),
);

void main() {
  testWidgets('worktree notice clears the keyboard and restores a full-height chat', (
    tester,
  ) async {
    await tester.runAsync(() => I18n.init('zh'));
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 844);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);

    await tester.pumpWidget(_chatLayout(320));
    await tester.pump();

    final composer = tester.getRect(find.byKey(const ValueKey('composer')));
    expect(composer.bottom, lessThanOrEqualTo(844 - 320));
    expect(composer.height, 180);
    final notices = tester.getRect(
      find.byKey(const ValueKey('chat-notices-scroll')),
    );
    final worktree = tester.getRect(find.byType(WorktreeBehindBanner));
    expect(worktree.top, greaterThanOrEqualTo(notices.top));
    expect(worktree.bottom, lessThanOrEqualTo(notices.bottom));
    expect(
      tester.state<ScrollableState>(
        find.descendant(
          of: find.byKey(const ValueKey('chat-notices-scroll')),
          matching: find.byType(Scrollable),
        ),
      ).position.maxScrollExtent,
      greaterThan(0),
    );
    expect(tester.takeException(), isNull);

    await tester.pumpWidget(_chatLayout(0));
    expect(find.byKey(const ValueKey('chat-notices-scroll')), findsNothing);
    expect(
      tester.getRect(find.byKey(const ValueKey('composer'))).bottom,
      844,
      reason: 'hiding the keyboard must return the composer to the screen bottom',
    );
    expect(tester.takeException(), isNull);
  });
}
