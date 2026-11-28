import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../i18n.dart';
import '../services/attachment_picker.dart';
import '../services/download_ticket_service.dart';
import '../services/settings_service.dart';
import '../theme.dart';
import 'attachment_image_editor_screen.dart';

/// Result returned by [openUploadedAttachmentPreview] / [AttachmentImagePreviewScreen].
class AttachmentPreviewResult {
  final bool deleted;
  final EditedAttachmentImage? editedImage;

  const AttachmentPreviewResult._({this.deleted = false, this.editedImage});

  const AttachmentPreviewResult.deleted() : this._(deleted: true);

  const AttachmentPreviewResult.edited(EditedAttachmentImage image)
    : this._(editedImage: image);
}

Uri? _attachmentInlineUri(SettingsService? settings, String path) {
  if (settings == null || settings.host.trim().isEmpty || path.trim().isEmpty) {
    return null;
  }
  final base = Uri.parse(settings.buildHttpUrl('/api/download'));
  return base.replace(
    queryParameters: {...base.queryParameters, 'path': path, 'inline': '1'},
  );
}

Map<String, String> _attachmentAuthHeaders(SettingsService? settings) {
  final token = settings?.token ?? '';
  return token.isNotEmpty ? {'X-Access-Token': token} : const {};
}

String _fileExtension(String nameOrPath) {
  final clean = nameOrPath.split('?').first.split('#').first.trim();
  final dot = clean.lastIndexOf('.');
  if (dot < 0 || dot == clean.length - 1) return '';
  return clean.substring(dot + 1).toLowerCase();
}

IconData _attachmentFileIcon(UploadedAttachment attachment) {
  final ext = _fileExtension(attachment.name).isNotEmpty
      ? _fileExtension(attachment.name)
      : _fileExtension(attachment.path);
  final mime = attachment.mimeType?.toLowerCase() ?? '';
  if (attachment.isImage) return Icons.image_outlined;
  if (ext == 'pdf' || mime == 'application/pdf') {
    return Icons.picture_as_pdf_outlined;
  }
  if (mime.startsWith('video/') ||
      const {'mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', '3gp'}.contains(ext)) {
    return Icons.videocam_outlined;
  }
  if (mime.startsWith('audio/') ||
      const {'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'}.contains(ext)) {
    return Icons.audiotrack_outlined;
  }
  if (const {'zip', 'tar', 'gz', 'tgz', 'rar', '7z', 'bz2'}.contains(ext)) {
    return Icons.folder_zip_outlined;
  }
  return Icons.insert_drive_file_outlined;
}

Color _attachmentFileIconColor(UploadedAttachment attachment) {
  final ext = _fileExtension(attachment.name).isNotEmpty
      ? _fileExtension(attachment.name)
      : _fileExtension(attachment.path);
  final mime = attachment.mimeType?.toLowerCase() ?? '';
  if (ext == 'pdf' || mime == 'application/pdf') return AppColors.danger;
  if (mime.startsWith('video/') ||
      const {'mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', '3gp'}.contains(ext)) {
    return AppColors.accent;
  }
  if (mime.startsWith('audio/') ||
      const {'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'}.contains(ext)) {
    return AppColors.opencode;
  }
  if (const {'zip', 'tar', 'gz', 'tgz', 'rar', '7z', 'bz2'}.contains(ext)) {
    return AppColors.amber;
  }
  return AppColors.muted;
}

/// Build an image widget for [attachment] preferring local bytes, then local
/// file path, then authenticated inline `/api/download` (token in header only).
Widget _buildAttachmentImage(
  UploadedAttachment attachment, {
  SettingsService? settings,
  double? width,
  double? height,
  BoxFit fit = BoxFit.cover,
  required Widget fallback,
}) {
  final bytes = attachment.localBytes;
  if (bytes != null && bytes.isNotEmpty) {
    return Image.memory(
      bytes,
      width: width,
      height: height,
      fit: fit,
      errorBuilder: (_, _, _) => fallback,
    );
  }
  final localPath = attachment.localPath;
  if (localPath != null && localPath.isNotEmpty) {
    return Image.file(
      File(localPath),
      width: width,
      height: height,
      fit: fit,
      errorBuilder: (_, _, _) => fallback,
    );
  }
  final uri = _attachmentInlineUri(settings, attachment.path);
  if (uri != null) {
    return Image.network(
      uri.toString(),
      headers: _attachmentAuthHeaders(settings),
      width: width,
      height: height,
      fit: fit,
      errorBuilder: (_, _, _) => fallback,
    );
  }
  return fallback;
}

/// Pending attachment chip shown above chat / Air composers.
///
/// For images, renders a 28x28 rounded thumbnail, truncated filename, quick
/// edit button, and remove button. For non-image files, renders a semantic
/// file-type icon, truncated filename, and remove button.
class UploadedAttachmentChip extends StatelessWidget {
  const UploadedAttachmentChip({
    super.key,
    required this.attachment,
    this.settings,
    this.busy = false,
    this.onTap,
    this.onEdit,
    this.onRemove,
  });

  final UploadedAttachment attachment;
  final SettingsService? settings;
  final bool busy;
  final VoidCallback? onTap;
  final VoidCallback? onEdit;
  final VoidCallback? onRemove;

  @override
  Widget build(BuildContext context) {
    final isImage = attachment.isImage;
    return Material(
      color: AppColors.bgSoft,
      borderRadius: BorderRadius.circular(8),
      child: Container(
        decoration: BoxDecoration(
          border: Border.all(color: AppColors.line),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            InkWell(
              key: ValueKey('attach-chip-body-${attachment.name}'),
              onTap: busy ? null : onTap,
              borderRadius: BorderRadius.circular(7),
              child: Padding(
                padding: EdgeInsets.fromLTRB(
                  isImage ? 4 : 8,
                  isImage ? 3 : 5,
                  6,
                  isImage ? 3 : 5,
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (isImage)
                      _buildThumbnail()
                    else if (busy)
                      const SizedBox(
                        width: 14,
                        height: 14,
                        child: CircularProgressIndicator(strokeWidth: 1.8),
                      )
                    else
                      Icon(
                        _attachmentFileIcon(attachment),
                        size: 16,
                        color: _attachmentFileIconColor(attachment),
                      ),
                    const SizedBox(width: 6),
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 140),
                      child: Text(
                        busy ? t('attachReplaceUploading') : attachment.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: AppColors.text,
                          fontSize: 12,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            if (isImage && onEdit != null)
              Tooltip(
                message: t('attachEditShort'),
                child: InkWell(
                  key: ValueKey('attach-chip-edit-${attachment.name}'),
                  onTap: busy ? null : onEdit,
                  borderRadius: BorderRadius.circular(6),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 5,
                      vertical: 5,
                    ),
                    child: Icon(
                      Icons.tune_rounded,
                      size: 15,
                      color: busy ? AppColors.faint : AppColors.accent,
                    ),
                  ),
                ),
              ),
            if (onRemove != null)
              Tooltip(
                message: t('attachDelete'),
                child: InkWell(
                  key: ValueKey('attach-chip-remove-${attachment.name}'),
                  onTap: busy ? null : onRemove,
                  borderRadius: BorderRadius.circular(6),
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(4, 5, 6, 5),
                    child: Icon(
                      Icons.close_rounded,
                      size: 15,
                      color: busy ? AppColors.lineStrong : AppColors.muted,
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildThumbnail() {
    const fallback = ColoredBox(
      color: AppColors.blueSoft,
      child: SizedBox(
        width: 28,
        height: 28,
        child: Icon(Icons.image_outlined, size: 16, color: AppColors.muted),
      ),
    );
    return ClipRRect(
      borderRadius: BorderRadius.circular(5),
      child: SizedBox(
        width: 28,
        height: 28,
        child: Stack(
          fit: StackFit.expand,
          children: [
            _buildAttachmentImage(
              attachment,
              settings: settings,
              width: 28,
              height: 28,
              fit: BoxFit.cover,
              fallback: fallback,
            ),
            if (busy)
              const ColoredBox(
                color: Color(0x88000000),
                child: Center(
                  child: SizedBox(
                    width: 14,
                    height: 14,
                    child: CircularProgressIndicator(
                      strokeWidth: 1.8,
                      color: Colors.white,
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// Full-screen black-backdrop image preview confirmation screen with zoom,
/// crop/annotate entry, and attachment removal.
class AttachmentImagePreviewScreen extends StatefulWidget {
  const AttachmentImagePreviewScreen({
    super.key,
    required this.attachment,
    this.settings,
    this.allowEdit = true,
    this.allowDelete = true,
  });

  final UploadedAttachment attachment;
  final SettingsService? settings;
  final bool allowEdit;
  final bool allowDelete;

  @override
  State<AttachmentImagePreviewScreen> createState() =>
      _AttachmentImagePreviewScreenState();
}

class _AttachmentImagePreviewScreenState
    extends State<AttachmentImagePreviewScreen> {
  final _transformCtrl = TransformationController();

  @override
  void dispose() {
    _transformCtrl.dispose();
    super.dispose();
  }

  void _resetZoom() {
    _transformCtrl.value = Matrix4.identity();
  }

  Future<void> _openEditor() async {
    final uri = _attachmentInlineUri(widget.settings, widget.attachment.path);
    final edited = await Navigator.of(context).push<EditedAttachmentImage>(
      MaterialPageRoute(
        builder: (_) => AttachmentImageEditorScreen(
          initialBytes: widget.attachment.localBytes,
          localPath: widget.attachment.localPath,
          url: uri?.toString(),
          headers: _attachmentAuthHeaders(widget.settings),
          filename: widget.attachment.name,
        ),
      ),
    );
    if (!mounted || edited == null) return;
    Navigator.of(context).pop(AttachmentPreviewResult.edited(edited));
  }

  @override
  Widget build(BuildContext context) {
    final fallback = Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(
            Icons.broken_image_outlined,
            size: 48,
            color: Colors.white54,
          ),
          const SizedBox(height: 8),
          Text(
            widget.attachment.name,
            style: const TextStyle(color: Colors.white70, fontSize: 13),
          ),
        ],
      ),
    );

    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        titleSpacing: 0,
        title: Text(
          widget.attachment.name,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500),
        ),
        actions: [
          IconButton(
            key: const ValueKey('attach-preview-reset-zoom'),
            icon: const Icon(Icons.fit_screen_rounded, size: 20),
            tooltip: t('attachPreview'),
            onPressed: _resetZoom,
          ),
        ],
      ),
      body: GestureDetector(
        onDoubleTap: _resetZoom,
        child: InteractiveViewer(
          transformationController: _transformCtrl,
          minScale: 0.5,
          maxScale: 5.0,
          child: Center(
            child: _buildAttachmentImage(
              widget.attachment,
              settings: widget.settings,
              fit: BoxFit.contain,
              fallback: fallback,
            ),
          ),
        ),
      ),
      bottomNavigationBar: (widget.allowEdit || widget.allowDelete)
          ? SafeArea(
              top: false,
              child: Container(
                color: const Color(0xFF14181F),
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 10,
                ),
                child: Row(
                  children: [
                    if (widget.allowDelete)
                      OutlinedButton.icon(
                        key: const ValueKey('attach-preview-delete'),
                        onPressed: () => Navigator.of(
                          context,
                        ).pop(const AttachmentPreviewResult.deleted()),
                        icon: const Icon(Icons.delete_outline, size: 18),
                        label: Text(t('attachDelete')),
                        style: OutlinedButton.styleFrom(
                          foregroundColor: const Color(0xFFff8a80),
                          side: const BorderSide(color: Color(0x66ff8a80)),
                        ),
                      ),
                    const Spacer(),
                    if (widget.allowEdit)
                      FilledButton.icon(
                        key: const ValueKey('attach-preview-edit'),
                        onPressed: _openEditor,
                        icon: const Icon(Icons.crop_rotate_rounded, size: 18),
                        label: Text(t('attachEdit')),
                        style: FilledButton.styleFrom(
                          backgroundColor: AppColors.accent,
                          foregroundColor: Colors.white,
                        ),
                      ),
                  ],
                ),
              ),
            )
          : null,
    );
  }
}

/// Directly open [AttachmentImageEditorScreen] for an uploaded image attachment.
Future<EditedAttachmentImage?> openUploadedAttachmentEditor(
  BuildContext context, {
  required UploadedAttachment attachment,
  required SettingsService settings,
}) {
  final uri = _attachmentInlineUri(settings, attachment.path);
  return Navigator.of(context).push<EditedAttachmentImage>(
    MaterialPageRoute(
      builder: (_) => AttachmentImageEditorScreen(
        initialBytes: attachment.localBytes,
        localPath: attachment.localPath,
        url: uri?.toString(),
        headers: _attachmentAuthHeaders(settings),
        filename: attachment.name,
      ),
    ),
  );
}

/// Open confirmation preview for an uploaded attachment.
///
/// Images open [AttachmentImagePreviewScreen]; non-image files open a bottom
/// sheet displaying file metadata, copyable server path, open-file action, and
/// remove action.
Future<AttachmentPreviewResult?> openUploadedAttachmentPreview(
  BuildContext context, {
  required UploadedAttachment attachment,
  required SettingsService settings,
}) {
  if (attachment.isImage) {
    return Navigator.of(context).push<AttachmentPreviewResult>(
      MaterialPageRoute(
        builder: (_) => AttachmentImagePreviewScreen(
          attachment: attachment,
          settings: settings,
        ),
      ),
    );
  }

  return showModalBottomSheet<AttachmentPreviewResult>(
    context: context,
    backgroundColor: AppColors.panel,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
    ),
    builder: (sheetCtx) => _FileAttachmentPreviewSheet(
      attachment: attachment,
      settings: settings,
    ),
  );
}

class _FileAttachmentPreviewSheet extends StatefulWidget {
  const _FileAttachmentPreviewSheet({
    required this.attachment,
    required this.settings,
  });

  final UploadedAttachment attachment;
  final SettingsService settings;

  @override
  State<_FileAttachmentPreviewSheet> createState() =>
      _FileAttachmentPreviewSheetState();
}

class _FileAttachmentPreviewSheetState
    extends State<_FileAttachmentPreviewSheet> {
  bool _opening = false;

  Future<void> _openFile() async {
    if (_opening) return;
    setState(() => _opening = true);
    final messenger = ScaffoldMessenger.maybeOf(context);
    var opened = false;
    try {
      final path = widget.attachment.path;
      if (widget.settings.isMachineScoped) {
        final uri = widget.settings.machineFileUrl(path);
        opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
      } else {
        final request = buildMulticcDownloadRequest(
          host: widget.settings.host,
          path: path,
          accessToken: widget.settings.token,
        );
        final uri = await DownloadTicketClient().authorize(
          request: request,
          ticketEndpoint: Uri.parse(
            widget.settings.buildHttpUrl('/api/auth/download-ticket'),
          ),
        );
        opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
      }
    } catch (_) {
      opened = false;
    }
    if (mounted) {
      setState(() => _opening = false);
      if (!opened) {
        messenger?.showSnackBar(
          SnackBar(
            content: Text('${t('attachOpenFile')} · ${widget.attachment.name}'),
            backgroundColor: AppColors.danger,
          ),
        );
      }
    }
  }

  Future<void> _copyServerPath() async {
    await Clipboard.setData(ClipboardData(text: widget.attachment.path));
    if (!mounted) return;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      SnackBar(
        content: Text(t('msgCopied')),
        duration: const Duration(milliseconds: 1400),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final att = widget.attachment;
    final ext = _fileExtension(att.name).toUpperCase();
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 16, 20, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Container(
                  width: 42,
                  height: 42,
                  decoration: BoxDecoration(
                    color: AppColors.blueSoft,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Icon(
                    _attachmentFileIcon(att),
                    size: 24,
                    color: _attachmentFileIconColor(att),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        att.name,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: AppColors.text,
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      if (ext.isNotEmpty || (att.mimeType?.isNotEmpty ?? false))
                        Padding(
                          padding: const EdgeInsets.only(top: 2),
                          child: Text(
                            [
                              if (ext.isNotEmpty) ext,
                              if (att.mimeType?.isNotEmpty ?? false)
                                att.mimeType!,
                            ].join(' · '),
                            style: const TextStyle(
                              color: AppColors.muted,
                              fontSize: 11.5,
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 14),
            Text(
              t('attachServerPath'),
              style: const TextStyle(
                color: AppColors.muted,
                fontSize: 11.5,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 6),
            Container(
              padding: const EdgeInsets.fromLTRB(10, 8, 6, 8),
              decoration: BoxDecoration(
                color: AppColors.well,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: AppColors.line),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: SelectableText(
                      att.path,
                      style: const TextStyle(
                        color: AppColors.text,
                        fontSize: 12,
                        fontFamily: 'monospace',
                      ),
                    ),
                  ),
                  IconButton(
                    key: const ValueKey('attach-file-copy-path'),
                    onPressed: _copyServerPath,
                    icon: const Icon(Icons.copy_rounded, size: 17),
                    color: AppColors.muted,
                    tooltip: t('copy'),
                    visualDensity: VisualDensity.compact,
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            Row(
              children: [
                OutlinedButton.icon(
                  key: const ValueKey('attach-file-delete'),
                  onPressed: () => Navigator.of(
                    context,
                  ).pop(const AttachmentPreviewResult.deleted()),
                  icon: const Icon(Icons.delete_outline, size: 18),
                  label: Text(t('attachDelete')),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: AppColors.danger,
                    side: const BorderSide(color: AppColors.danger),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: FilledButton.icon(
                    key: const ValueKey('attach-file-open'),
                    onPressed: _opening ? null : _openFile,
                    icon: _opening
                        ? const SizedBox(
                            width: 15,
                            height: 15,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: Colors.white,
                            ),
                          )
                        : const Icon(Icons.open_in_new_rounded, size: 18),
                    label: Text(t('attachOpenFile')),
                    style: FilledButton.styleFrom(
                      backgroundColor: AppColors.accentDark,
                      foregroundColor: Colors.white,
                    ),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
