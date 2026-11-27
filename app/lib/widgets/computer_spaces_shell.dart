import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' show lerpDouble;

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:provider/provider.dart';

import '../i18n.dart';
import '../providers/session_manager.dart';
import '../screens/main_shell.dart';
import '../screens/machine_settings_screen.dart';
import '../screens/settings_screen.dart';
import '../services/air_service.dart';
import '../services/machine_service.dart';
import '../services/settings_service.dart';
import 'computer_pairing_dialog.dart';
import 'spaces_scope.dart';

export 'spaces_scope.dart';
export 'space_dock_handle.dart';

part 'spaces_overview.dart';

/// Each warm desktop keeps its original element, layout size and Navigator.
/// The overview only transforms these fixed slots over the gallery's cards.
class ComputerSpacesShell extends StatefulWidget {
  const ComputerSpacesShell({super.key, required this.settings, this.httpClient});
  final SettingsService settings;
  final http.Client? httpClient;

  @override
  State<ComputerSpacesShell> createState() => _ComputerSpacesShellState();
}

class _DesktopSlot {
  _DesktopSlot(this.machine, this.settings);
  ManagedComputer machine;
  final SettingsService settings;
  final navigator = GlobalKey<NavigatorState>();
}

class _ComputerSpacesShellState extends State<ComputerSpacesShell>
    with SingleTickerProviderStateMixin {
  late final MachineService _service;
  late final AnimationController _zoom;
  final _pages = PageController(viewportFraction: .76);
  // Insertion order is LRU order. Reordering this map must not reparent slots.
  final _slots = <String, _DesktopSlot>{};
  List<ManagedComputer> _machines = const [];
  Map<String, bool> _online = const {};
  Map<String, int> _running = const {};
  late ManagedComputer _active;
  bool _inOverview = false, _pressed = false;
  double _page = 0;
  int _refreshGeneration = 0, _statusGeneration = 0;

  String _key(ManagedComputer machine) => machine.local ? 'local' : machine.id;

  SettingsService _settings(ManagedComputer machine) => machine.local
      ? widget.settings
      : widget.settings.forMachine(machine.id, machine.name,
          directoryId: null, origin: machine.origin);

  @override
  void initState() {
    super.initState();
    _service = MachineService(widget.settings, client: widget.httpClient);
    _zoom = AnimationController(vsync: this,
      duration: const Duration(milliseconds: 340));
    _pages.addListener(_onPageChanged);
    final host = Uri.tryParse(widget.settings.host)?.host ?? '';
    _active = ManagedComputer(id: 'machine_local',
      name: host.isEmpty ? 'MultiCC' : host, local: true);
    _machines = [_active];
    _touch(_active);
    unawaited(refreshMachines());
  }

  void _onPageChanged() {
    if (mounted && _pages.hasClients) {
      setState(() => _page = _pages.page ?? 0);
    }
  }

  void _touch(ManagedComputer machine) {
    final id = _key(machine);
    final slot = _slots.remove(id) ?? _DesktopSlot(machine, _settings(machine));
    slot.machine = machine;
    slot.settings.updateMachineMetadata(machine.name, origin: machine.origin);
    _slots[id] = slot;
    while (_slots.length > 3) {
      _slots.remove(_slots.keys.firstWhere((key) => key != id));
    }
    // Removing the keyed provider from the tree owns manager disposal.
  }

  Future<void> refreshMachines() async {
    final generation = ++_refreshGeneration;
    try {
      final response = await _service.list();
      if (!mounted || generation != _refreshGeneration) return;
      final local = response.where((m) => m.local).firstOrNull ??
          _machines.firstWhere((m) => m.local);
      final seen = <String>{local.id};
      final machines = [local,
        for (final m in response)
          if (!m.local && seen.add(m.id)) m,
      ];
      setState(() {
        _machines = machines;
        _online = {..._online, local.id: true};
        _active = machines.firstWhere((m) => _key(m) == _key(_active),
          orElse: () => local);
        final keys = machines.map(_key).toSet();
        _slots.removeWhere((id, _) => !keys.contains(id));
        for (final m in machines) {
          _slots[_key(m)]?.machine = m;
          _slots[_key(m)]?.settings.updateMachineMetadata(m.name, origin: m.origin);
        }
        _touch(_active);
      });
      if (_inOverview) unawaited(_refreshStatuses());
    } catch (_) {
      // The entry desktop is usable even on old servers or a failed request.
      if (mounted && generation == _refreshGeneration) {
        setState(() => _online = {..._online,
          _machines.firstWhere((m) => m.local).id: false});
      }
    }
  }

  Future<void> _refreshStatuses() async {
    final generation = ++_statusGeneration;
    await Future.wait(_machines.where((m) => !m.local).map((machine) async {
      final service = AirService(settings: _settings(machine),
        httpClient: widget.httpClient);
      try {
        final data = await service.load().timeout(const Duration(seconds: 10));
        if (!mounted || generation != _statusGeneration ||
            !_machines.any((m) => m.id == machine.id)) return;
        setState(() {
          _online = {..._online, machine.id: true};
          _running = {..._running, machine.id:
            data.count('running') ?? data.tasks.where((task) => task.runState == 'running').length};
        });
      } catch (_) {
        if (mounted && generation == _statusGeneration) {
          setState(() => _online = {..._online, machine.id: false});
        }
      } finally { service.close(); }
    }));
  }

  void enterOverview() {
    if (_inOverview) return;
    FocusManager.instance.primaryFocus?.unfocus();
    final index = _machines.indexWhere((m) => _key(m) == _key(_active));
    setState(() { _inOverview = true; _pressed = false; _page = index.toDouble(); });
    if (_pages.hasClients) _pages.jumpToPage(index);
    _zoom.forward();
    unawaited(_refreshStatuses());
  }

  void exitOverview() {
    if (!_inOverview) return;
    setState(() { _inOverview = false; _pressed = false; });
    _zoom.reverse();
  }

  void switchToMachine(ManagedComputer machine) {
    if (!_machines.any((m) => _key(m) == _key(machine))) return;
    setState(() { _active = machine; _touch(machine); });
    exitOverview();
  }

  Future<void> openAddMachineDialog(BuildContext context,
      {ManagedComputer? existing}) async {
    final connected = await showComputerPairingDialog(context, _service,
      existing: existing);
    if (!mounted || connected == null) return;
    await refreshMachines();
    if (!mounted) return;
    // A successful POST may precede the next list snapshot or a failed GET.
    setState(() {
      final known = _machines.any((m) => m.id == connected.id);
      _machines = [for (final m in _machines)
        m.id == connected.id ? connected : m,
        if (!known) connected];
      _online = {..._online, connected.id: true};
    });
    switchToMachine(connected);
  }

  Future<void> _remove(ManagedComputer machine) async {
    if (!await removeComputerConnection(context, _service, machine) || !mounted) return;
    setState(() {
      _machines = _machines.where((m) => m.id != machine.id).toList();
      _slots.remove(_key(machine));
      if (_active.id == machine.id) {
        _active = _machines.firstWhere((m) => m.local);
        _touch(_active);
      }
      _page = _page.clamp(0, _machines.length).toDouble();
    });
    if (_pages.hasClients) _pages.jumpToPage(_page.round());
    await refreshMachines();
  }

  void _openSettings(ManagedComputer machine) {
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => machine.local
      ? SettingsScreen(settings: widget.settings)
      : MachineSettingsScreen(settings: _settings(machine))));
  }

  SpacesScope _scope(Widget child, {ManagedComputer? machine}) => SpacesScope(
    machines: _machines, activeMachine: machine ?? _active,
    inOverview: _inOverview, online: _online,
    enterOverview: enterOverview, exitOverview: exitOverview,
    switchToMachine: switchToMachine, openAddMachineDialog: openAddMachineDialog,
    refreshMachines: refreshMachines,
    setPressed: (value) { if (mounted) setState(() => _pressed = value); },
    child: child,
  );

  @override
  Widget build(BuildContext context) => _scope(PopScope(
    canPop: !_inOverview,
    onPopInvokedWithResult: (didPop, _) { if (!didPop) exitOverview(); },
    child: Material(color: const Color(0xff121b28), child: LayoutBuilder(
      builder: (context, constraints) {
        final size = constraints.biggest;
        final geometry = _OverviewGeometry(size, MediaQuery.paddingOf(context));
        // Keyed siblings can reorder without reparenting. The active desktop
        // paints last so parked previews never cover its zoom animation.
        final slots = _slots.entries.toList()..sort((a, b) {
          if (a.key == _key(_active)) return 1;
          if (b.key == _key(_active)) return -1;
          return a.key.compareTo(b.key);
        });
        return AnimatedBuilder(animation: _zoom, builder: (context, _) {
          final progress = Curves.easeInOutCubic.transform(_zoom.value);
          return Stack(clipBehavior: Clip.hardEdge, children: [
            ExcludeSemantics(excluding: !_inOverview,
              child: IgnorePointer(ignoring: !_inOverview,
                child: _overview(geometry))),
            for (final entry in slots)
              _buildSlot(entry.key, entry.value, geometry, progress),
          ]);
        });
      },
    )),
  ));

  Widget _buildSlot(String id, _DesktopSlot slot,
      _OverviewGeometry geometry, double progress) {
    final active = id == _key(_active);
    final index = _machines.indexWhere((m) => _key(m) == id);
    final target = geometry.preview(index, _page);
    final slotProgress = active ? progress : 1.0;
    final scale = lerpDouble(1, target.width / geometry.size.width, slotProgress)!;
    final dx = target.left * slotProgress, dy = target.top * slotProgress;
    return Positioned.fill(key: ValueKey('space-slot-$id'), child: Offstage(
      offstage: !active && progress == 0,
      child: TickerMode(enabled: active && !_inOverview,
        child: ExcludeSemantics(excluding: !active || _inOverview,
          child: IgnorePointer(ignoring: !active || progress > 0 || _inOverview,
            child: FocusScope(canRequestFocus: active && !_inOverview,
              child: Transform(
                alignment: Alignment.topLeft,
                transform: Matrix4.diagonal3Values(scale, scale, 1)..setTranslationRaw(dx, dy, 0),
                child: AnimatedScale(
                  scale: active && _pressed && !_inOverview ? .97 : 1,
                  duration: const Duration(milliseconds: 120),
                  child: ClipRRect(borderRadius: BorderRadius.circular(
                    lerpDouble(0, 26 / scale, slotProgress)!),
                    child: _scope(NavigatorPopHandler<void>(
                      enabled: active && !_inOverview,
                      onPopWithResult: (_) => slot.navigator.currentState?.maybePop(),
                      child: Navigator(key: slot.navigator,
                        onGenerateRoute: (_) => MaterialPageRoute<void>(builder: (_) =>
                          ChangeNotifierProvider(
                            create: (_) => SessionManager(settings: slot.settings),
                            child: MainShell(settings: slot.settings),
                          )),
                      ),
                    ), machine: slot.machine),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ));
  }

  @override
  void dispose() {
    ++_refreshGeneration; ++_statusGeneration;
    _pages.dispose(); _zoom.dispose(); _service.dispose();
    super.dispose();
  }
}
