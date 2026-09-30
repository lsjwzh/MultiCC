import 'package:flutter/material.dart';

/// Keeps chat notices in the space left by the header and composer. In
/// particular, a tall worktree warning must scroll when the iOS keyboard
/// reduces the sheet height, instead of pushing the focused composer away.
class ChatNoticeScroller extends StatelessWidget {
  const ChatNoticeScroller({
    super.key,
    required this.children,
    required this.keyboardVisible,
  });

  final List<Widget> children;
  /// Captured above Scaffold, whose body removes its own keyboard view inset.
  final bool keyboardVisible;

  @override
  Widget build(BuildContext context) {
    final notices = Column(children: children);
    // A loose Flexible reserves a share of the chat height even when the
    // notices are shorter than that share. The unused share then lands *below*
    // the composer. Keep the original intrinsic layout without a keyboard.
    if (!keyboardVisible) return notices;

    return Flexible(
      fit: FlexFit.tight,
      child: SingleChildScrollView(
        key: const ValueKey('chat-notices-scroll'),
        // When space is tight, the latest notice (usually worktree status) is
        // the one that must remain visible; older notices stay reachable above.
        reverse: true,
        child: notices,
      ),
    );
  }
}
