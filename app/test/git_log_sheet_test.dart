import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/models/git_commit.dart';
import 'package:multicc_app/widgets/git_log_sheet.dart';

/// The git-history sheet is driven entirely through injected fetchers, so the
/// widget tests need no network: they pin the list rendering, the empty and
/// error states, the all-branches re-fetch, and the commit detail page.
const _h1 = 'a1b2c3d4e5f6';
const _h2 = 'f6e5d4c3b2a1';

Future<List<GitCommit>> _ok() async => [
  GitCommit(
    hash: _h1, short: _h1.substring(0, 7),
    author: '绿', date: '2026-08-16T09:41:02+08:00',
    subject: 'fix(ui): wrap the usage line', refs: 'HEAD -> multicc/s1',
  ),
  GitCommit(
    hash: _h2, short: _h2.substring(0, 7),
    author: '蓝', date: '2026-08-15T18:02:00+08:00',
    subject: 'docs: audit', refs: '',
  ),
];

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  Widget host({required Future<List<GitCommit>> Function(bool) fetchLog}) =>
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => Center(
              child: ElevatedButton(
                onPressed: () => showGitLogSheet(
                  context,
                  fetchLog: fetchLog,
                  fetchDiff: (hash) async => GitCommitDiff(
                    hash: hash,
                    stat: '1 file changed, 2 insertions(+)',
                    diff: 'diff --git a/foo b/foo\n+hello',
                    truncated: false,
                  ),
                ),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      );

  Future<void> open(WidgetTester tester) async {
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
  }

  testWidgets('renders the commit list with hash, refs, subject and author', (
    tester,
  ) async {
    await tester.pumpWidget(host(fetchLog: (all) async => await _ok()));
    await open(tester);
    expect(find.text('fix(ui): wrap the usage line'), findsOneWidget);
    expect(find.text(_h1.substring(0, 7)), findsOneWidget);
    expect(find.textContaining('HEAD -> multicc/s1'), findsOneWidget);
    expect(find.textContaining('绿 · 2026-08-16 09:41'), findsOneWidget);
    expect(find.text('docs: audit'), findsOneWidget);
  });

  testWidgets('an empty history renders the empty state, not a blank', (
    tester,
  ) async {
    await tester.pumpWidget(host(fetchLog: (all) async => const []));
    await open(tester);
    expect(find.text('（无提交记录）'), findsOneWidget);
  });

  testWidgets('a failed fetch surfaces the error with the sheet intact', (
    tester,
  ) async {
    await tester.pumpWidget(
      host(fetchLog: (all) async => throw Exception('boom')),
    );
    await open(tester);
    expect(find.textContaining('加载 Git 记录失败'), findsOneWidget);
    expect(find.textContaining('boom'), findsOneWidget);
  });

  testWidgets('the all-branches toggle re-fetches with the flag on', (
    tester,
  ) async {
    var sawAll = false;
    await tester.pumpWidget(host(fetchLog: (all) async {
      sawAll = all;
      return await _ok();
    }));
    await open(tester);
    // The first load must be branch-only, i.e. the flag comes through as false.
    expect(sawAll, isFalse);
    await tester.tap(find.text('全部分支'));
    await tester.pumpAndSettle();
    expect(sawAll, isTrue);
  });

  testWidgets('tapping a commit opens stat + colored diff', (tester) async {
    await tester.pumpWidget(host(fetchLog: (all) async => await _ok()));
    await open(tester);
    await tester.tap(find.text('fix(ui): wrap the usage line'));
    await tester.pumpAndSettle();
    expect(find.textContaining('1 file changed, 2 insertions(+)'), findsOneWidget);
    expect(find.textContaining('+hello'), findsOneWidget);
  });
}
