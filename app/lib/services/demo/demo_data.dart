/// 演示模式的内置数据：一个示例项目、三个已经跑过的任务和它们的聊天记录。
///
/// 只用于「体验演示（无需服务器）」入口 —— App Store 审核员和还没装服务端的新用户
/// 不连任何 MultiCC 主机，也能看到首页任务列表、打开会话、发消息收到流式回复。
/// 字段形状照着真服务端 `/api/air`、`/api/sessions`、`/api/sessions/:id/history`
/// 的返回取样，App 的解析层不需要为演示做任何分支。
library;

const String demoDirId = 'demo-dir';
const String demoDirPath = '/demo/weather-app';

class DemoTask {
  final String id;
  final String sessionId;
  final String cli;
  final String model;
  final Map<String, String> title;
  final String status;
  final String runState;
  final int ageMinutes;
  final List<DemoTurn> turns;

  const DemoTask({
    required this.id,
    required this.sessionId,
    required this.cli,
    required this.model,
    required this.title,
    required this.status,
    required this.runState,
    required this.ageMinutes,
    required this.turns,
  });
}

class DemoTurn {
  final Map<String, String> user;
  final Map<String, String> assistant;
  final List<DemoTool> tools;
  const DemoTurn({
    required this.user,
    required this.assistant,
    this.tools = const [],
  });
}

class DemoTool {
  final String name;
  final Map<String, dynamic> input;
  final String result;
  const DemoTool(this.name, this.input, this.result);
}

String pick(Map<String, String> text, String lang) =>
    text[lang] ?? text['en'] ?? text.values.first;

const List<DemoTask> demoTasks = [
  DemoTask(
    id: 'tsk_demo_dark_mode',
    sessionId: 'demo-claude-chat-01',
    cli: 'claude',
    model: 'claude-sonnet-5-5',
    title: {'en': 'Add a dark mode toggle', 'zh': '加一个深色模式开关'},
    status: 'active',
    runState: 'idle',
    ageMinutes: 12,
    turns: [
      DemoTurn(
        user: {
          'en':
              'Add a dark mode toggle to the settings page and remember '
              'the choice between launches.',
          'zh': '在设置页加一个深色模式开关，重启后记住用户的选择。',
        },
        tools: [
          DemoTool('Read', {
            'file_path': 'lib/settings_page.dart',
          }, 'class SettingsPage extends StatelessWidget { ... }'),
          DemoTool('Edit', {
            'file_path': 'lib/settings_page.dart',
            'old_string': 'children: [',
            'new_string': 'children: [\n  const DarkModeSwitch(),',
          }, 'The file has been updated.'),
          DemoTool('Bash', {
            'command': 'flutter test test/settings_test.dart',
            'description': 'Run settings tests',
          }, '00:02 +6: All tests passed!'),
        ],
        assistant: {
          'en':
              'Done. Dark mode is now a switch on the settings page.\n\n'
              '**What changed**\n'
              '- `lib/settings_page.dart`: added a `DarkModeSwitch` row.\n'
              '- `lib/theme_store.dart`: the choice is saved with '
              '`SharedPreferences` and read on startup.\n\n'
              '```dart\n'
              'SwitchListTile(\n'
              '  title: const Text(\'Dark mode\'),\n'
              '  value: store.isDark,\n'
              '  onChanged: store.setDark,\n'
              ')\n'
              '```\n\n'
              'All 6 settings tests pass.',
          'zh':
              '已完成。设置页现在有一个深色模式开关。\n\n'
              '**改动**\n'
              '- `lib/settings_page.dart`：新增 `DarkModeSwitch` 一行。\n'
              '- `lib/theme_store.dart`：用 `SharedPreferences` 保存选择，'
              '启动时读取。\n\n'
              '```dart\n'
              'SwitchListTile(\n'
              '  title: const Text(\'深色模式\'),\n'
              '  value: store.isDark,\n'
              '  onChanged: store.setDark,\n'
              ')\n'
              '```\n\n'
              '设置相关的 6 个测试全部通过。',
        },
      ),
    ],
  ),
  DemoTask(
    id: 'tsk_demo_login_crash',
    sessionId: 'demo-codex-chat-01',
    cli: 'codex',
    model: 'gpt-5.5',
    title: {'en': 'Fix crash on the login screen', 'zh': '修复登录页闪退'},
    status: 'active',
    runState: 'idle',
    ageMinutes: 47,
    turns: [
      DemoTurn(
        user: {
          'en':
              'The app crashes when I tap "Log in" with an empty password. '
              'Find the cause and fix it.',
          'zh': '密码为空时点「登录」App 会闪退，找到原因并修好。',
        },
        tools: [
          DemoTool('Grep', {
            'pattern': 'password!',
            'path': 'lib/',
          }, 'lib/login/login_form.dart:42:    final p = password!;'),
          DemoTool('Edit', {
            'file_path': 'lib/login/login_form.dart',
            'old_string': 'final p = password!;',
            'new_string':
                'final p = password ?? \'\';\n'
                '    if (p.isEmpty) return showError(t.passwordRequired);',
          }, 'The file has been updated.'),
        ],
        assistant: {
          'en':
              'Found it: `login_form.dart:42` force-unwrapped a null '
              'password. It now shows "Password is required" instead of '
              'crashing. I added a regression test for the empty-password '
              'case.',
          'zh':
              '原因找到了：`login_form.dart:42` 对空密码做了强制解包。现在会提示'
              '「请输入密码」，不再闪退。我也补了一个空密码的回归测试。',
        },
      ),
    ],
  ),
  DemoTask(
    id: 'tsk_demo_readme',
    sessionId: 'demo-claude-chat-02',
    cli: 'claude',
    model: 'claude-sonnet-5-5',
    title: {'en': 'Write the README', 'zh': '写项目 README'},
    status: 'active',
    runState: 'idle',
    ageMinutes: 180,
    turns: [
      DemoTurn(
        user: {
          'en':
              'Write a short README: what the app does, how to run it, '
              'how to run the tests.',
          'zh': '写一份简短的 README：项目做什么、怎么运行、怎么跑测试。',
        },
        assistant: {
          'en':
              '# Weather App\n\nA small Flutter app that shows the '
              'forecast for your saved cities.\n\n'
              '## Run\n```bash\nflutter pub get\nflutter run\n```\n\n'
              '## Test\n```bash\nflutter test\n```\n\n'
              'Saved as `README.md`.',
          'zh':
              '# Weather App\n\n一个显示已收藏城市天气预报的 Flutter 小应用。\n\n'
              '## 运行\n```bash\nflutter pub get\nflutter run\n```\n\n'
              '## 测试\n```bash\nflutter test\n```\n\n'
              '已保存为 `README.md`。',
        },
      ),
    ],
  ),
];

/// 演示模式下用户发出的任何消息都会收到这段流式回复。
String demoReply(String userText, String lang) {
  final quoted = userText.trim().length > 120
      ? '${userText.trim().substring(0, 120)}…'
      : userText.trim();
  if (lang == 'zh') {
    return '这是**演示模式**，没有连接真实的 MultiCC 服务器，所以这条回复是 App '
        '内置的示例。\n\n'
        '你刚才说的是：\n> $quoted\n\n'
        '连接到你自己电脑上运行的 MultiCC 后，这条消息会交给你选择的编程 '
        'Agent（Claude Code、Codex 等）在该项目里执行，你会在这里实时看到：\n\n'
        '1. Agent 的流式回复\n'
        '2. 它读写了哪些文件、运行了哪些命令\n'
        '3. 任务完成或需要你确认时的通知\n\n'
        '想连接自己的服务器，打开左上角菜单 → 「退出登录」，回到连接页填写地址。';
  }
  return 'This is **demo mode**. The app is not connected to a real MultiCC '
      'server, so this reply is a built-in sample.\n\n'
      'You wrote:\n> $quoted\n\n'
      'Once connected to MultiCC running on your own computer, this message '
      'goes to the coding agent you picked (Claude Code, Codex, and others), '
      'which works inside the project. You would see here, live:\n\n'
      '1. The agent\'s streamed reply\n'
      '2. Which files it read or edited and which commands it ran\n'
      '3. A notification when the task finishes or needs your input\n\n'
      'To connect your own server, open the menu at the top left → '
      '"Log out" and enter the address on the connect screen.';
}
