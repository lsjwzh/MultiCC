/// App-side mirror of the routing half of `public/auto-provider-editor.js`.
///
/// The two editors (web and phone) write the same `providerSelection` wire
/// object, so the rules that decide *what* is written — how a row's tier chip
/// becomes `t1..tK`, which knobs are carried through untouched, when routing is
/// omitted entirely — live here once instead of being re-derived in the widget.
/// Anything that only decides *how it looks* stays in the sheet.
library;

import '../i18n.dart';
import '../models/message.dart';

/// Mirrors `MAX_TIERS` / `MAX_ATTEMPTS` in the web editor (and the server's
/// `MAX_TIERS` / `MAX_ATTEMPTS` in src/providers/auto-provider-config.js).
const int kAutoMaxTiers = 6;
const int kAutoMaxAttempts = 4;

/// Two or three rungs read better as words; past that only the number is honest.
String autoTierLabel(int rung, int ceiling) {
  if (ceiling <= 3) {
    if (rung <= 1) return t('autoEditorTierSimple');
    if (rung >= ceiling) return t('autoEditorTierComplex');
    return t('autoEditorTierMedium');
  }
  if (rung <= 1) return '$rung · ${t('autoEditorTierSimplest')}';
  if (rung >= ceiling) return '$rung · ${t('autoEditorTierHardest')}';
  return '$rung';
}

/// The short form that sits on the chip; [autoTierLabel] is its tooltip.
String autoTierChip(int rung, int ceiling) {
  if (ceiling > 3) return '$rung';
  if (rung <= 1) return t('autoEditorTierChipSimple');
  if (rung >= ceiling) return t('autoEditorTierChipComplex');
  return t('autoEditorTierChipMedium');
}

/// Only a first guess the user can override: it saves most pools from having to
/// be filed by hand (flash/mini/haiku-class models go simple). Same regex as the
/// web editor's `looksLight`.
final RegExp _lightModel = RegExp(
  r'(^|[^a-z])(flash|mini|lite|haiku|nano|small|tiny|instant|turbo|air)([^a-z]|$)'
  r'|(^|[^0-9.])([1-9]|[1-3][0-9])b([^a-z0-9]|$)',
  caseSensitive: false,
);

bool autoLooksLight(String text) => _lightModel.hasMatch(text);

/// The rung a configured candidate already sits on. The wire carries tier keys
/// (`t2`) while the editor shows rungs (1 = weakest), so this is the one place
/// the two have to agree — mirrors the web `rungFor()`.
int autoRungFor(
  SessionProviderCandidate? configured,
  List<String> ladder, {
  int fallback = 0,
}) {
  if (configured == null) return fallback;
  final tier = configured.tier;
  if (tier == null || tier.isEmpty) return fallback;
  final index = ladder.indexOf(tier);
  return index >= 0 ? index + 1 : fallback;
}

/// The rung each row is on, and how many chips to draw.
class AutoRungPlan {
  const AutoRungPlan({required this.ceiling, required this.rungs});

  /// Number of chips on every row (2..[kAutoMaxTiers]).
  final int ceiling;

  /// Rung per row, in the order the rows were given. Always 1..[ceiling].
  final List<int> rungs;
}

/// Mirrors the web editor's `syncRungs()`.
///
/// [rowTexts] is `name（model）`-style text of the rows in use, in try order.
/// [chosenRungs] holds the rung the user picked by hand for each row, or null
/// when the row has not been touched yet — an untouched row is re-guessed from
/// its model name (so switching a row's model re-files it), while a hand-picked
/// rung survives everything.
AutoRungPlan resolveAutoRungs({
  required List<String> rowTexts,
  required List<int?> chosenRungs,
}) {
  final chosen = <int>[
    for (final rung in chosenRungs)
      if (rung != null && rung > 0) rung else 0,
  ];
  var highestChosen = 0;
  for (final rung in chosen) {
    if (rung > highestChosen) highestChosen = rung;
  }
  // min(max(2, min(MAX_TIERS, rows)), max(2, highest chosen)): two chips for a
  // fresh pair, and never fewer than the ladder a configured pool already has.
  final byCount = rowTexts.length < kAutoMaxTiers
      ? rowTexts.length
      : kAutoMaxTiers;
  final ceiling = _min(
    byCount < 2 ? 2 : byCount,
    highestChosen < 2 ? 2 : highestChosen,
  );
  final light = [for (final text in rowTexts) autoLooksLight(text)];
  final undecided =
      chosen.every((rung) => rung == 0) &&
      (light.isEmpty || light.every((value) => value == light.first));
  final rungs = <int>[];
  for (var index = 0; index < rowTexts.length; index += 1) {
    // When the names tell a fresh pool nothing apart, the first line in order
    // takes the simple tasks: a valid split out of the box, never one tier.
    final guess = undecided
        ? (index == 0 ? 1 : ceiling)
        : (light[index] ? 1 : ceiling);
    final value = chosen[index] != 0 ? chosen[index] : guess;
    rungs.add(value.clamp(1, ceiling));
  }
  return AutoRungPlan(ceiling: ceiling, rungs: rungs);
}

/// One enabled row of the pool as the router sees it: [rung] is the editor's
/// chip value and never travels; it only decides the tier key.
class AutoRoutedRoute {
  const AutoRoutedRoute({
    required this.providerId,
    required this.model,
    required this.priority,
    required this.rung,
  });

  final String providerId;
  final String? model;
  final int priority;
  final int rung;
}

/// Outcome of [serializeAutoRouting]: either the routed candidates plus the
/// frozen block, or the message the editor shows and the code the server would
/// have answered with.
class AutoRoutingResult {
  const AutoRoutingResult._({
    required this.ok,
    this.candidates = const [],
    this.routing,
    this.error,
    this.code,
  });

  final bool ok;
  final List<SessionProviderCandidate> candidates;
  final SessionProviderRouting? routing;
  final String? error;
  final String? code;
}

/// Mirrors the web editor's `serializeRouting()`: rungs are compacted to
/// `t1..tK` in ascending order, so a user who leaves a gap never has to close it
/// by hand (only the order carries meaning).
///
/// [previous] is the routing block the pool already carried, if any. Every knob
/// this editor cannot express ([SessionProviderRouting.model], `timeoutMs`,
/// `escalation`, and the vault entry name) is carried over rather than reset —
/// re-saving a pool from the phone must not undo what the API or the web editor
/// configured.
AutoRoutingResult serializeAutoRouting({
  required List<AutoRoutedRoute> routes,
  required String onUnknown,
  SessionProviderRouting? previous,
}) {
  if (routes.length < 2) {
    return AutoRoutingResult._(
      ok: false,
      error: t('autoEditorRoutingNeedsTwo'),
      code: 'insufficient_candidates',
    );
  }
  final rungs = <int>{};
  for (final route in routes) {
    if (route.rung > 0) rungs.add(route.rung);
  }
  final ladder = rungs.toList()..sort();
  if (ladder.length < 2) {
    return AutoRoutingResult._(
      ok: false,
      error: t('autoEditorRoutingNeedsTwoTiers'),
      code: 'provider_routing_requires_tiers',
    );
  }
  if (ladder.length > kAutoMaxTiers) {
    return AutoRoutingResult._(
      ok: false,
      error: t('autoEditorRoutingTooManyTiers', {'max': '$kAutoMaxTiers'}),
      code: 'invalid_provider_routing',
    );
  }
  final keyByRung = <int, String>{
    for (var index = 0; index < ladder.length; index += 1)
      ladder[index]: 't${index + 1}',
  };
  // 'strong' is the server default, so it is only written when a routing block
  // already existed (the server always returns one once set) or when the user
  // picked something else: an unrouted pool's JSON stays minimal.
  final writeOnUnknown = onUnknown != 'strong' || previous != null;
  return AutoRoutingResult._(
    ok: true,
    candidates: [
      for (final route in routes)
        SessionProviderCandidate(
          providerId: route.providerId,
          model: route.model,
          priority: route.priority,
          enabled: true,
          tier: keyByRung[route.rung],
        ),
    ],
    routing: SessionProviderRouting(
      version: 1,
      provider: previous?.provider ?? 'jev',
      apiKeyName: previous?.apiKeyName ?? SessionProviderRouting.defaultApiKeyName,
      onUnknown: writeOnUnknown ? onUnknown : null,
      tiers: [for (final rung in ladder) keyByRung[rung]!],
      model: previous?.model,
      timeoutMs: previous?.timeoutMs,
      escalation: previous?.escalation,
    ),
  );
}

int _min(int a, int b) => a < b ? a : b;

/// `(wire value, label key, folded-summary key)` — what an unjudged message
/// should do, in the same order the web editor offers it.
const List<(String, String, String)> kAutoUnknownChoices = [
  ('strong', 'autoEditorJevUnknownStrong', 'autoEditorMoreUnknownStrong'),
  ('weak', 'autoEditorJevUnknownWeak', 'autoEditorMoreUnknownWeak'),
  (
    'priority',
    'autoEditorJevUnknownPriority',
    'autoEditorMoreUnknownPriority',
  ),
];
