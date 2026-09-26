import 'package:flutter/material.dart';

/// Keeps chat notices in the space left by the header and composer. In
/// particular, a tall worktree warning must scroll when the iOS keyboard
/// reduces the sheet height, instead of pushing the focused composer away.
class ChatNoticeScroller extends StatelessWidget {
  const ChatNoticeScroller({super.key, required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Flexible(
    fit: FlexFit.loose,
    child: SingleChildScrollView(
      key: const ValueKey('chat-notices-scroll'),
      // When space is tight, the latest notice (usually worktree status) is
      // the one that must remain visible; older notices stay reachable above.
      reverse: true,
      child: Column(children: children),
    ),
  );
}
