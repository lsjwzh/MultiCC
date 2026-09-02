import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../i18n.dart';
import '../providers/session_manager.dart';
import '../services/connection_probe_service.dart';
import '../services/settings_service.dart';
import '../widgets/lan_discovery_picker.dart';
import 'main_shell.dart';

class SetupScreen extends StatefulWidget {
  final SettingsService settings;
  final ConnectionProbeService? probeService;
  const SetupScreen({super.key, required this.settings, this.probeService});

  @override
  State<SetupScreen> createState() => _SetupScreenState();
}

class _SetupScreenState extends State<SetupScreen> {
  final _hostCtrl = TextEditingController();
  final _tokenCtrl = TextEditingController();
  late List<ServerHistoryEntry> _history;
  late final bool _isFirstConnection;
  late final ConnectionProbeService _probe;
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _hostCtrl.text = widget.settings.host;
    _tokenCtrl.text = widget.settings.token;
    _history = widget.settings.serverHistory;
    _isFirstConnection = !widget.settings.isConfigured;
    _probe = widget.probeService ?? ConnectionProbeService();
  }

  @override
  void dispose() {
    if (widget.probeService == null) _probe.close();
    _hostCtrl.dispose();
    _tokenCtrl.dispose();
    super.dispose();
  }

  String _norm(String v) =>
      v.trim().replaceAll(RegExp(r'/+$'), '').toLowerCase();

  Future<void> _clearHistory() async {
    await widget.settings.clearServerHistory();
    if (!mounted) return;
    setState(() => _history = []);
  }

  Future<void> _save() async {
    final host = _hostCtrl.text.trim();
    if (host.isEmpty) {
      setState(() => _error = t('serverAddressRequired'));
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    final token = _tokenCtrl.text.trim();
    FocusManager.instance.primaryFocus?.unfocus();
    final result = await _probe.probe(host: host, token: token);
    if (!mounted) return;
    if (!result.ok) {
      setState(() {
        _saving = false;
        _error = _messageFor(result.failure!);
      });
      return;
    }
    await widget.settings.save(host: result.normalizedHost, token: token);
    if (_isFirstConnection) await widget.settings.setAdvancedMode(false);
    await widget.settings.rememberServer(result.normalizedHost, token);
    if (!mounted) return;
    Navigator.of(context).pushReplacement(
      MaterialPageRoute(
        builder: (_) => ChangeNotifierProvider(
          create: (_) => SessionManager(settings: widget.settings),
          child: MainShell(settings: widget.settings),
        ),
      ),
    );
  }

  String _messageFor(ConnectionProbeFailure failure) => switch (failure) {
    ConnectionProbeFailure.invalidAddress => t('connectErrorInvalidAddress'),
    ConnectionProbeFailure.insecureAddress => t('connectErrorInsecureAddress'),
    ConnectionProbeFailure.unreachable => t('connectErrorUnreachable'),
    ConnectionProbeFailure.authentication => t('connectErrorAuthentication'),
    ConnectionProbeFailure.notMulticc => t('connectErrorNotMulticc'),
    ConnectionProbeFailure.notReady => t('connectErrorNotReady'),
    ConnectionProbeFailure.incompatible => t('connectErrorIncompatible'),
  };

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF070809),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // Logo
                const Text(
                  'MultiCC',
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    color: Color(0xFF3ad6c5),
                    fontSize: 32,
                    fontWeight: FontWeight.bold,
                    letterSpacing: 1,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  t('productTagline'),
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    color: Color(0xFF8a909b),
                    fontSize: 14,
                  ),
                ),
                const SizedBox(height: 40),

                SegmentedButton<String>(
                  segments: [
                    ButtonSegment(
                      value: 'zh',
                      label: Text(t('languageChinese')),
                    ),
                    ButtonSegment(
                      value: 'en',
                      label: Text(t('languageEnglish')),
                    ),
                  ],
                  selected: {widget.settings.lang},
                  onSelectionChanged: (selection) =>
                      widget.settings.setLanguage(selection.first),
                ),
                const SizedBox(height: 16),

                // Card
                Container(
                  padding: const EdgeInsets.all(24),
                  decoration: BoxDecoration(
                    color: const Color(0xFF0f1115),
                    border: Border.all(color: const Color(0xFF20242b)),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Text(
                        t('connectToMulticc'),
                        style: const TextStyle(
                          color: Color(0xFFf2f4f7),
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        t('setupConnectionHint'),
                        style: const TextStyle(
                          color: Color(0xFF8a909b),
                          fontSize: 12,
                          height: 1.45,
                        ),
                      ),
                      const SizedBox(height: 20),

                      if (_history.isNotEmpty) ...[
                        Row(
                          children: [
                            Expanded(child: _FieldLabel(t('recentServers'))),
                            InkWell(
                              onTap: _clearHistory,
                              child: Padding(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 4,
                                  vertical: 2,
                                ),
                                child: Text(
                                  t('clearAction'),
                                  style: const TextStyle(
                                    color: Color(0xFFff6b63),
                                    fontSize: 12,
                                  ),
                                ),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 6),
                        _HistoryDropdown(
                          entries: _history,
                          currentHost: _hostCtrl.text.trim(),
                          norm: _norm,
                          onSelected: (e) => setState(() {
                            _hostCtrl.text = e.host;
                            _tokenCtrl.text = e.token;
                            _error = null;
                          }),
                        ),
                        const SizedBox(height: 16),
                      ],

                      _FieldLabel(t('serverUrl')),
                      const SizedBox(height: 6),
                      _Field(
                        controller: _hostCtrl,
                        hint: 'http://192.168.1.100:3456',
                        keyboardType: TextInputType.url,
                        onChanged: (_) => setState(() => _error = null),
                      ),
                      const SizedBox(height: 8),
                      LanDiscoveryPicker(
                        onSelected: (server) => setState(() {
                          // Discovery only completes the address field. The
                          // existing token and explicit Connect action remain
                          // untouched.
                          _hostCtrl.text = server.httpUrl;
                          _error = null;
                        }),
                      ),
                      const SizedBox(height: 16),

                      _FieldLabel(t('accessToken')),
                      const SizedBox(height: 6),
                      _Field(
                        controller: _tokenCtrl,
                        hint: t('optionalIfUnset'),
                        obscure: true,
                        onChanged: (_) => setState(() => _error = null),
                      ),

                      if (_error != null) ...[
                        const SizedBox(height: 12),
                        Semantics(
                          liveRegion: true,
                          child: Container(
                            key: const ValueKey('connection-error'),
                            padding: const EdgeInsets.all(10),
                            decoration: BoxDecoration(
                              color: const Color(0x1FFF6B63),
                              border: Border.all(
                                color: const Color(0x55FF6B63),
                              ),
                              borderRadius: BorderRadius.circular(8),
                            ),
                            child: Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                const Icon(
                                  Icons.error_outline_rounded,
                                  color: Color(0xFFff6b63),
                                  size: 18,
                                ),
                                const SizedBox(width: 8),
                                Expanded(
                                  child: Text(
                                    _error!,
                                    style: const TextStyle(
                                      color: Color(0xFFFFA29D),
                                      fontSize: 12.5,
                                      height: 1.4,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ],

                      const SizedBox(height: 24),
                      ElevatedButton(
                        onPressed: _saving ? null : _save,
                        style: ElevatedButton.styleFrom(
                          backgroundColor: const Color(0xFF22ab9c),
                          foregroundColor: Colors.white,
                          padding: const EdgeInsets.symmetric(vertical: 14),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(8),
                          ),
                        ),
                        child: _saving
                            ? const SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                  color: Colors.white,
                                ),
                              )
                            : Text(
                                t('verifyAndConnect'),
                                style: const TextStyle(
                                  fontWeight: FontWeight.w600,
                                  fontSize: 15,
                                ),
                              ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _HistoryDropdown extends StatelessWidget {
  final List<ServerHistoryEntry> entries;
  final String currentHost;
  final String Function(String) norm;
  final ValueChanged<ServerHistoryEntry> onSelected;
  const _HistoryDropdown({
    required this.entries,
    required this.currentHost,
    required this.norm,
    required this.onSelected,
  });

  @override
  Widget build(BuildContext context) {
    ServerHistoryEntry? selected;
    for (final e in entries) {
      if (norm(e.host) == norm(currentHost)) {
        selected = e;
        break;
      }
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: BoxDecoration(
        color: const Color(0xFF070809),
        border: Border.all(color: const Color(0xFF20242b)),
        borderRadius: BorderRadius.circular(6),
      ),
      child: DropdownButtonHideUnderline(
        child: DropdownButton<ServerHistoryEntry>(
          value: selected,
          isExpanded: true,
          dropdownColor: const Color(0xFF0f1115),
          icon: const Icon(Icons.history, color: Color(0xFF8a909b), size: 18),
          hint: Text(
            t('selectFromHistory'),
            style: const TextStyle(color: Color(0xFF454b54), fontSize: 14),
          ),
          style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 14),
          items: entries
              .map(
                (e) => DropdownMenuItem<ServerHistoryEntry>(
                  value: e,
                  child: Text(
                    e.token.isEmpty
                        ? e.host
                        : '${e.host}  ·  ${t('tokenSaved')}',
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: Color(0xFFe7eaee),
                      fontSize: 14,
                    ),
                  ),
                ),
              )
              .toList(),
          onChanged: (e) {
            if (e != null) onSelected(e);
          },
        ),
      ),
    );
  }
}

class _FieldLabel extends StatelessWidget {
  final String text;
  const _FieldLabel(this.text);

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      style: const TextStyle(
        color: Color(0xFF8a909b),
        fontSize: 12,
        fontWeight: FontWeight.w500,
      ),
    );
  }
}

class _Field extends StatelessWidget {
  final TextEditingController controller;
  final String hint;
  final bool obscure;
  final TextInputType? keyboardType;
  final ValueChanged<String>? onChanged;

  const _Field({
    required this.controller,
    required this.hint,
    this.obscure = false,
    this.keyboardType,
    this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: controller,
      obscureText: obscure,
      keyboardType: keyboardType,
      onChanged: onChanged,
      autocorrect: false,
      style: const TextStyle(color: Color(0xFFe7eaee), fontSize: 14),
      decoration: InputDecoration(
        hintText: hint,
        hintStyle: const TextStyle(color: Color(0xFF454b54)),
        filled: true,
        fillColor: const Color(0xFF070809),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(6),
          borderSide: const BorderSide(color: Color(0xFF20242b)),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(6),
          borderSide: const BorderSide(color: Color(0xFF20242b)),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(6),
          borderSide: const BorderSide(color: Color(0xFF6aa3ff)),
        ),
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 12,
          vertical: 10,
        ),
      ),
    );
  }
}
