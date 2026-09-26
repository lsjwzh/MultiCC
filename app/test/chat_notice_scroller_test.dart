import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/widgets/chat_notice_scroller.dart';
import 'package:multicc_app/widgets/worktree_status.dart';

void main() {
  testWidgets('worktree notice scrolls instead of covering the composer above the keyboard', (
    tester,
  ) async {
    await tester.runAsync(() => I18n.init('zh'));
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 844);
    tester.view.viewInsets = const FakeViewPadding(bottom: 320);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetViewInsets);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Column(
            children: [
              const SizedBox(height: 90, child: Text('Chat header')),
              ChatNoticeScroller(
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
  });
}
