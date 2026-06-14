import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

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
  final _sessionCtrl = TextEditingController();
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _hostCtrl.text = widget.settings.host;
    _tokenCtrl.text = widget.settings.token;
    _sessionCtrl.text = widget.settings.session;
  }

  @override
  void dispose() {
    _hostCtrl.dispose();
    _tokenCtrl.dispose();
    _sessionCtrl.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final host = _hostCtrl.text.trim();
    if (host.isEmpty) {
      setState(() => _error = 'Server URL is required');
      return;
    }
    setState(() { _saving = true; _error = null; });
    await widget.settings.save(
      host: host,
      token: _tokenCtrl.text.trim(),
      session: _sessionCtrl.text.trim(),
    );
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
                      const Text(
                        'Server Configuration',
                        style: TextStyle(
                          color: Color(0xFFf2f4f7),
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(height: 20),

                      _FieldLabel('Server URL'),
                      const SizedBox(height: 6),
                      _Field(
                        controller: _hostCtrl,
                        hint: 'http://192.168.1.100:3456',
                        keyboardType: TextInputType.url,
                      ),
                      const SizedBox(height: 16),

                      _FieldLabel('Access Token'),
                      const SizedBox(height: 6),
                      _Field(
                        controller: _tokenCtrl,
                        hint: 'Leave empty if not required',
                        obscure: true,
                      ),
                      const SizedBox(height: 16),

                      _FieldLabel('Session Name (optional)'),
                      const SizedBox(height: 6),
                      _Field(
                        controller: _sessionCtrl,
                        hint: 'e.g. my-project',
                      ),

                      if (_error != null) ...[
                        const SizedBox(height: 12),
                        Text(
                          _error!,
                          style: const TextStyle(color: Color(0xFFff6b63), fontSize: 13),
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
                            : const Text(
                                'Connect',
                                style: TextStyle(fontWeight: FontWeight.w600, fontSize: 15),
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

class _FieldLabel extends StatelessWidget {
  final String text;
  const _FieldLabel(this.text);

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      style: const TextStyle(color: Color(0xFF8a909b), fontSize: 12, fontWeight: FontWeight.w500),
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
        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      ),
    );
  }
}
