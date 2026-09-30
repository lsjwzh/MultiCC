import 'package:flutter/foundation.dart';

/// What the screenshot annotator hands back to the chat composer: an optional
/// annotated PNG (uploaded as an attachment) plus the structured text block.
class AnnotationDraft {
  final Uint8List? png;
  final String filename;
  final String text;
  final DateTime createdAt;

  AnnotationDraft({this.png, this.filename = '', required this.text})
    : createdAt = DateTime.now();

  /// A draft nobody picked up for this long is dropped instead of surfacing
  /// in some unrelated chat later.
  bool get isStale => DateTime.now().difference(createdAt).inSeconds > 60;
}

/// App-global, consume-once hand-off from the image viewer to the input bar.
/// Whoever consumes the value sets it back to null.
class AnnotationInbox {
  AnnotationInbox._();

  static final ValueNotifier<AnnotationDraft?> draft =
      ValueNotifier<AnnotationDraft?>(null);

  static void publish(AnnotationDraft d) => draft.value = d;

  /// Take the pending draft (if any, and fresh) and clear the inbox.
  static AnnotationDraft? take() {
    final d = draft.value;
    if (d == null) return null;
    draft.value = null;
    return d.isStale ? null : d;
  }
}
