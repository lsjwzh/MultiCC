import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/services/codex_models_service.dart';

void main() {
  setUp(CodexModelsService.resetForTest);

  test('catalog keeps display name separate from wire model id', () {
    final catalog = CodexModelsService.parseCatalog({
      'source': 'cli',
      'cliVersion': '0.153.4',
      'models': [
        {'model': 'gpt-future', 'label': 'GPT Future'},
        {'model': 'gpt-future', 'label': 'duplicate'},
      ],
      'diagnostic': {'code': 'ok', 'message': 'verified'},
    });
    expect(catalog.models.map((entry) => entry.key), ['gpt-future']);
    expect(catalog.models.map((entry) => entry.value), ['GPT Future']);
    expect(catalog.cliVersion, '0.153.4');
    expect(catalog.diagnosticCode, 'ok');
  });

  test('cold or unavailable account exposes only the safe Codex default', () {
    expect(CodexModelsService.options(), const [
      MapEntry('', '默认（跟随 Codex 设置）'),
    ]);
    final unavailable = CodexModelsService.parseCatalog({
      'source': 'fallback',
      'models': [],
      'diagnostic': {'code': 'login_required', 'message': 'login required'},
    });
    CodexModelsService.setCatalogForTest(unavailable);
    expect(CodexModelsService.options().map((entry) => entry.key), ['']);
  });

  test(
    'dynamic catalog updates labels and unknown saved ids remain verbatim',
    () {
      final catalog = CodexModelsService.parseCatalog({
        'source': 'cli',
        'models': [
          {'model': 'gpt-new', 'label': 'GPT New'},
        ],
      });
      CodexModelsService.setCatalogForTest(catalog);
      expect(CodexModelsService.options().map((entry) => entry.key), [
        '',
        'gpt-new',
      ]);
      expect(CodexModelsService.labelFor('gpt-new'), 'GPT New');
      expect(CodexModelsService.labelFor('gpt-user-saved'), 'gpt-user-saved');
    },
  );
}
