import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/models/message.dart';
import 'package:multicc_app/services/claude_models_service.dart';

// The static table is the offline fallback shared with the web picker
// (CLAUDE_MODEL_OPTIONS in public/shared/models.js). claude-opus-5 missing
// from it was the original bug: the App picker could not offer Opus 5 under
// Claude Official, where no managed provider supplies a model list.
void main() {
  test('kClaudeModelOptions covers the current Anthropic lineup', () {
    final ids = kClaudeModelOptions.map((e) => e.key).toSet();
    expect(kClaudeModelOptions.first.key, '');
    expect(
      ids,
      containsAll(<String>[
        'claude-opus-5',
        'claude-opus-5[1m]',
        'claude-opus-4-8',
        'claude-sonnet-5',
        'claude-sonnet-4-6',
        'claude-fable-5',
        'claude-haiku-4-5-20251001',
      ]),
    );
  });

  test('ClaudeModelsService.options falls back to the static table when cold', () {
    expect(ClaudeModelsService.cached, isEmpty);
    expect(ClaudeModelsService.options(), equals(kClaudeModelOptions));
  });

  test('claudeModelShortName resolves the new ids to friendly labels', () {
    expect(claudeModelShortName('claude-opus-5'), 'Opus 5');
    expect(claudeModelShortName('claude-sonnet-5'), 'Sonnet 5');
    expect(claudeModelShortName('claude-opus-5[1m]'), 'Opus 5 (1M context)');
  });
}
