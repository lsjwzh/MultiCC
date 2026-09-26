import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/widgets/air/air_panels.dart';
import 'package:multicc_app/widgets/air/air_task_status.dart';

AirTask task(String id, {String status = 'active', String? runState}) =>
    AirTask(
      id: id,
      dirId: 'd',
      title: id,
      status: status,
      recordType: '',
      updatedAt: 0,
      readOnly: false,
      runState: runState,
    );

void main() {
  final tasks = [
    task('running', runState: 'running'),
    task('waiting', runState: 'waiting'),
    task('error', runState: 'error'),
    task('success', runState: 'succeeded'),
    task('legacy', status: 'done', runState: 'succeeded'),
    task('archived', status: 'archived', runState: 'running'),
  ];

  test(
    'counts and filters exclude legacy done and archived execution states',
    () {
      for (final filter in [
        AirDirectoryTaskFilter.running,
        AirDirectoryTaskFilter.waiting,
        AirDirectoryTaskFilter.error,
        AirDirectoryTaskFilter.succeeded,
      ]) {
        expect(tasks.where(filter.matches).length, 1, reason: filter.name);
      }
      expect(tasks.where(AirDirectoryTaskFilter.all.matches).length, 6);
      expect(tasks.where(AirDirectoryTaskFilter.open.matches).length, 4);
      expect(tasks.where(AirDirectoryTaskFilter.archived.matches).length, 1);
    },
  );

  for (final width in [320.0, 430.0, 1280.0]) {
    testWidgets('five counters are clickable without overflow at $width px', (
      tester,
    ) async {
      tester.view.physicalSize = Size(width, 932);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      AirDirectoryTaskFilter? selected;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AirDirectoryStats(
              tasks: tasks,
              worktreeCount: 2,
              onFilter: (f) => selected = f,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      for (final filter in [
        AirDirectoryTaskFilter.running,
        AirDirectoryTaskFilter.waiting,
        AirDirectoryTaskFilter.error,
        AirDirectoryTaskFilter.succeeded,
        AirDirectoryTaskFilter.all,
      ]) {
        expect(find.text(filter.label), findsOneWidget);
        await tester.tap(find.byKey(ValueKey('air-stat-${filter.name}')));
        expect(selected, filter);
      }
      expect(find.text('1'), findsNWidgets(4));
      expect(find.text('6'), findsOneWidget);
      expect(find.text('1 个已归档 · 2 个 WT'), findsOneWidget);
      expect(find.text('已完成'), findsNothing);
      expect(find.text('计划任务'), findsNothing);
      expect(tester.takeException(), isNull);
    });
  }
}
