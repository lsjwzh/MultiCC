import 'package:flutter/material.dart';

/// Shares the space between the header and composer between notices and the
/// transcript. Short notices keep their intrinsic height; long notices scroll
/// in at most half this region while the keyboard is open. Floating controls
/// use the same region, so they cannot cover the composer as its height changes.
class ChatNoticeScroller extends StatelessWidget {
  const ChatNoticeScroller({
    super.key,
    required this.notices,
    required this.keyboardVisible,
    required this.messageList,
    this.overlays = const [],
  });

  final List<Widget> notices;
  final Widget messageList;
  final List<Widget> overlays;

  /// Captured above Scaffold, whose body removes its own keyboard view inset.
  final bool keyboardVisible;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final noticeColumn = Column(
          mainAxisSize: MainAxisSize.min,
          children: notices,
        );
        return Stack(
          fit: StackFit.expand,
          children: [
            Column(
              children: [
                if (keyboardVisible)
                  ConstrainedBox(
                    constraints: BoxConstraints(
                      maxHeight: constraints.maxHeight / 2,
                    ),
                    child: SingleChildScrollView(
                      key: const ValueKey('chat-notices-scroll'),
                      // Keep the latest warning reachable when space is tight.
                      reverse: true,
                      child: noticeColumn,
                    ),
                  )
                else
                  noticeColumn,
                Expanded(child: messageList),
              ],
            ),
            ...overlays,
          ],
        );
      },
    );
  }
}
