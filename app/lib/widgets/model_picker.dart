import 'package:flutter/material.dart';

import '../models/message.dart';

/// Bottom-sheet model picker for claude sessions.
/// Resolves to null (cancelled), '' (follow default) or a model id.
Future<String?> showClaudeModelPicker(
  BuildContext context, {
  String current = '',
  String title = '选择该会话使用的模型',
}) {
  return showModalBottomSheet<String>(
    context: context,
    backgroundColor: const Color(0xFF161b22),
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(14)),
    ),
    builder: (ctx) {
      final isKnown = kClaudeModelOptions.any((e) => e.key == current);
      return SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 16, 18, 8),
              child: Text(
                title,
                style: const TextStyle(
                  color: Color(0xFFf0f6fc),
                  fontSize: 15,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            for (final e in kClaudeModelOptions)
              ListTile(
                dense: true,
                title: Text(
                  e.value,
                  style: const TextStyle(
                    color: Color(0xFFc9d1d9),
                    fontSize: 14,
                  ),
                ),
                trailing: e.key == current
                    ? const Icon(
                        Icons.check_rounded,
                        size: 18,
                        color: Color(0xFF3fb950),
                      )
                    : null,
                onTap: () => Navigator.pop(ctx, e.key),
              ),
            ListTile(
              dense: true,
              title: Text(
                !isKnown && current.isNotEmpty ? '自定义…（当前：$current）' : '自定义…',
                style: const TextStyle(color: Color(0xFFc9d1d9), fontSize: 14),
              ),
              trailing: !isKnown && current.isNotEmpty
                  ? const Icon(
                      Icons.check_rounded,
                      size: 18,
                      color: Color(0xFF3fb950),
                    )
                  : null,
              onTap: () async {
                final v = await _showCustomModelDialog(
                  ctx,
                  initial: isKnown ? '' : current,
                );
                if (!ctx.mounted) return;
                if (v != null && v.isNotEmpty) Navigator.pop(ctx, v);
              },
            ),
            const SizedBox(height: 6),
          ],
        ),
      );
    },
  );
}

Future<String?> _showCustomModelDialog(
  BuildContext context, {
  String initial = '',
}) {
  final ctrl = TextEditingController(text: initial);
  return showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      backgroundColor: const Color(0xFF161b22),
      title: const Text(
        '自定义模型 ID',
        style: TextStyle(fontSize: 15, color: Color(0xFFf0f6fc)),
      ),
      content: TextField(
        controller: ctrl,
        autofocus: true,
        style: const TextStyle(
          color: Color(0xFFc9d1d9),
          fontFamily: 'monospace',
          fontSize: 13,
        ),
        decoration: InputDecoration(
          hintText: 'claude-opus-4-8',
          hintStyle: const TextStyle(color: Color(0xFF484f58)),
          filled: true,
          fillColor: const Color(0xFF0d1117),
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(6)),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(6),
            borderSide: const BorderSide(color: Color(0xFF30363d)),
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(ctx),
          child: const Text('取消', style: TextStyle(color: Color(0xFF8b949e))),
        ),
        TextButton(
          onPressed: () => Navigator.pop(ctx, ctrl.text.trim()),
          child: const Text(
            '确定',
            style: TextStyle(
              color: Color(0xFF58a6ff),
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      ],
    ),
  );
}
