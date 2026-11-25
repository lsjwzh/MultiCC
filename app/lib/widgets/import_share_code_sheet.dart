import 'package:flutter/material.dart';

import '../services/manage_service.dart';
import '../services/share_code.dart';
import '../theme.dart';

/// 粘贴另一台 MultiCC 生成的分享码，按码里写明的传输方式建线路或反重力账号。
/// 网页端对应 `public/manage-provider-relay.js` 的 `importRelayProvider`。
Future<String?> showImportShareCodeSheet(
  BuildContext context, {
  required ManageService manage,
}) {
  return showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    backgroundColor: AppColors.panel,
    shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
    builder: (_) => _ImportShareCodeSheet(manage: manage),
  );
}

class _ImportShareCodeSheet extends StatefulWidget {
  const _ImportShareCodeSheet({required this.manage});
  final ManageService manage;

  @override
  State<_ImportShareCodeSheet> createState() => _ImportShareCodeSheetState();
}

class _ImportShareCodeSheetState extends State<_ImportShareCodeSheet> {
  final _code = TextEditingController();
  bool _importing = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _code.addListener(() {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  ShareCodePayload? get _preview {
    try {
      return parseShareCode(_code.text).payload;
    } catch (_) {
      return null;
    }
  }

  Future<void> _import() async {
    final result = parseShareCode(_code.text);
    final payload = result.payload;
    if (payload == null) {
      setState(() => _error = result.error ?? '分享码无效');
      return;
    }
    setState(() {
      _importing = true;
      _error = null;
    });
    try {
      final String done;
      if (payload.isSsh) {
        await widget.manage.createAgyRemoteAccount(
          label: payload.name.isNotEmpty ? payload.name : '反重力 SSH 借用账号',
          remote: {
            'transport': 'ssh',
            'sshTarget': payload.sshTarget,
            if (payload.sshPort != null) 'sshPort': payload.sshPort,
            'fileMode': payload.fileMode,
            'identityKey': payload.identityKey,
          },
        );
        done = '已导入反重力 SSH 借用账号：${payload.sshTarget}';
      } else if (payload.isAgy) {
        await widget.manage.createAgyRemoteAccount(
          label: payload.name.isNotEmpty ? payload.name : '反重力共享账号',
          remote: {
            'transport': 'relay',
            'relayBaseUrl': payload.baseUrl,
            'relayAuthToken': payload.authToken,
            if (payload.relayShareId != null)
              'relayShareId': payload.relayShareId,
          },
        );
        done = '已导入反重力借道账号：${payload.name.isNotEmpty ? payload.name : payload.baseUrl}';
      } else {
        await widget.manage.createProvider(
          appType: payload.appType,
          name: payload.name.isNotEmpty ? payload.name : '远程共享线路',
          baseUrl: payload.baseUrl,
          authToken: payload.authToken,
          model: payload.model ?? '',
          models: payload.models,
          cliRelay: payload.mode == 'cli' ? true : null,
        );
        done = '已连接其他设备的线路：${payload.name.isNotEmpty ? payload.name : payload.baseUrl}';
      }
      if (mounted) Navigator.pop(context, done);
    } catch (e) {
      if (mounted) {
        setState(() {
          _importing = false;
          _error = '导入失败：$e';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.of(context).viewInsets.bottom;
    final preview = _preview;
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 14, 16, 16 + bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Center(
            child: Container(
              width: 38,
              height: 4,
              margin: const EdgeInsets.only(bottom: 14),
              decoration: BoxDecoration(
                  color: AppColors.line, borderRadius: BorderRadius.circular(2)),
            ),
          ),
          const Text('使用其他设备的线路',
              style: TextStyle(
                  color: AppColors.textBright,
                  fontSize: 16,
                  fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          const Text(
            '粘贴另一台 MultiCC 生成的分享码（Claude / Codex / 反重力 agy 借道码，或反重力 SSH 借用码）。'
            '分享码里已经写明对方的分享方式与传输方式，导入即可使用。',
            style: TextStyle(color: AppColors.faint, fontSize: 12, height: 1.5),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _code,
            minLines: 4,
            maxLines: 8,
            style: const TextStyle(
                color: AppColors.text,
                fontSize: 12,
                fontFamily: 'monospace',
                height: 1.4),
            decoration: InputDecoration(
              hintText: 'mcrelay1.… 或 mcssh1.…',
              hintStyle: const TextStyle(color: AppColors.faint, fontSize: 12),
              filled: true,
              fillColor: AppColors.bgSoft,
              contentPadding: const EdgeInsets.all(10),
              border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(10),
                  borderSide: const BorderSide(color: AppColors.line)),
              enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(10),
                  borderSide: const BorderSide(color: AppColors.line)),
            ),
          ),
          if (preview != null) ...[
            const SizedBox(height: 10),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              decoration: BoxDecoration(
                color: AppColors.bgSoft,
                border: Border.all(color: AppColors.line),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('方式：${preview.modeLabel}',
                      style: const TextStyle(
                          color: AppColors.textBright,
                          fontSize: 12,
                          fontWeight: FontWeight.w600)),
                  const SizedBox(height: 3),
                  Text(preview.modeHint,
                      style: const TextStyle(
                          color: AppColors.faint, fontSize: 11.5, height: 1.4)),
                ],
              ),
            ),
          ],
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(_error!,
                style: const TextStyle(color: AppColors.danger, fontSize: 12.5)),
          ],
          const SizedBox(height: 16),
          SizedBox(
            height: 46,
            child: ElevatedButton(
              onPressed: _importing ? null : _import,
              child: _importing
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(
                          strokeWidth: 2, color: Color(0xFFffffff)))
                  : const Text('导入'),
            ),
          ),
        ],
      ),
    );
  }
}
