import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:xterm/xterm.dart';

import '../models/message.dart';
import '../providers/session_manager.dart';
import '../services/session_service.dart';
import '../services/settings_service.dart';
import '../services/terminal_service.dart';
import '../widgets/conflict_diff_dialog.dart';
import 'memo_screen.dart';

class TerminalScreen extends StatefulWidget {
  final SettingsService settings;
  final Session session;

  const TerminalScreen({
    super.key,
    required this.settings,
    required this.session,
  });

  @override
  State<TerminalScreen> createState() => _TerminalScreenState();
}

class _TerminalScreenState extends State<TerminalScreen> {
  late TerminalService _svc;
  TerminalConnectionState _connState = TerminalConnectionState.disconnected;

  @override
  void initState() {
    super.initState();
    _svc = TerminalService(settings: widget.settings, sessionId: widget.session.id);
    _svc.onStateChange.listen((s) {
      if (mounted) setState(() => _connState = s);
    });
    _svc.connect();
  }

  @override
  void dispose() {
    _svc.dispose();
    super.dispose();
  }

  Future<void> _confirmMerge() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: const Color(0xFF0f1115),
        title: const Text('合并 worktree',
            style: TextStyle(fontSize: 15, color: Color(0xFFf2f4f7))),
        content: const Text(
          '把此会话 worktree 的改动合并回基分支？\n未提交的改动会先自动提交。',
          style: TextStyle(color: Color(0xFFe7eaee)),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('取消', style: TextStyle(color: Color(0xFF8a909b))),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('合并',
                style: TextStyle(color: Color(0xFF6aa3ff), fontWeight: FontWeight.w600)),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    messenger.showSnackBar(const SnackBar(content: Text('正在合并 worktree...')));
    try {
      final result = await SessionService(settings: widget.settings)
          .mergeSession(widget.session.id);
      final hasConflict =
          result['conflicts'] is List && (result['conflicts'] as List).isNotEmpty;
      String msg;
      if (result['ok'] == true) {
        msg = result['merged'] == true
            ? '✓ 已合并 ${result['commits']} 个提交回基分支'
            : '✓ ${result['message'] ?? '没有新提交需要合并'}';
      } else if (result['conflicts'] != null) {
        msg = '⚠️ 合并冲突，已 abort：${(result['conflicts'] as List).join(', ')}';
      } else {
        msg = '合并失败：${result['error'] ?? ''}';
      }
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(SnackBar(content: Text(msg)));
      if (hasConflict && mounted) {
        await showConflictDiffDialog(
          context,
          sessionId: widget.session.id,
          result: result,
        );
      }
    } catch (e) {
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(SnackBar(content: Text('合并请求失败：$e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF070809),
      appBar: PreferredSize(
        preferredSize: const Size.fromHeight(48),
        child: _TerminalAppBar(
          session: widget.session,
          connState: _connState,
          onReconnect: _svc.manualReconnect,
          onMerge: _confirmMerge,
        ),
      ),
      body: SafeArea(
        top: false,
        child: Column(
          children: [
            Expanded(
              child: TerminalView(
                _svc.terminal,
                theme: _kTerminalTheme,
                textStyle: const TerminalStyle(
                  fontSize: 13,
                  fontFamily: 'monospace',
                ),
                autofocus: true,
                backgroundOpacity: 1.0,
                padding: const EdgeInsets.all(4),
                onSecondaryTapDown: (details, offset) {
                  // Context menu for copy on long press could be added here
                },
              ),
            ),
            _MobileKeyBar(terminal: _svc.terminal),
          ],
        ),
      ),
    );
  }
}

class _TerminalAppBar extends StatelessWidget {
  final Session session;
  final TerminalConnectionState connState;
  final VoidCallback onReconnect;
  final VoidCallback onMerge;

  const _TerminalAppBar({
    required this.session,
    required this.connState,
    required this.onReconnect,
    required this.onMerge,
  });

  @override
  Widget build(BuildContext context) {
    Color dotColor;
    String stateLabel;
    switch (connState) {
      case TerminalConnectionState.connected:
        dotColor = const Color(0xFF7fd49a);
        stateLabel = 'Connected';
        break;
      case TerminalConnectionState.connecting:
        dotColor = const Color(0xFFe3b341);
        stateLabel = 'Connecting…';
        break;
      case TerminalConnectionState.disconnected:
        dotColor = const Color(0xFF5b616c);
        stateLabel = 'Disconnected';
        break;
    }

    return Container(
      decoration: const BoxDecoration(
        color: Color(0xFF0f1115),
        border: Border(bottom: BorderSide(color: Color(0xFF20242b))),
      ),
      padding: EdgeInsets.fromLTRB(
        12, MediaQuery.of(context).padding.top + 4, 12, 4),
      child: Row(
        children: [
          GestureDetector(
            onTap: () => Navigator.of(context).pop(),
            child: const Icon(Icons.arrow_back_rounded, color: Color(0xFFe7eaee), size: 20),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
                  children: [
                    _cliBadge(session.cli),
                    const SizedBox(width: 6),
                    Flexible(
                      child: Text(
                        session.label?.isNotEmpty == true ? session.label! : session.id,
                        style: const TextStyle(
                          color: Color(0xFFf2f4f7),
                          fontWeight: FontWeight.w600,
                          fontSize: 14,
                          fontFamily: 'monospace',
                        ),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ],
                ),
                Row(
                  children: [
                    Container(
                      width: 6, height: 6,
                      decoration: BoxDecoration(color: dotColor, shape: BoxShape.circle),
                    ),
                    const SizedBox(width: 5),
                    Text(stateLabel, style: const TextStyle(color: Color(0xFF8a909b), fontSize: 11)),
                    const SizedBox(width: 8),
                    Text(
                      session.shortCwd,
                      style: const TextStyle(color: Color(0xFF454b54), fontSize: 11, fontFamily: 'monospace'),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ),
              ],
            ),
          ),
          Tooltip(
            message: '项目备忘 (multicc.memo.md)',
            child: GestureDetector(
              onTap: () => _openMemoFromTerminal(context, session.id),
              child: const Padding(
                padding: EdgeInsets.symmetric(horizontal: 6),
                child: Icon(Icons.sticky_note_2_outlined, color: Color(0xFFe7eaee), size: 20),
              ),
            ),
          ),
          Tooltip(
            message: '合并 worktree',
            child: GestureDetector(
              onTap: onMerge,
              child: const Padding(
                padding: EdgeInsets.symmetric(horizontal: 6),
                child: Icon(Icons.merge_type, color: Color(0xFFe7eaee), size: 20),
              ),
            ),
          ),
          if (connState == TerminalConnectionState.disconnected)
            GestureDetector(
              onTap: onReconnect,
              child: const Icon(Icons.refresh_rounded, color: Color(0xFF6aa3ff), size: 20),
            ),
        ],
      ),
    );
  }
}

// Open the directory-memo screen for the terminal session's directory.
void _openMemoFromTerminal(BuildContext context, String sessionId) {
  final mgr = Provider.of<SessionManager>(context, listen: false);
  Session? s;
  for (final x in mgr.sessions) {
    if (x.id == sessionId) { s = x; break; }
  }
  if (s == null) {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Session 信息未加载')),
    );
    return;
  }
  Directory? d;
  for (final x in mgr.directories) {
    if (x.id == s.dirId) { d = x; break; }
  }
  if (d == null) {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('找不到对应目录')),
    );
    return;
  }
  Navigator.push(
    context,
    MaterialPageRoute<void>(
      builder: (_) => MemoScreen(directory: d!, mgr: mgr),
    ),
  );
}

Widget _cliBadge(SessionCli cli) {
  final color = cli == SessionCli.codex ? const Color(0xFF7fd49a) : const Color(0xFFf0936b);
  return Container(
    padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
    decoration: BoxDecoration(
      color: color.withOpacity(0.15),
      border: Border.all(color: color.withOpacity(0.4)),
      borderRadius: BorderRadius.circular(4),
    ),
    child: Text(cli.name, style: TextStyle(color: color, fontSize: 9, fontWeight: FontWeight.w700)),
  );
}

/// Mobile-friendly key bar for common terminal keys
class _MobileKeyBar extends StatelessWidget {
  final Terminal terminal;
  const _MobileKeyBar({required this.terminal});

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        color: Color(0xFF0f1115),
        border: Border(top: BorderSide(color: Color(0xFF20242b))),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 6),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          children: [
            _Key('Ctrl+C', () => terminal.keyInput(TerminalKey.keyC, ctrl: true)),
            _Key('Ctrl+D', () => terminal.keyInput(TerminalKey.keyD, ctrl: true)),
            _Key('Ctrl+Z', () => terminal.keyInput(TerminalKey.keyZ, ctrl: true)),
            _Key('Tab', () => terminal.keyInput(TerminalKey.tab)),
            _Key('Esc', () => terminal.keyInput(TerminalKey.escape)),
            _Key('↑', () => terminal.keyInput(TerminalKey.arrowUp)),
            _Key('↓', () => terminal.keyInput(TerminalKey.arrowDown)),
            _Key('←', () => terminal.keyInput(TerminalKey.arrowLeft)),
            _Key('→', () => terminal.keyInput(TerminalKey.arrowRight)),
            _Key('Home', () => terminal.keyInput(TerminalKey.home)),
            _Key('End', () => terminal.keyInput(TerminalKey.end)),
          ],
        ),
      ),
    );
  }
}

class _Key extends StatelessWidget {
  final String label;
  final VoidCallback onTap;
  const _Key(this.label, this.onTap);

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        margin: const EdgeInsets.symmetric(horizontal: 3),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(
          color: const Color(0xFF14171c),
          border: Border.all(color: const Color(0xFF20242b)),
          borderRadius: BorderRadius.circular(5),
        ),
        child: Text(
          label,
          style: const TextStyle(
            color: Color(0xFFe7eaee),
            fontSize: 12,
            fontFamily: 'monospace',
          ),
        ),
      ),
    );
  }
}

/// Terminal color theme matching web client
const _kTerminalTheme = TerminalTheme(
  cursor: Color(0xFFf0936b),
  selection: Color(0x44264f78),
  foreground: Color(0xFFe7eaee),
  background: Color(0xFF070809),
  black: Color(0xFF454b54),
  red: Color(0xFFff8a83),
  green: Color(0xFF7fd49a),
  yellow: Color(0xFFe3b341),
  blue: Color(0xFF6aa3ff),
  magenta: Color(0xFFbc8cff),
  cyan: Color(0xFF39c5cf),
  white: Color(0xFFb6bcc6),
  brightBlack: Color(0xFF5b616c),
  brightRed: Color(0xFFffb3ae),
  brightGreen: Color(0xFF56d364),
  brightYellow: Color(0xFFe3b341),
  brightBlue: Color(0xFF6aa3ff),
  brightMagenta: Color(0xFFd2a8ff),
  brightCyan: Color(0xFF56d4dd),
  brightWhite: Color(0xFFf2f4f7),
  searchHitBackground: Color(0xFFe3b341),
  searchHitBackgroundCurrent: Color(0xFF7fd49a),
  searchHitForeground: Color(0xFF070809),
);
