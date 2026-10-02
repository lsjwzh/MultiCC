import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/services/manage_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/bark_devices_card.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _Manage extends ManageService {
  _Manage(SettingsService settings) : super(settings: settings);
  final calls = <Map<String, dynamic>>[];
  final devices = <Map<String, dynamic>>[
    {'id': 'old', 'name': '原有手机', 'enabled': true},
  ];
  bool failTest = false;
  @override
  Future<Map<String, dynamic>> barkDeviceAction(
    Map<String, dynamic> action,
  ) async {
    calls.add(action);
    switch (action['action']) {
      case 'add':
        devices.add({'id': 'new', 'name': action['name'], 'enabled': true});
        return {'id': 'new', 'devices': List.of(devices)};
      case 'test':
        if (failTest) throw Exception('bark_test_failed');
        return {'ok': true};
      case 'update':
        devices.firstWhere((d) => d['id'] == action['id'])['enabled'] =
            action['enabled'];
      case 'remove':
        devices.removeWhere((d) => d['id'] == action['id']);
    }
    return {'devices': List.of(devices)};
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late SettingsService settings;
  setUpAll(() async {
    SharedPreferences.setMockInitialValues({});
    settings = await SettingsService.getInstance();
    await I18n.init('zh');
  });

  Future<void> show(WidgetTester tester, _Manage manage) async {
    tester.view.physicalSize = const Size(900, 1600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: BarkDevicesCard(
              service: manage,
              devices: List.of(manage.devices),
            ),
          ),
        ),
      ),
    );
  }

  testWidgets(
    'add and test targets the new phone without replacing the old one',
    (tester) async {
      final manage = _Manage(settings);
      await show(tester, manage);
      await tester.tap(find.text('添加一台手机'));
      await tester.pump();
      await tester.enterText(find.byType(TextField).at(0), '我的 iPhone');
      await tester.enterText(
        find.byType(TextField).at(1),
        'https://api.day.app/FIXTURE',
      );
      await tester.tap(find.text('添加并测试'));
      await tester.pumpAndSettle();
      expect(find.text('原有手机'), findsOneWidget);
      expect(find.text('我的 iPhone'), findsOneWidget);
      expect(manage.calls.map((c) => c['action']), ['add', 'test']);
      expect(manage.calls.last['id'], 'new');
      expect(find.textContaining('Bark 已接受测试'), findsOneWidget);
      await tester.tap(find.text('添加一台手机'));
      await tester.pump();
      expect(
        tester.widget<TextField>(find.byType(TextField).at(1)).controller!.text,
        isEmpty,
      );
    },
  );

  testWidgets(
    'saved phone remains after test failure and can be tested again',
    (tester) async {
      final manage = _Manage(settings)..failTest = true;
      await show(tester, manage);
      await tester.tap(find.text('添加一台手机'));
      await tester.pump();
      await tester.enterText(find.byType(TextField).at(0), '工作手机');
      await tester.enterText(
        find.byType(TextField).at(1),
        'https://api.day.app/FIXTURE',
      );
      await tester.tap(find.text('添加并测试'));
      await tester.pumpAndSettle();
      expect(find.text('工作手机'), findsOneWidget);
      expect(find.textContaining('手机已添加，但测试未成功'), findsOneWidget);
      manage.failTest = false;
      await tester.tap(find.text('测试这台手机').last);
      await tester.pumpAndSettle();
      expect(manage.calls.last['id'], 'new');
      expect(find.textContaining('Bark 已接受测试'), findsOneWidget);
    },
  );

  testWidgets('pause and confirmed removal affect only their selected device', (
    tester,
  ) async {
    final manage = _Manage(settings);
    await show(tester, manage);
    await tester.tap(find.text('暂停提醒'));
    await tester.pumpAndSettle();
    expect(find.text('已暂停任务提醒'), findsOneWidget);
    expect(manage.calls.last, {
      'action': 'update',
      'id': 'old',
      'enabled': false,
    });
    await tester.tap(find.text('移除手机'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('移除手机').last);
    await tester.pumpAndSettle();
    expect(find.text('原有手机'), findsNothing);
    expect(manage.calls.last, {'action': 'remove', 'id': 'old'});
  });
}
