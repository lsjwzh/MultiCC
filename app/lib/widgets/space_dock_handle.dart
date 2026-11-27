import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../i18n.dart';
import '../theme.dart';
import 'spaces_scope.dart';

class SpaceDockHandle extends StatefulWidget {
  const SpaceDockHandle({super.key});

  @override
  State<SpaceDockHandle> createState() => _SpaceDockHandleState();
}

class _SpaceDockHandleState extends State<SpaceDockHandle> {
  double _drag = 0;

  @override
  Widget build(BuildContext context) {
    final spaces = SpacesScope.maybeOf(context);
    if (spaces == null) return const SizedBox.shrink();
    void open() {
      spaces.setPressed(false);
      HapticFeedback.mediumImpact();
      spaces.enterOverview();
    }

    return Semantics(
      button: true,
      label: '${t('spacesAllComputers')}: ${spaces.activeMachine.name}',
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTapDown: (_) => spaces.setPressed(true),
        onTapCancel: () => spaces.setPressed(false),
        onTapUp: (_) => spaces.setPressed(false),
        onTap: open,
        onLongPress: open,
        onVerticalDragStart: (_) { _drag = 0; },
        onVerticalDragUpdate: (d) { _drag += d.delta.dy; },
        onVerticalDragCancel: () => spaces.setPressed(false),
        onVerticalDragEnd: (d) {
          spaces.setPressed(false);
          if (_drag < -18 || (d.primaryVelocity ?? 0) < -180) open();
        },
        child: SizedBox(
          height: 32,
          child: Center(
            child: Container(
              constraints: const BoxConstraints(maxWidth: 330),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              decoration: BoxDecoration(
                color: AppColors.bg,
                border: Border.all(color: AppColors.line),
                borderRadius: BorderRadius.circular(999),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.circle, size: 6, color:
                    spaces.online[spaces.activeMachine.id] == false
                      ? Colors.amber : const Color(0xff2ba67a)),
                  const SizedBox(width: 6),
                  const Icon(Icons.computer_outlined, size: 13),
                  const SizedBox(width: 5),
                  Flexible(child: Text(spaces.activeMachine.name,
                    maxLines: 1, overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 11))),
                  const SizedBox(width: 8),
                  for (final machine in spaces.machines)
                    Container(
                      key: ValueKey('space-dock-dot-${machine.id}'),
                      margin: const EdgeInsets.symmetric(horizontal: 2),
                      width: machine.id == spaces.activeMachine.id ? 12 : 4,
                      height: 4,
                      decoration: BoxDecoration(
                        color: machine.id == spaces.activeMachine.id
                          ? AppColors.accent : AppColors.line,
                        borderRadius: BorderRadius.circular(99),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
