import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/screens/machine_settings_screen.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/air/air_computers.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 多电脑页面的文案与页头：文案全部走 i18n（中文与旧硬编码逐字一致），
/// 电脑设置页只保留 `ComputerTargetShell` 那一层页头，标题是目标电脑名。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    SharedPreferences.setMockInitialValues({});
    await I18n.init('zh');
  });
  tearDown(() => I18n.switchLang('zh'));

  Future<SettingsService> entry() async {
    final settings = await SettingsService.getInstance();
    await settings.save(
      host: 'https://entry.example',
      token: 'fixture-token',
      session: 'entry-session',
      cwd: '/entry',
    );
    return settings;
  }

  MockClient machinesClient({
    String localName = '本机',
    String entryName = '工作电脑',
  }) => MockClient((request) async {
    final path = request.url.path;
    final data = path == '/api/machines'
        ? {
            'self': {'id': 'machine_entry', 'name': localName, 'local': true},
            'machines': [
              {
                'id': 'machine_a',
                'name': entryName,
                'local': false,
                'origin': 'https://remote.example',
              },
            ],
          }
        : path.endsWith('/api/air')
        ? {
            'ok': true,
            'directories': [
              {'id': 'same-dir', 'name': 'projects', 'path': '/projects'},
            ],
            'tasks': [],
            'sessions': [],
          }
        : <String, dynamic>{};
    return http.Response(
      jsonEncode(data),
      200,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );
  });

  Widget computersHost(SettingsService settings, http.Client client) =>
      MaterialApp(
        home: Scaffold(
          body: AirComputers(
            settings: settings,
            httpClient: client,
            onLocalDirectory: (_) {},
            onLocalSettings: () {},
          ),
        ),
      );

  testWidgets('computers page renders English copy in the en locale', (
    tester,
  ) async {
    I18n.switchLang('en');
    final settings = await entry();
    final client = machinesClient(localName: 'Local Mac', entryName: 'Entry Mac');
    await tester.pumpWidget(computersHost(settings, client));
    await tester.pumpAndSettle();

    expect(find.text('Add computer'), findsOneWidget);
    expect(find.text('Access to the entry computer'), findsOneWidget);
    await tester.tap(find.text('Entry Mac'));
    await tester.pumpAndSettle();

    expect(find.text('Target computer: Entry Mac'), findsOneWidget);
    expect(
      find.text('Connected · actions apply to this computer'),
      findsOneWidget,
    );
    expect(find.text('Computer settings'), findsOneWidget);
    expect(find.text('Reconnect'), findsOneWidget);
    expect(find.text('Remove connection'), findsOneWidget);

    await tester.tap(find.text('Add computer'));
    await tester.pumpAndSettle();
    expect(find.text('Add computer'), findsWidgets);
    expect(
      find.text('Server address (including protocol and port)'),
      findsOneWidget,
    );
    expect(find.textContaining('plaintext'), findsOneWidget);

    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('computers page keeps the original Chinese copy in the zh locale', (
    tester,
  ) async {
    I18n.switchLang('zh');
    final settings = await entry();
    final client = machinesClient();
    await tester.pumpWidget(computersHost(settings, client));
    await tester.pumpAndSettle();

    expect(find.text('添加电脑'), findsOneWidget);
    expect(find.text('入口电脑的访问授权'), findsOneWidget);
    expect(find.textContaining(' · 入口电脑'), findsOneWidget);
    await tester.tap(find.text('工作电脑'));
    await tester.pumpAndSettle();

    expect(find.text('当前操作电脑：工作电脑'), findsOneWidget);
    expect(find.text('已连接 · 操作仅作用于此电脑'), findsOneWidget);
    expect(find.text('电脑设置'), findsOneWidget);
    expect(find.text('重新连接'), findsOneWidget);
    expect(find.text('移除连接'), findsOneWidget);

    await tester.tap(find.text('添加电脑'));
    await tester.pumpAndSettle();
    expect(find.text('访问地址（含协议与端口）'), findsOneWidget);
    expect(find.textContaining('明文传输'), findsOneWidget);
    expect(find.textContaining('只连接你管理的电脑。密码仅用于验证'), findsOneWidget);

    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    await tester.pumpWidget(const SizedBox());
    client.close();
  });

  testWidgets('settings page has a single header titled with the target', (
    tester,
  ) async {
    I18n.switchLang('zh');
    final settings = (await entry()).forMachine('machine_a', '工作电脑');
    await tester.pumpWidget(
      MaterialApp(home: MachineSettingsScreen(settings: settings)),
    );
    await tester.pumpAndSettle();

    // 只有 ComputerTargetShell 的一层页头，内层分类页不再自带 AppBar。
    expect(find.byType(AppBar), findsOneWidget);
    expect(find.byType(Scaffold), findsOneWidget);
    expect(
      find.descendant(
        of: find.byType(AppBar),
        matching: find.text('工作电脑'),
      ),
      findsOneWidget,
    );
    expect(find.text('当前操作与保存目标：工作电脑'), findsOneWidget);
    expect(find.text('配置保存在 工作电脑'), findsOneWidget);
    expect(find.text('模型与线路'), findsOneWidget);
    expect(find.text('数据与安全'), findsOneWidget);

    // 分类页仍在同一层页头下面展开。
    await tester.tap(find.text('数据与安全'));
    await tester.pumpAndSettle();
    expect(find.text('保险箱'), findsOneWidget);
    expect(find.text('当前操作与保存目标：工作电脑'), findsOneWidget);
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(find.text('配置保存在 工作电脑'), findsOneWidget);
  });

  testWidgets('settings page translates its categories in the en locale', (
    tester,
  ) async {
    I18n.switchLang('en');
    final settings = (await entry()).forMachine('machine_a', 'Work Mac');
    await tester.pumpWidget(
      MaterialApp(home: MachineSettingsScreen(settings: settings)),
    );
    await tester.pumpAndSettle();

    expect(find.text('Models and routes'), findsOneWidget);
    expect(find.text('Data and security'), findsOneWidget);
    expect(find.text('Computer and power'), findsOneWidget);
    expect(find.text('Configuration is saved on Work Mac'), findsOneWidget);
    expect(find.text('Active target and save location: Work Mac'), findsOneWidget);
  });

  testWidgets('closing the settings header returns to the previous page', (
    tester,
  ) async {
    I18n.switchLang('zh');
    final settings = (await entry()).forMachine('machine_a', '工作电脑');
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => MachineSettingsScreen(settings: settings),
                  ),
                ),
                child: const Text('打开设置'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('打开设置'));
    await tester.pumpAndSettle();
    expect(find.byType(AppBar), findsOneWidget);

    await tester.tap(find.byTooltip('返回多电脑'));
    await tester.pumpAndSettle();
    expect(find.text('打开设置'), findsOneWidget);
    expect(find.byType(AppBar), findsNothing);
  });
}
