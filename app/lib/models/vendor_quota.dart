// Vendor quota bars for the chat runtime notice panel.
//
// The app carries ZERO vendor strings of its own. Every word, color and
// ordering rule lives in the single server renderer (src/quota/quota-bar-view.js),
// which bakes a bar with only two time-relative tokens left for the client:
//
//   {cd:<epochMs>}   a deadline  → "42m" · "3.5h" · "3d 5h"
//   {ago:<epochMs>}  a timestamp → "刚刚" · "57s 前" · "3 分钟前"
//
// [vendorViewFromBar] is the only bridge: it resolves those tokens (via
// quota_bar_view.dart, the Dart mirror of public/quota-bar-view.js) and hands
// the panel a [VendorQuotaView]. The same golden fixtures run through both
// mirrors (app/test/quota_bar_render_test.dart + tests/test-quota-bar-parity.js),
// so a resolver change that is not mirrored on the web fails on both ends.
//
// What stays here is baseUrl gating: the provider's baseUrl host decides which
// vendor bar to fetch (ark → *.volces.com, zhipu → z.ai / bigmodel.cn, kimi →
// moonshot/kimi), exactly like the web.

import 'quota_bar_view.dart';

/// ARGB color values matching the server palette (the fixed palette is the one
/// kind of non-string constant the client renderer is allowed to hold).
class VendorQuotaColor {
  static const int gray = 0xFF8B949E;
  static const int red = 0xFFF85149;
  static const int yellow = 0xFFD29922;
  static const int blue = 0xFF58A6FF;
}

/// A renderable vendor quota bar (text + color + optional long tooltip).
/// [action] is the server-rendered tap action ('login' when the bar is a
/// needs-login dead end, null for a plain refetch) — the same field the web
/// `quotaBarClick` dispatches on.
class VendorQuotaView {
  final String text;
  final int color;
  final String tooltip;
  final String? action;

  const VendorQuotaView(this.text, this.color, [this.tooltip = '', this.action]);
}

/// Resolve a server-rendered bar to the strings to paint right now.
///
/// [state] picks one of the server's alternative renders (a fetch in flight,
/// a login window waiting on a human); an unknown state falls back to the
/// default render. Returns null when there is no bar (the caller then shows
/// nothing, or an idle placeholder it fetched from /api/quota/bars/idle).
VendorQuotaView? vendorViewFromBar(
  Map<String, dynamic>? bar, {
  String? state,
  int? now,
}) {
  final resolved = resolveQuotaBar(bar, state: state, now: now);
  if (resolved == null) return null;
  return VendorQuotaView(
    resolved.text,
    resolved.color,
    resolved.title,
    resolved.action,
  );
}

// ── baseUrl host gating ─────────────────────────────────────────────────────

String hostFromBaseUrl(String? baseUrl) {
  if (baseUrl == null || baseUrl.isEmpty) return '';
  try {
    return Uri.parse(baseUrl).host.toLowerCase();
  } catch (_) {
    return '';
  }
}

bool isArkBaseUrl(String? baseUrl) {
  if (baseUrl == null || baseUrl.isEmpty) return false;
  final h = hostFromBaseUrl(baseUrl);
  if (h.isNotEmpty) return h == 'volces.com' || h.endsWith('.volces.com');
  return baseUrl.contains('volces.com');
}

bool isZhipuBaseUrl(String? baseUrl) {
  final h = hostFromBaseUrl(baseUrl);
  if (h.isEmpty) return false;
  return h == 'z.ai' ||
      h.endsWith('.z.ai') ||
      h == 'bigmodel.cn' ||
      h.endsWith('.bigmodel.cn');
}

bool isKimiBaseUrl(String? baseUrl) {
  final h = hostFromBaseUrl(baseUrl);
  if (h.isEmpty) return false;
  return RegExp(r'(^|\.)(moonshot|kimi)\.(cn|com|ai)$').hasMatch(h);
}

bool isDeepseekBaseUrl(String? baseUrl) {
  if (baseUrl == null || baseUrl.isEmpty) return false;
  final h = hostFromBaseUrl(baseUrl);
  if (h.isNotEmpty) return h == 'deepseek.com' || h.endsWith('.deepseek.com');
  return baseUrl.contains('deepseek.com');
}

/// Whether the routed-provider balance bar (DeepSeek 余额) is visible for this
/// CLI + provider. The balance event is provider-specific (a DeepSeek prepaid
/// balance), so the bar is hidden unless the active CLI is one that routes
/// through it, or the provider baseUrl points at DeepSeek — mirroring the web
/// `balanceMatchesCli`. This is the gate that makes the bar swap instantly on a
/// cli/provider switch instead of lingering from the previous context.
bool balanceBarVisibleFor(String cliName, String? providerBaseUrl) {
  if (cliName == 'codex' || cliName == 'opencode') return true;
  return isDeepseekBaseUrl(providerBaseUrl);
}

/// Whether the Claude subscription bar's provider context holds: an empty
/// baseUrl (official login) or an anthropic/claude host. Mirrors the web
/// `isClaudeProvider` — under the claude CLI on a NON-Claude provider (e.g.
/// Zhipu) the subscription bar must hide and the routed window bar shows
/// instead.
bool isClaudeProviderBaseUrl(String? baseUrl) {
  final trimmed = (baseUrl ?? '').trim();
  if (trimmed.isEmpty) return true;
  final h = hostFromBaseUrl(trimmed);
  if (h.isEmpty) return false;
  return RegExp(r'(^|\.)(anthropic|claude)\.(com|ai)$').hasMatch(h);
}

/// Whether a passive rate-limit window bar produced by [provider] can be on
/// screen while the given CLI is active. Mirrors the web `providerMatchesCli`
/// byte for byte in rule form:
///   • opencode's own window → only under the opencode CLI;
///   • glm / codex windows → under codex/opencode, and glm additionally under
///     any CLI while the provider baseUrl points at Zhipu (the claude CLI can
///     route through a Zhipu endpoint);
///   • everything else (claude windows) → under claude/opencode.
bool providerMatchesCli(String provider, String cliName, String? providerBaseUrl) {
  if (provider == 'opencode') return cliName == 'opencode';
  if (provider == 'glm' || provider == 'codex') {
    if (cliName == 'codex' || cliName == 'opencode') return true;
    return provider == 'glm' && isZhipuBaseUrl(providerBaseUrl);
  }
  return cliName == 'claude' || cliName == 'opencode';
}

/// Host to pass as `?host=` so the backend puts the current site first.
String zhipuHostFromBaseUrl(String? baseUrl) => hostFromBaseUrl(baseUrl);
String kimiHostFromBaseUrl(String? baseUrl) => hostFromBaseUrl(baseUrl);

/// Which Ark plan the provider baseUrl points to (Volcano serves Coding Plan
/// under /api/coding… and Agent Plan under /api/plan). null = unknown. Passed
/// to the server route so it can render the active plan's windows first.
String? arkPlanFromBaseUrl(String? baseUrl) {
  if (baseUrl == null || baseUrl.isEmpty) return null;
  try {
    final p = Uri.parse(baseUrl).path.toLowerCase();
    if (p.contains('/coding')) return 'coding-plan';
    if (p.contains('/plan')) return 'agent-plan';
  } catch (_) {}
  return null;
}
