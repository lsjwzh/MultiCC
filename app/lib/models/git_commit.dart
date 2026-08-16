/// Parsed records from the server's git-history endpoints
/// (`GET /api/git/log`, `GET /api/git/commit-diff`). Field names mirror the
/// server DTO verbatim so `fromJson` stays a straight cast.
class GitCommit {
  const GitCommit({
    required this.hash,
    required this.short,
    required this.author,
    required this.date,
    required this.subject,
    required this.refs,
  });

  /// Full object hash (40 hex).
  final String hash;

  /// Abbreviated hash, as the server's `--format=%h` produced it.
  final String short;
  final String author;

  /// ISO-8601 author date (e.g. `2026-08-16T09:41:02+08:00`).
  final String date;
  final String subject;

  /// `HEAD -> main` / `tag: v1` decorations; empty when none.
  final String refs;

  factory GitCommit.fromJson(Map<String, dynamic> json) => GitCommit(
        hash: json['hash']?.toString() ?? '',
        short: json['short']?.toString() ?? '',
        author: json['author']?.toString() ?? '',
        date: json['date']?.toString() ?? '',
        subject: json['subject']?.toString() ?? '',
        refs: json['refs']?.toString() ?? '',
      );

  /// `2026-08-16 09:41` - the ISO date cut to minute precision. The server's
  /// `%aI` carries the author's local offset (e.g. `+08:00`), so the raw string
  /// already encodes the zone the server's git saw: cut it instead of parsing,
  /// because `DateTime.tryParse` turns that offset into a UTC DateTime and
  /// formatting its UTC fields would shift the shown time by the zone delta
  /// (a +08:00 commit would display 8h early).
  String get dateLabel {
    if (date.length < 16) return date;
    return date.substring(0, 16).replaceAll('T', ' ');
  }
}

class GitCommitDiff {
  const GitCommitDiff({
    required this.hash,
    required this.stat,
    required this.diff,
    required this.truncated,
    this.error,
  });

  final String hash;

  /// `--stat` summary block (`1 file changed, 2 insertions(+)`), may be empty.
  final String stat;

  /// Raw patch text; empty for merge commits and root commits.
  final String diff;

  /// True when the server capped the diff at 1MB.
  final bool truncated;
  final String? error;

  factory GitCommitDiff.fromJson(Map<String, dynamic> json) => GitCommitDiff(
        hash: json['hash']?.toString() ?? '',
        stat: json['stat']?.toString() ?? '',
        diff: json['diff']?.toString() ?? '',
        truncated: json['truncated'] == true,
        error: json['error']?.toString(),
      );
}
