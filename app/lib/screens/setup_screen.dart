import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../i18n.dart';
import '../providers/session_manager.dart';
import '../services/settings_service.dart';
import 'main_shell.dart';

class SetupScreen extends StatefulWidget {
  final SettingsService settings;
  const SetupScreen({super.key, required this.settings});

  @override
  State<SetupScreen> createState() => _SetupScreenState();
}

class _SetupScreenState extends State<SetupScreen> {
  final _hostCtrl = TextEditingController();
  final _tokenCtrl = TextEditingController();
  late List<ServerHistoryEntry> _history;
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _hostCtrl.text = widget.settings.host;
    _tokenCtrl.text = widget.settings.token;
    _history = widget.settings.serverHistory;
  }

  @override
  void dispose() {
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
    await widget.settings.save(host: host, token: token);
    await widget.settings.rememberServer(host, token);
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
                const Text(
                  'Claude Code Chat',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Color(0xFF8a909b), fontSize: 14),
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
                        t('serverConnection'),
                        style: const TextStyle(
                          color: Color(0xFFf2f4f7),
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
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
                      ),
                      const SizedBox(height: 16),

                      _FieldLabel(t('accessToken')),
                      const SizedBox(height: 6),
                      _Field(
                        controller: _tokenCtrl,
                        hint: t('optionalIfUnset'),
                        obscure: true,
                      ),

                      if (_error != null) ...[
                        const SizedBox(height: 12),
                        Text(
                          _error!,
                          style: const TextStyle(
                            color: Color(0xFFff6b63),
                            fontSize: 13,
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
                                t('connect'),
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

  const _Field({
    required this.controller,
    required this.hint,
    this.obscure = false,
    this.keyboardType,
  });

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: controller,
      obscureText: obscure,
      keyboardType: keyboardType,
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
