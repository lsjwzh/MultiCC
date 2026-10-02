import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../i18n.dart';
import '../services/manage_service.dart';

/// Device addresses are write-only: the server returns names and opaque IDs.
class BarkDevicesCard extends StatefulWidget {
  final ManageService service;
  final List<Map<String, dynamic>> devices;
  const BarkDevicesCard({
    super.key,
    required this.service,
    required this.devices,
  });

  @override
  State<BarkDevicesCard> createState() => _BarkDevicesCardState();
}

class _BarkDevicesCardState extends State<BarkDevicesCard> {
  late List<Map<String, dynamic>> _devices = widget.devices;
  final _name = TextEditingController();
  final _address = TextEditingController();
  bool _busy = false;
  late bool _adding = _devices.isEmpty;
  String? _status;

  @override
  void didUpdateWidget(covariant BarkDevicesCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.devices != widget.devices) _devices = widget.devices;
  }

  @override
  void dispose() {
    _name.dispose();
    _address.dispose();
    super.dispose();
  }

  Future<Map<String, dynamic>> _perform(Map<String, dynamic> body) async {
    final result = await widget.service.barkDeviceAction(body);
    if (mounted && result['devices'] is List) {
      setState(
        () => _devices = (result['devices'] as List)
            .map((d) => (d as Map).cast<String, dynamic>())
            .toList(),
      );
    }
    return result;
  }

  String _errorKey(Object error) {
    final text = error.toString();
    if (text.contains('device_already_added')) return 'barkDuplicate';
    if (text.contains('invalid_bark_address')) return 'barkInvalidAddress';
    if (text.contains('invalid_device_name')) return 'barkNeedName';
    return 'barkActionFailed';
  }

  Future<void> _add() async {
    if (_busy) return;
    if (_name.text.trim().isEmpty || _address.text.trim().isEmpty) {
      setState(
        () => _status = t(
          _name.text.trim().isEmpty ? 'barkNeedName' : 'barkInvalidAddress',
        ),
      );
      return;
    }
    setState(() {
      _busy = true;
      _status = t('barkWorking');
    });
    var saved = false;
    try {
      final result = await _perform({
        'action': 'add',
        'name': _name.text.trim(),
        'url': _address.text.trim(),
      });
      saved = true;
      if (!mounted) return;
      _name.clear();
      _address.clear();
      setState(() => _adding = false);
      await _perform({'action': 'test', 'id': result['id']});
      if (mounted) setState(() => _status = t('barkTestAccepted'));
    } catch (error) {
      if (mounted) {
        setState(
          () => _status = t(saved ? 'barkAddedTestFailed' : _errorKey(error)),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _action(
    Map<String, dynamic> device,
    String action, [
    Map<String, dynamic> extra = const {},
  ]) async {
    if (_busy) return;
    if (action == 'remove') {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(t('barkRemove')),
          content: Text(t('barkRemoveConfirm')),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: Text(t('cancel')),
            ),
            TextButton(
              onPressed: () => Navigator.pop(context, true),
              child: Text(t('barkRemove')),
            ),
          ],
        ),
      );
      if (confirmed != true || !mounted) return;
    }
    setState(() {
      _busy = true;
      _status = t('barkWorking');
    });
    try {
      await _perform({'action': action, 'id': device['id'], ...extra});
      if (mounted) {
        setState(
          () =>
              _status = t(action == 'test' ? 'barkTestAccepted' : 'barkSaved'),
        );
      }
    } catch (error) {
      if (mounted) {
        setState(
          () => _status = t(
            action == 'test' ? 'barkTestFailed' : _errorKey(error),
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _rename(Map<String, dynamic> device) async {
    var name = device['name'] as String;
    final value = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(t('barkPhoneName')),
        content: TextFormField(
          initialValue: name,
          maxLength: 60,
          onChanged: (value) => name = value,
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: Text(t('cancel')),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, name),
            child: Text(t('save')),
          ),
        ],
      ),
    );
    if (value != null && mounted) {
      await _action(device, 'update', {'name': value});
    }
  }

  @override
  Widget build(BuildContext context) => Card(
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            t('barkPhonesTitle'),
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 8),
          Text(t('barkPhonesScope')),
          if (_devices.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: Text(t('barkNoPhones')),
            ),
          for (final device in _devices) ...[
            const Divider(),
            Text(
              device['legacy'] == true && device['name'] == '原有手机'
                  ? t('barkLegacyPhone')
                  : device['name'] as String,
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
            Text(
              t(
                device['enabled'] == true
                    ? 'barkPhoneEnabled'
                    : 'barkPhoneDisabled',
              ),
            ),
            Wrap(
              spacing: 8,
              children: [
                TextButton(
                  onPressed: _busy ? null : () => _action(device, 'test'),
                  child: Text(t('barkTestPhone')),
                ),
                TextButton(
                  onPressed: _busy
                      ? null
                      : () => _action(device, 'update', {
                          'enabled': device['enabled'] != true,
                        }),
                  child: Text(
                    t(device['enabled'] == true ? 'barkDisable' : 'barkEnable'),
                  ),
                ),
                TextButton(
                  onPressed: _busy ? null : () => _rename(device),
                  child: Text(t('rename')),
                ),
                TextButton(
                  onPressed: _busy ? null : () => _action(device, 'remove'),
                  child: Text(t('barkRemove')),
                ),
              ],
            ),
          ],
          OutlinedButton.icon(
            onPressed: _busy ? null : () => setState(() => _adding = !_adding),
            icon: const Icon(Icons.add),
            label: Text(t('barkAddPhone')),
          ),
          if (_adding) ...[
            Text(t('barkStepOne')),
            TextButton(
              onPressed: () async {
                try {
                  await launchUrl(
                    Uri.parse('https://apps.apple.com/app/id1403753865'),
                    mode: LaunchMode.externalApplication,
                  );
                } catch (_) {
                  if (mounted) setState(() => _status = t('barkActionFailed'));
                }
              },
              child: Text(t('barkInstall')),
            ),
            Text(t('barkStepTwo')),
            const SizedBox(height: 12),
            TextField(
              controller: _name,
              enabled: !_busy,
              maxLength: 60,
              decoration: InputDecoration(
                labelText: t('barkPhoneName'),
                hintText: t('barkNameHint'),
              ),
            ),
            TextField(
              controller: _address,
              enabled: !_busy,
              obscureText: true,
              autocorrect: false,
              enableSuggestions: false,
              decoration: InputDecoration(
                labelText: t('barkAddress'),
                hintText: 'https://api.day.app/…',
              ),
            ),
            TextButton(
              onPressed: _busy
                  ? null
                  : () async {
                      try {
                        final data = await Clipboard.getData(
                          Clipboard.kTextPlain,
                        );
                        if (mounted) _address.text = data?.text ?? '';
                      } catch (_) {
                        if (mounted) {
                          setState(() => _status = t('barkPasteManually'));
                        }
                      }
                    },
              child: Text(t('barkPaste')),
            ),
            Text(t('barkStepThree')),
            FilledButton(
              onPressed: _busy ? null : _add,
              child: Text(t('barkAddAndTest')),
            ),
          ],
          if (_status != null)
            Semantics(
              liveRegion: true,
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: Text(_status!),
              ),
            ),
          const SizedBox(height: 8),
          Text(
            t('barkReminderLimit'),
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ],
      ),
    ),
  );
}
