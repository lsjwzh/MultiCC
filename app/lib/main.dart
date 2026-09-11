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

  // The permission alert can only be answered by a human, so it must never sit
  // between launch and the first frame — see
  // NotificationService.requestPermissions for what that looks like from the
  // user's side.
  WidgetsBinding.instance.addPostFrameCallback((_) {
    NotificationService.requestPermissions();
  });
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
