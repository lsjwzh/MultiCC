import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import 'providers/session_manager.dart';
import 'i18n.dart';
import 'theme.dart';
import 'screens/agent_resources_screen.dart';
import 'screens/bridge_settings_screen.dart';
import 'screens/main_shell.dart';
import 'screens/provider_screen.dart';
import 'screens/push_settings_screen.dart';
import 'screens/settings_screen.dart';
import 'screens/setup_screen.dart';
import 'screens/tunnel_settings_screen.dart';
import 'screens/voice_settings_screen.dart';
import 'services/notification_service.dart';
import 'services/settings_service.dart';
import 'services/update_service.dart';
import 'widgets/settings_navigation_drawer.dart';

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

    return ValueListenableBuilder<String>(
      valueListenable: settings.language,
      builder: (context, language, _) {
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
          routes: {
            SettingsRoutes.voice: (_) =>
                VoiceSettingsScreen(settings: settings),
            SettingsRoutes.goal: (_) => SettingsScreen(
              settings: settings,
              initialSection: SettingsInitialSection.goal,
            ),
            SettingsRoutes.provider: (_) => ProviderScreen(settings: settings),
            SettingsRoutes.global: (_) => SettingsScreen(settings: settings),
            SettingsRoutes.push: (_) => PushSettingsScreen(settings: settings),
            SettingsRoutes.tunnel: (_) =>
                TunnelSettingsScreen(settings: settings),
            SettingsRoutes.bridges: (_) =>
                BridgeSettingsScreen(settings: settings),
            SettingsRoutes.resources: (_) => AgentResourcesScreen(
              settings: settings,
              initialSection: AgentResourcesInitialSection.resources,
            ),
            SettingsRoutes.skillSync: (_) => AgentResourcesScreen(
              settings: settings,
              initialSection: AgentResourcesInitialSection.skillSync,
            ),
            SettingsRoutes.storage: (_) => AgentResourcesScreen(
              settings: settings,
              initialSection: AgentResourcesInitialSection.storage,
            ),
          },
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
