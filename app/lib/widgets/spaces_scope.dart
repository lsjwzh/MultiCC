import 'package:flutter/material.dart';
import '../services/machine_service.dart';

/// Shared entry points; gesture recognizers belong only to explicit handles.
class SpacesScope extends InheritedWidget {
  const SpacesScope({
    super.key,
    required super.child,
    required this.machines,
    required this.activeMachine,
    required this.inOverview,
    required this.enterOverview,
    required this.exitOverview,
    required this.switchToMachine,
    required this.openAddMachineDialog,
    required this.refreshMachines,
    required this.setPressed,
    this.online = const {},
  });

  final List<ManagedComputer> machines;
  final ManagedComputer activeMachine;
  final bool inOverview;
  final Map<String, bool> online;
  final VoidCallback enterOverview, exitOverview;
  final ValueChanged<ManagedComputer> switchToMachine;
  final Future<void> Function(BuildContext) openAddMachineDialog;
  final Future<void> Function() refreshMachines;
  final ValueChanged<bool> setPressed;

  static SpacesScope? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<SpacesScope>();

  @override
  bool updateShouldNotify(SpacesScope oldWidget) =>
      machines != oldWidget.machines ||
      activeMachine != oldWidget.activeMachine ||
      inOverview != oldWidget.inOverview || online != oldWidget.online;
}
