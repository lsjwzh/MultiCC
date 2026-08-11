import 'dart:async';

import 'package:flutter/material.dart';

import '../i18n.dart';
import '../models/discovered_server.dart';
import '../services/lan_discovery_service.dart';

class LanDiscoveryPicker extends StatefulWidget {
  final ValueChanged<DiscoveredServer> onSelected;
  final LanDiscoveryService? discoveryService;
  final Duration scanDuration;

  const LanDiscoveryPicker({
    super.key,
    required this.onSelected,
    this.discoveryService,
    this.scanDuration = defaultLanDiscoveryDuration,
  });

  @override
  State<LanDiscoveryPicker> createState() => _LanDiscoveryPickerState();
}

class _LanDiscoveryPickerState extends State<LanDiscoveryPicker> {
  late final LanDiscoveryService _service;
  List<DiscoveredServer> _servers = const [];
  bool _scanning = false;
  bool _hasScanned = false;
  LanDiscoveryFailure? _failure;
  int _scanGeneration = 0;

  @override
  void initState() {
    super.initState();
    _service = widget.discoveryService ?? NsdLanDiscoveryService();
  }

  @override
  void dispose() {
    _scanGeneration++;
    unawaited(_service.stop());
    super.dispose();
  }

  Future<void> _scan() async {
    final generation = ++_scanGeneration;
    setState(() {
      _scanning = true;
      _hasScanned = false;
      _failure = null;
      _servers = const [];
    });

    try {
      final servers = await _service.scan(timeout: widget.scanDuration);
      if (!mounted || generation != _scanGeneration) return;
      setState(() {
        _servers = servers;
        _hasScanned = true;
      });
    } on LanDiscoveryException catch (error) {
      if (!mounted || generation != _scanGeneration) return;
      setState(() {
        _failure = error.failure;
        _hasScanned = true;
      });
    } catch (_) {
      if (!mounted || generation != _scanGeneration) return;
      setState(() {
        _failure = LanDiscoveryFailure.other;
        _hasScanned = true;
      });
    } finally {
      if (mounted && generation == _scanGeneration) {
        setState(() => _scanning = false);
      }
    }
  }

  String _failureMessage(LanDiscoveryFailure failure) {
    switch (failure) {
      case LanDiscoveryFailure.permissionDenied:
        return t('lanDiscoveryPermissionDenied');
      case LanDiscoveryFailure.unsupported:
        return t('lanDiscoveryUnsupported');
      case LanDiscoveryFailure.other:
        return t('lanDiscoveryFailed');
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Align(
          alignment: Alignment.centerLeft,
          child: OutlinedButton.icon(
            key: const Key('lan-discovery-button'),
            onPressed: _scanning ? null : _scan,
            icon: _scanning
                ? const SizedBox.square(
                    dimension: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.wifi_find, size: 18),
            label: Text(
              _scanning
                  ? t('lanDiscoveryScanning')
                  : _hasScanned
                  ? t('lanDiscoveryRetry')
                  : t('lanDiscoveryAction'),
            ),
          ),
        ),
        if (_scanning) ...[
          const SizedBox(height: 8),
          Text(
            t('lanDiscoveryScanningHint'),
            key: const Key('lan-discovery-scanning'),
            style: TextStyle(color: colors.onSurfaceVariant, fontSize: 12),
          ),
        ],
        if (!_scanning && _failure != null) ...[
          const SizedBox(height: 8),
          Text(
            _failureMessage(_failure!),
            key: const Key('lan-discovery-error'),
            style: TextStyle(color: colors.error, fontSize: 12),
          ),
        ] else if (!_scanning && _hasScanned && _servers.isEmpty) ...[
          const SizedBox(height: 8),
          Text(
            t('lanDiscoveryEmpty'),
            key: const Key('lan-discovery-empty'),
            style: TextStyle(color: colors.onSurfaceVariant, fontSize: 12),
          ),
        ],
        if (_servers.isNotEmpty) ...[
          const SizedBox(height: 8),
          Semantics(
            label: t('lanDiscoveryResults'),
            child: DecoratedBox(
              decoration: BoxDecoration(
                border: Border.all(color: colors.outlineVariant),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                children: [
                  for (var i = 0; i < _servers.length; i++) ...[
                    if (i > 0) Divider(height: 1, color: colors.outlineVariant),
                    _ServerResultTile(
                      server: _servers[i],
                      onTap: () => widget.onSelected(_servers[i]),
                    ),
                  ],
                ],
              ),
            ),
          ),
          const SizedBox(height: 6),
          Text(
            t('lanDiscoverySelectionHint'),
            style: TextStyle(color: colors.onSurfaceVariant, fontSize: 11),
          ),
        ],
      ],
    );
  }
}

class _ServerResultTile extends StatelessWidget {
  final DiscoveredServer server;
  final VoidCallback onTap;

  const _ServerResultTile({required this.server, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return ListTile(
      key: Key('lan-server-${server.endpointKey}'),
      dense: true,
      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
      leading: const Icon(Icons.dns_outlined, size: 20),
      title: Text(
        server.name,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(color: colors.onSurface, fontSize: 13),
      ),
      subtitle: Text(
        server.endpointLabel,
        style: TextStyle(color: colors.onSurfaceVariant, fontSize: 12),
      ),
      trailing: const Icon(Icons.north_west, size: 16),
      onTap: onTap,
    );
  }
}
