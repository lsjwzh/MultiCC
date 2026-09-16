import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import 'providers/session_manager.dart';
import 'i18n.dart';
import 'theme.dart';
import 'screens/main_shell.dart';
import 'screens/setup_screen.dart';
import 'services/notification_service.dart';
import 'services/settings_service.dart';
import 'services/update_service.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // The Air palette is light, so the status-bar glyphs must be dark ink or they
  // disappear into the pale canvas.
  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: Brightness.dark,
      statusBarBrightness: Brightness.light,
    ),
  );

  await NotificationService.init();
  final settings = await SettingsService.getInstance();
  await I18n.init(settings.lang);
  runApp(MultiCCApp(settings: settings));

  // 刻意**不**在这里(或 post-frame)申请系统通知权限 —— 这里原来有一次无条件的
  // `NotificationService.requestPermissions()`。Web 的授权弹窗只在用户主动打开
  // 聊天页头那颗 `#notify-btn` 时才出现：toggle() 打开开关后调
  // `ensurePushSubscribed()`，其中的 `Notification.requestPermission()` 才是弹窗
  // 来源（public/chat-notifications.js:112 → public/pwa.js:224），页面加载本身从
  // 不弹。冷启动就弹一次会把「还没决定要不要提醒」的人按在系统弹窗上，语义也和
  // Web 不一致。App 的等价入口是 ⋯ 菜单里的「任务提醒」—— chat_header 的
  // toggleTaskNotifyWithPermission() 在那里申请，被拒还会把开关回滚成关闭。
}

class MultiCCApp extends StatelessWidget {
  final SettingsService settings;
  const MultiCCApp({super.key, required this.settings});

  @override
  Widget build(BuildContext context) {
    final Widget home;
    if (settings.isConfigured) {
      home = ChangeNotifierProvider(
        create: (_) => SessionManager(settings: settings),
        child: MainShell(settings: settings),
      );
    } else {
      home = SetupScreen(settings: settings);
    }

    return ListenableBuilder(
      listenable: Listenable.merge([settings.language, settings.advancedMode]),
      builder: (context, _) {
        final language = settings.language.value;
        I18n.switchLang(language);
        return MaterialApp(
          title: 'MultiCC',
          debugShowCheckedModeBanner: false,
          theme: buildAppTheme(),
          locale: language == 'en'
              ? const Locale('en', 'US')
              : const Locale('zh', 'CN'),
          supportedLocales: const [Locale('zh', 'CN'), Locale('en', 'US')],
          localizationsDelegates: const [
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          builder: (context, child) => ValueListenableBuilder<double>(
            valueListenable: settings.fontScale,
            builder: (context, scale, _) => MediaQuery(
              data: MediaQuery.of(
                context,
              ).copyWith(textScaler: TextScaler.linear(scale)),
              child: child ?? const SizedBox.shrink(),
            ),
          ),
          home: _StartupWrapper(settings: settings, child: home),
        );
      },
    );
  }
}

class _StartupWrapper extends StatefulWidget {
  final SettingsService settings;
  final Widget child;
  const _StartupWrapper({required this.settings, required this.child});

  @override
  State<_StartupWrapper> createState() => _StartupWrapperState();
}

class _StartupWrapperState extends State<_StartupWrapper> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      UpdateService.checkUpdate(context, widget.settings);
    });
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
