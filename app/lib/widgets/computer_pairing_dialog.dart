import 'package:flutter/material.dart';
import '../i18n.dart';
import '../services/machine_service.dart';
import '../theme.dart';

Future<ManagedComputer?> showComputerPairingDialog(
  BuildContext context, MachineService service, {ManagedComputer? existing}
) async {
  final name = TextEditingController(text: existing?.name);
  final origin = TextEditingController(text: existing?.origin);
  final password = TextEditingController();
  final key = GlobalKey<FormState>();
  bool saving = false;
  String error = '';
  ManagedComputer? connected;
  await showDialog<void>(
    context: context,
    builder: (dialogContext) => StatefulBuilder(
      builder: (_, update) => AlertDialog(
        title: Text(
          existing == null
              ? t('airMachinesAdd')
              : t('airMachinesReconnectTitle'),
        ),
        content: SingleChildScrollView(
          child: SizedBox(
            width: 380,
            child: Form(
              key: key,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (final (controller, label, secret) in [
                    (name, t('airMachinesName'), false),
                    (origin, t('airMachinesOriginFull'), false),
                    (password, t('airMachinesPassword'), true),
                  ]) ...[
                    Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: TextFormField(
                        controller: controller,
                        decoration: InputDecoration(labelText: label),
                        obscureText: secret,
                        autocorrect: false,
                        enableSuggestions: !secret,
                        validator: (value) =>
                            value == null || value.trim().isEmpty
                            ? t('airMachinesRequired')
                            : null,
                      ),
                    ),
                    // 只是静态说明：http 会把访问密码与授权明文送出。
                    if (controller == origin)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 12),
                        child: Text(
                          t('airMachinesInsecureHint'),
                          style: const TextStyle(
                            color: AppColors.muted,
                            fontSize: 12,
                          ),
                        ),
                      ),
                  ],
                  Text(t('airMachinesPairHintCurrent')),
                  if (error.isNotEmpty)
                    Text(
                      error,
                      style: const TextStyle(color: AppColors.danger),
                    ),
                ],
              ),
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: saving ? null : () => Navigator.pop(dialogContext),
            child: Text(t('cancel')),
          ),
          FilledButton(
            onPressed: saving
                ? null
                : () async {
                    if (!key.currentState!.validate()) return;
                    update(() {
                      saving = true;
                      error = '';
                    });
                    final payload = {
                      'name': name.text.trim(),
                      'origin': origin.text.trim(),
                      'password': password.text,
                      if (existing != null) 'expectedId': existing.id,
                    };
                    password.clear();
                    try {
                      final data = await service.request(
                        '/api/machines',
                        method: 'POST',
                        body: payload,
                      );
                      connected = ManagedComputer.fromJson(data);
                      if (dialogContext.mounted) Navigator.pop(dialogContext);
                    } catch (e) {
                      if (dialogContext.mounted) {
                        update(() {
                          error = '$e';
                          saving = false;
                        });
                      }
                    } finally {
                      payload['password'] = '';
                    }
                  },
            child: Text(
              saving ? t('airMachinesVerifying') : t('airMachinesVerify'),
            ),
          ),
        ],
      ),
    ),
  );
  // Dialog route disposal finishes after its closing animation.
  Future<void>.delayed(const Duration(milliseconds: 300), () {
    name.dispose();
    origin.dispose();
    password.dispose();
  });
  return connected;
}
Future<bool> removeComputerConnection(
  BuildContext context, MachineService service, ManagedComputer machine
) async {
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(
        t('airMachinesRemoveTitle', {'name': machine.name}),
      ),
      content: Text(t('airMachinesRemoveBody')),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(ctx, false),
          child: Text(t('cancel')),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(ctx, true),
          child: Text(t('airMachinesRemove')),
        ),
      ],
    ),
  );
  if (confirmed != true || !context.mounted) return false;
  try {
    final result = await service.request(
      '/api/machines/${machine.id}',
      method: 'DELETE',
    );
    if (!context.mounted) return true;
    if (result['remoteRevoked'] != true) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(t('airMachinesRemovedOffline'))),
      );
    }
    return true;
  } catch (e) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
    return false;
  }
}
