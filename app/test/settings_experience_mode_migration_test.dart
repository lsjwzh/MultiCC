import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'an existing configured installation migrates to developer mode',
    () async {
      SharedPreferences.setMockInitialValues({
        'multicc_host': 'http://127.0.0.1:3000',
      });
      final settings = await SettingsService.getInstance();
      expect(settings.advancedMode.value, isTrue);

      await settings.setAdvancedMode(false);
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString('multicc_experience_mode'), 'basic');
      expect(settings.advancedMode.value, isFalse);
    },
  );
}
