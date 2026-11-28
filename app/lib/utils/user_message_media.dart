import '../services/attachment_picker.dart' show isImageAttachmentPath;

/// Kind of media attachment extracted from a user message.
enum UserMessageMediaKind { image, file }

/// A media reference extracted from a user message bubble.
class UserMessageMediaRef {
  final UserMessageMediaKind kind;

  /// Server-side absolute path (e.g. `/var/folders/.../multicc_123.png` or
  /// `/tmp/a.png`). When the original token was `/api/download?path=...`, this
  /// holds the decoded `path` query parameter.
  final String path;

  /// Basename of [path] for compact display.
  final String displayName;

  /// Original download URL when the token was `/api/download?...` or
  /// `http(s)://.../api/download?...`; null for bare local paths.
  final String? remoteUrl;

  const UserMessageMediaRef({
    required this.kind,
    required this.path,
    required this.displayName,
    this.remoteUrl,
  });

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is UserMessageMediaRef &&
          other.kind == kind &&
          other.path == path &&
          other.displayName == displayName &&
          other.remoteUrl == remoteUrl;

  @override
  int get hashCode => Object.hash(kind, path, displayName, remoteUrl);

  @override
  String toString() =>
      'UserMessageMediaRef(kind: $kind, path: $path, displayName: $displayName, remoteUrl: $remoteUrl)';
}

/// Result of parsing media references out of a raw user message.
class ParsedUserMessage {
  final String displayText;
  final List<UserMessageMediaRef> media;

  const ParsedUserMessage({required this.displayText, required this.media});

  bool get hasMedia => media.isNotEmpty;
}

final _annotationBlockRe = RegExp(
  r'\[annotation\][\s\S]*?\[/annotation\]',
  caseSensitive: false,
);

final _markdownLinkRe = RegExp(
  r'(!?)\[([^\]]*)\]\((?:<([^>\r\n]+)>|([^\s)\r\n]+))\)',
);

final _downloadUrlRe = RegExp(
  r'''(?:https?://[^\s"'`<>()\[\]{}，。；、（）【】《》“”‘’]+)?/api/download\?[^\s"'`<>()\[\]{}，。；、（）【】《》“”‘’]+''',
);

final _bareLocalPathRe = RegExp(
  r'''(?:file:///[^\s"'`<>()\[\]{}，。；、（）【】《》“”‘’]+|/(?:tmp|Users|home|var|private|opt|Volumes|mnt|root|data)/[^\s"'`<>()\[\]{}，。；、（）【】《》“”‘’]+|[A-Za-z]:[\\/][^\s"'`<>()\[\]{}，。；、（）【】《》“”‘’]+)''',
);

final _unixAbsPrefixRe = RegExp(
  r'^/(?:tmp|Users|home|var|private|opt|Volumes|mnt|root|data)/',
);

final _windowsAbsPrefixRe = RegExp(r'^[A-Za-z]:[\\/]');

final _uploadedTempBasenameRe = RegExp(
  r'^multicc_\d+_[0-9a-fA-F]+\.[A-Za-z0-9]+$',
);

final _attachmentLinePrefixRe = RegExp(
  r'^\s*(?:附件|Attachments?)\s*[:：]',
  caseSensitive: false,
);

final _emptyAttachmentLineRe = RegExp(
  r'^\s*(?:附件|Attachments?)\s*[:：]\s*$',
  caseSensitive: false,
);

final _attachmentPrefixBeforePathRe = RegExp(
  r'^(?:附件|Attachments?)\s*[:：]$',
  caseSensitive: false,
);

final _trailingPunctRe = RegExp(r'[.,;:!?]+$');

class _Span {
  final int start;
  final int end;
  const _Span(this.start, this.end);

  bool overlaps(int s, int e) => start < e && s < end;
}

class _ExtractedMatch {
  final int removeStart;
  final int removeEnd;
  final int tokenStart;
  final UserMessageMediaRef ref;

  const _ExtractedMatch({
    required this.removeStart,
    required this.removeEnd,
    required this.tokenStart,
    required this.ref,
  });
}

/// Extract server-local image paths and uploaded attachment paths from a user
/// message so the bubble can render clickable previews/chips while keeping
/// plain code/document paths untouched.
ParsedUserMessage parseUserMessageMedia(String rawContent) {
  if (rawContent.isEmpty) {
    return ParsedUserMessage(displayText: rawContent, media: const []);
  }

  final protectedSpans = <_Span>[
    for (final m in _annotationBlockRe.allMatches(rawContent))
      _Span(m.start, m.end),
  ];

  final consumedSpans = <_Span>[];
  final matches = <_ExtractedMatch>[];

  bool isBlocked(int start, int end) {
    for (final s in protectedSpans) {
      if (s.overlaps(start, end)) return true;
    }
    for (final s in consumedSpans) {
      if (s.overlaps(start, end)) return true;
    }
    return false;
  }

  // Precompute line boundaries so we can cheaply check whether a token sits on
  // an `附件：` / `Attachments:` line.
  final lines = _computeLines(rawContent);

  bool inAttachmentLine(int offset) {
    final idx = _lineIndexAt(lines, offset);
    final line = rawContent.substring(lines[idx].start, lines[idx].end);
    if (_attachmentLinePrefixRe.hasMatch(line)) return true;
    if (idx > 0) {
      final prevLine = rawContent.substring(
        lines[idx - 1].start,
        lines[idx - 1].end,
      );
      if (_emptyAttachmentLineRe.hasMatch(prevLine)) {
        // Only treat a continuation line as an attachment list if every
        // non-empty token on the line looks like a local path or download URL.
        final trimmed = line.trim();
        if (trimmed.isNotEmpty) {
          final tokens = trimmed.split(RegExp(r'\s+'));
          final allPaths = tokens.every((tok) {
            final clean = _stripMatchingWrappers(tok);
            return _normalizeLocalPath(clean) != null;
          });
          if (allPaths) return true;
        }
      }
    }
    return false;
  }

  // 1. Markdown images and links: `![alt](path)`, `![alt](<path>)`, `[label](path)`
  for (final m in _markdownLinkRe.allMatches(rawContent)) {
    if (isBlocked(m.start, m.end)) continue;
    final target = (m.group(3) ?? m.group(4) ?? '').trim();
    if (target.isEmpty) continue;
    final resolved = _resolveCandidate(
      target,
      inAttachmentContext: inAttachmentLine(m.start),
    );
    if (resolved == null) continue;
    consumedSpans.add(_Span(m.start, m.end));
    matches.add(
      _ExtractedMatch(
        removeStart: m.start,
        removeEnd: m.end,
        tokenStart: m.start,
        ref: resolved,
      ),
    );
  }

  // 2. Direct `/api/download?path=...` (with optional `http(s)://...` origin)
  for (final m in _downloadUrlRe.allMatches(rawContent)) {
    var end = m.end;
    var rawToken = rawContent.substring(m.start, end);
    final trimmedToken = rawToken.replaceFirst(_trailingPunctRe, '');
    if (trimmedToken.isEmpty) continue;
    end = m.start + trimmedToken.length;
    rawToken = trimmedToken;
    if (isBlocked(m.start, end)) continue;

    final resolved = _resolveCandidate(
      rawToken,
      inAttachmentContext: inAttachmentLine(m.start),
    );
    if (resolved == null) continue;

    final removeSpan = _expandWrappingQuotes(rawContent, m.start, end);
    consumedSpans.add(removeSpan);
    matches.add(
      _ExtractedMatch(
        removeStart: removeSpan.start,
        removeEnd: removeSpan.end,
        tokenStart: m.start,
        ref: resolved,
      ),
    );
  }

  // 3. Bare local filesystem paths (`file:///...`, Unix `/tmp/...`, Windows `C:\...`)
  for (final m in _bareLocalPathRe.allMatches(rawContent)) {
    var end = m.end;
    var rawToken = rawContent.substring(m.start, end);
    final trimmedToken = rawToken.replaceFirst(_trailingPunctRe, '');
    if (trimmedToken.isEmpty) continue;
    end = m.start + trimmedToken.length;
    rawToken = trimmedToken;
    if (isBlocked(m.start, end)) continue;
    if (!_hasCleanLeadingBoundary(rawContent, m.start, rawToken)) continue;

    final resolved = _resolveCandidate(
      rawToken,
      inAttachmentContext: inAttachmentLine(m.start),
    );
    if (resolved == null) continue;

    final removeSpan = _expandWrappingQuotes(rawContent, m.start, end);
    consumedSpans.add(removeSpan);
    matches.add(
      _ExtractedMatch(
        removeStart: removeSpan.start,
        removeEnd: removeSpan.end,
        tokenStart: m.start,
        ref: resolved,
      ),
    );
  }

  if (matches.isEmpty) {
    return ParsedUserMessage(displayText: rawContent, media: const []);
  }

  matches.sort((a, b) => a.tokenStart.compareTo(b.tokenStart));

  // Deduplicate by resolved path while preserving first-seen order.
  final seenPaths = <String>{};
  final media = <UserMessageMediaRef>[];
  for (final item in matches) {
    if (seenPaths.add(item.ref.path)) {
      media.add(item.ref);
    }
  }

  final cleaned = _buildCleanedText(rawContent, matches, lines);
  return ParsedUserMessage(displayText: cleaned, media: media);
}

/// Extract server-local path from a `/api/download?path=...` URL (relative or
/// absolute, including machine-scoped `/api/machines/<id>/proxy/api/download`).
String? extractDownloadPathFromUrl(String rawUrl) {
  final uri = Uri.tryParse(rawUrl.trim());
  if (uri == null) return null;
  if (uri.path != '/api/download' && !uri.path.endsWith('/api/download')) {
    return null;
  }
  final path = uri.queryParameters['path']?.trim();
  if (path == null || path.isEmpty) return null;
  return path;
}

UserMessageMediaRef? _resolveCandidate(
  String rawTarget, {
  required bool inAttachmentContext,
}) {
  final downloadPath = extractDownloadPathFromUrl(rawTarget);
  final path = downloadPath ?? _normalizeLocalPath(rawTarget);
  if (path == null || path.isEmpty) return null;

  final isImage = isImageAttachmentPath(path);
  if (!isImage && !inAttachmentContext && !_isUploadedTempFile(path)) {
    return null;
  }

  return UserMessageMediaRef(
    kind: isImage ? UserMessageMediaKind.image : UserMessageMediaKind.file,
    path: path,
    displayName: _basename(path),
    remoteUrl: downloadPath != null ? rawTarget : null,
  );
}

String? _normalizeLocalPath(String raw) {
  var target = raw.trim();
  if (target.isEmpty) return null;
  if (target.startsWith('<') && target.endsWith('>') && target.length > 2) {
    target = target.substring(1, target.length - 1).trim();
  }
  final fromDownload = extractDownloadPathFromUrl(target);
  if (fromDownload != null) return fromDownload;

  if (target.startsWith('file://')) {
    var rest = target.substring('file://'.length);
    // `file:///C:/Users/a.png` -> `C:/Users/a.png`
    if (RegExp(r'^/[A-Za-z]:[\\/]').hasMatch(rest)) {
      rest = rest.substring(1);
    }
    try {
      rest = Uri.decodeFull(rest);
    } catch (_) {
      // Keep literal path if malformed percent-encoding.
    }
    return rest.isNotEmpty ? rest : null;
  }

  if (_unixAbsPrefixRe.hasMatch(target) ||
      _windowsAbsPrefixRe.hasMatch(target)) {
    return target;
  }
  return null;
}

bool _isUploadedTempFile(String path) {
  return _uploadedTempBasenameRe.hasMatch(_basename(path));
}

String _basename(String path) {
  final trimmed = path.replaceAll(RegExp(r'[\\/]+$'), '');
  if (trimmed.isEmpty) return path;
  final parts = trimmed.split(RegExp(r'[\\/]'));
  return parts.isNotEmpty && parts.last.isNotEmpty ? parts.last : path;
}

bool _hasCleanLeadingBoundary(String text, int start, String token) {
  if (start == 0) return true;
  final prev = text[start - 1];
  if (_isBoundaryChar(prev)) return true;

  // Walk backwards to the previous boundary to inspect the immediate prefix.
  var i = start - 1;
  while (i > 0 && !_isBoundaryChar(text[i - 1])) {
    i--;
  }
  final prefix = text.substring(i, start);

  // Allow `附件:/tmp/a.png` or `Attachments:/tmp/a.png` without a space.
  if (_attachmentPrefixBeforePathRe.hasMatch(prefix)) return true;

  // Reject URL paths like `https://example.com/data/a.png`, relative prefixes
  // like `./tmp/a.png`, or embedded substrings like `foo/tmp/a.png` / `fooC:\a.jpg`.
  if (token.startsWith('file://')) {
    return false;
  }
  return false;
}

bool _isBoundaryChar(String ch) {
  return RegExp(r'''[\s"'`<>()\[\]{}，。；、：（）【】《》“”‘’]''').hasMatch(ch);
}

_Span _expandWrappingQuotes(String text, int start, int end) {
  if (start > 0 && end < text.length) {
    final before = text[start - 1];
    final after = text[end];
    if ((before == '`' && after == '`') ||
        (before == '"' && after == '"') ||
        (before == "'" && after == "'")) {
      return _Span(start - 1, end + 1);
    }
  }
  return _Span(start, end);
}

String _stripMatchingWrappers(String token) {
  var t = token.trim();
  if (t.length >= 2) {
    final first = t[0];
    final last = t[t.length - 1];
    if ((first == '`' && last == '`') ||
        (first == '"' && last == '"') ||
        (first == "'" && last == "'") ||
        (first == '<' && last == '>')) {
      t = t.substring(1, t.length - 1);
    }
  }
  return t.replaceFirst(_trailingPunctRe, '');
}

List<_Span> _computeLines(String text) {
  final result = <_Span>[];
  var lineStart = 0;
  for (var i = 0; i < text.length; i++) {
    if (text.codeUnitAt(i) == 0x0A) {
      final lineEnd = (i > lineStart && text.codeUnitAt(i - 1) == 0x0D)
          ? i - 1
          : i;
      result.add(_Span(lineStart, lineEnd));
      lineStart = i + 1;
    }
  }
  result.add(_Span(lineStart, text.length));
  return result;
}

int _lineIndexAt(List<_Span> lines, int offset) {
  var lo = 0;
  var hi = lines.length - 1;
  while (lo <= hi) {
    final mid = (lo + hi) >> 1;
    final line = lines[mid];
    if (offset < line.start) {
      hi = mid - 1;
    } else if (offset > line.end) {
      lo = mid + 1;
    } else {
      return mid;
    }
  }
  return lo.clamp(0, lines.length - 1);
}

String _buildCleanedText(
  String rawContent,
  List<_ExtractedMatch> matches,
  List<_Span> lines,
) {
  final matchesByLine = <int, List<_ExtractedMatch>>{};
  for (final m in matches) {
    final idx = _lineIndexAt(lines, m.tokenStart);
    matchesByLine.putIfAbsent(idx, () => []).add(m);
  }

  final outLines = <String>[];
  for (var i = 0; i < lines.length; i++) {
    final span = lines[i];
    final lineMatches = matchesByLine[i];
    final originalLine = rawContent.substring(span.start, span.end);

    if (lineMatches == null || lineMatches.isEmpty) {
      // Drop an orphaned standalone `附件：` / `Attachments:` header line when
      // the immediately following line had all of its media extracted.
      if (_emptyAttachmentLineRe.hasMatch(originalLine) &&
          matchesByLine.containsKey(i + 1)) {
        continue;
      }
      outLines.add(originalLine);
      continue;
    }

    // Remove extracted spans within this line.
    lineMatches.sort((a, b) => a.removeStart.compareTo(b.removeStart));
    final buf = StringBuffer();
    var cursor = span.start;
    for (final m in lineMatches) {
      final s = m.removeStart.clamp(span.start, span.end);
      final e = m.removeEnd.clamp(span.start, span.end);
      if (s > cursor) {
        buf.write(rawContent.substring(cursor, s));
      }
      if (e > cursor) {
        cursor = e;
      }
    }
    if (cursor < span.end) {
      buf.write(rawContent.substring(cursor, span.end));
    }

    var cleanedLine = buf.toString();
    // Collapse multiple spaces created by removing inline tokens, then trim.
    cleanedLine = cleanedLine.replaceAll(RegExp(r'[ \t]{2,}'), ' ').trim();

    if (cleanedLine.isEmpty || _emptyAttachmentLineRe.hasMatch(cleanedLine)) {
      continue;
    }
    outLines.add(cleanedLine);
  }

  // Collapse runs of 3+ blank lines down to a single blank line and trim edges.
  final joined = outLines.join('\n').replaceAll(RegExp(r'\n{3,}'), '\n\n');
  return joined.trim();
}
