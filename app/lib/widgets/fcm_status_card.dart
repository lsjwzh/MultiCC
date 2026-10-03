import 'package:flutter/material.dart';

import '../i18n.dart';
import '../services/fcm_service.dart';

class FcmStatusCard extends StatefulWidget {
  const FcmStatusCard({super.key});
  @override
  State<FcmStatusCard> createState() => _FcmStatusCardState();
}

class _FcmStatusCardState extends State<FcmStatusCard> {
  bool _busy = false;
  String? _result;

  @override
  Widget build(BuildContext context) {
    final service = FcmService.current;
    if (service == null) return const SizedBox.shrink();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: ValueListenableBuilder<String>(
          valueListenable: service.status,
          builder: (context, state, _) => Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                t('fcmTitle'),
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 8),
              Text(
                t(switch (state) {
                  'registered' => 'fcmRegistered',
                  'not_configured' ||
                  'server_not_configured' => 'fcmNotConfigured',
                  'no_play_services' => 'fcmNoGoogle',
                  'disabled' => 'fcmDisabled',
                  _ => 'fcmUnavailable',
                }),
              ),
              const SizedBox(height: 8),
              Text(t('fcmFallback')),
              Wrap(
                spacing: 8,
                children: [
                  TextButton(
                    onPressed: _busy
                        ? null
                        : () async {
                            setState(() => _busy = true);
                            await service.refresh();
                            if (mounted) setState(() => _busy = false);
                          },
                    child: Text(t('fcmRetry')),
                  ),
                  TextButton(
                    onPressed: _busy || state != 'registered'
                        ? null
                        : () async {
                            setState(() {
                              _busy = true;
                              _result = null;
                            });
                            final accepted = await service.test();
                            if (mounted) {
                              setState(() {
                                _busy = false;
                                _result = t(
                                  accepted
                                      ? 'fcmTestAccepted'
                                      : 'fcmTestFailed',
                                );
                              });
                            }
                          },
                    child: Text(t('fcmTest')),
                  ),
                ],
              ),
              if (_result != null) Text(_result!),
            ],
          ),
        ),
      ),
    );
  }
}
