import 'package:flutter/material.dart';
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

  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: Brightness.light,
    ),
  );

  await NotificationService.init();
  final settings = await SettingsService.getInstance();
  await I18n.init(settings.lang);
  runApp(MultiCCApp(settings: settings));
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

    return MaterialApp(
      title: 'MultiCC',
      debugShowCheckedModeBanner: false,
      theme: buildAppTheme(),
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
