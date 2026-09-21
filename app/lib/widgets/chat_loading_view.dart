import 'package:flutter/material.dart';

import '../i18n.dart';

/// Used both before session resolution and while the first history page loads.
/// Keeps the return/retry controls available even on a stalled external link.
class ChatLoadingView extends StatelessWidget {
  const ChatLoadingView({
    super.key,
    this.title,
    this.error,
    this.status,
    required this.onRetry,
    this.onClose,
  });

  final String? title;
  final String? error;
  final String? status;
  final VoidCallback onRetry;
  final VoidCallback? onClose;

  @override
  Widget build(BuildContext context) {
    final content = Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (error == null) const CircularProgressIndicator(),
            const SizedBox(height: 16),
            Text(
              t(
                error != null
                    ? 'chatOpenFailed'
                    : title != null
                    ? 'chatOpeningTask'
                    : 'chatLoadingHistory',
              ),
              textAlign: TextAlign.center,
            ),
            if (status != null) Text(status!, textAlign: TextAlign.center),
            if (error != null) ...[
              const SizedBox(height: 8),
              Text(
                error!,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
            const SizedBox(height: 16),
            TextButton(onPressed: onRetry, child: Text(t('retry'))),
          ],
        ),
      ),
    );
    if (title == null) return content;
    return Scaffold(
      key: const ValueKey('pending-chat-open'),
      appBar: AppBar(
        title: Text(title!),
        leading: BackButton(onPressed: onClose),
      ),
      body: content,
    );
  }
}
