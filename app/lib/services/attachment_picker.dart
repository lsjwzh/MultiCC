import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show MethodChannel;
import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart';
import 'package:image_picker/image_picker.dart';

import '../i18n.dart';
import '../theme.dart';
import 'settings_service.dart';

/// An attachment held in memory or in a local file for the multipart flow.
class PickedAttachment {
  final Uint8List? bytes;
  final String? path;
  final String filename;
  final bool temporary;

  /// e.g. 'image/jpeg' from the photo picker; files keep octet-stream.
  final String? mimeType;

  const PickedAttachment({
    this.bytes,
    this.path,
    required this.filename,
    this.mimeType,
    this.temporary = false,
  }) : assert(bytes != null || path != null);
}

/// Pick one chat attachment (file, photo, or video).
///
/// iOS 上 file_picker 的文档选择器（Files app）够不到系统相册，所以先弹
/// 「选择文件 / 从相册选择」二选一：相册走 PHPicker（image_picker，iOS 14+
/// 免相册权限），文件走原路径。Android 的系统选择器本来就列出相册，保持
/// 单一文档选择路径不变。
Future<PickedAttachment?> pickChatAttachment(BuildContext context) async {
  if (Platform.isIOS) {
    final source = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: AppColors.panel,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
      ),
      builder: (_) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const SizedBox(height: 14),
            Text(
              t('attachSourceTitle'),
              textAlign: TextAlign.center,
              style: const TextStyle(
                color: Color(0xFF6f8096),
                fontSize: 12,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 4),
            _AttachmentSourceTile(
              icon: Icons.folder_outlined,
              label: t('attachFromFile'),
              value: 'files',
            ),
            _AttachmentSourceTile(
              icon: Icons.photo_library_outlined,
              label: t('attachFromPhotos'),
              value: 'photos',
            ),
            const SizedBox(height: 10),
          ],
        ),
      ),
    );
    if (source == 'photos') return _pickFromPhotos();
    if (source == null) return null;
  }
  return _pickFromFiles();
}

Future<PickedAttachment?> _pickFromFiles() async {
  final result = await FilePicker.platform.pickFiles(withData: false);
  if (result == null || result.files.isEmpty) return null;
  final file = result.files.first;
  if (file.path == null && file.bytes == null) return null;
  return PickedAttachment(
    bytes: file.bytes,
    path: file.path,
    filename: file.name,
  );
}

Future<PickedAttachment?> _pickFromPhotos() async {
  final media = await ImagePicker().pickMedia();
  if (media == null) return null;
  // PHPicker 不保证提供原始文件名；保留临时文件的扩展名以识别图片和视频。
  final name = media.name;
  final dot = name.lastIndexOf('.');
  final isVideo = media.mimeType?.startsWith('video/') ?? false;
  final fallbackExt = isVideo ? '.mov' : '.jpg';
  var ext = dot > 0 ? name.substring(dot).toLowerCase() : fallbackExt;
  if (ext.length > 6) ext = fallbackExt;
  final now = DateTime.now();
  String two(int v) => v.toString().padLeft(2, '0');
  final filename =
      '${isVideo ? 'VID' : 'IMG'}_${now.year}${two(now.month)}${two(now.day)}_${two(now.hour)}${two(now.minute)}${two(now.second)}$ext';
  return PickedAttachment(
    path: media.path,
    filename: filename,
    mimeType: media.mimeType,
  );
}

const _uploadLimit = 25 * 1024 * 1024;
const _videoCompression = MethodChannel(
  'com.multicc.multicc_app/video_compression',
);

/// Compress an oversized iOS video without changing the original file.
@visibleForTesting
Future<PickedAttachment> prepareChatAttachment(
  PickedAttachment picked, {
  bool? isIOS,
  MethodChannel channel = _videoCompression,
}) async {
  final path = picked.path;
  if (!(isIOS ?? Platform.isIOS) || path == null) return picked;
  final extension = picked.filename.split('.').last.toLowerCase();
  final isVideo =
      (picked.mimeType?.startsWith('video/') ?? false) ||
      {'mov', 'mp4', 'm4v', 'avi', 'mpeg', 'mpg', '3gp'}.contains(extension);
  if (!isVideo || await File(path).length() < _uploadLimit) return picked;

  String? compressedPath;
  try {
    compressedPath = await channel.invokeMethod<String>('compress', {
      'path': path,
      'maxBytes': _uploadLimit - 1,
    });
    if (compressedPath == null || compressedPath == path) {
      throw StateError('Invalid compressed file');
    }
    final compressed = File(compressedPath);
    if (await compressed.length() >= _uploadLimit) {
      await compressed.delete();
      throw StateError('Compressed file exceeds limit');
    }
    final dot = picked.filename.lastIndexOf('.');
    final stem = dot > 0 ? picked.filename.substring(0, dot) : picked.filename;
    final outputExt = compressedPath.split('.').last.toLowerCase();
    return PickedAttachment(
      path: compressedPath,
      filename: '$stem.$outputExt',
      mimeType: outputExt == 'mp4' ? 'video/mp4' : 'video/quicktime',
      temporary: true,
    );
  } catch (_) {
    if (compressedPath != null && compressedPath != path) {
      final file = File(compressedPath);
      if (await file.exists()) await file.delete();
    }
    throw Exception(t('attachVideoCompressionFailed'));
  }
}

const _imageAttachmentExts = {
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'heic',
  'heif',
};

/// Whether [pathOrName] (or optional [mimeType]) refers to an image attachment
/// that can be previewed inline or edited in the image crop/annotate editor.
bool isImageAttachmentPath(String pathOrName, {String? mimeType}) {
  final mime = mimeType?.trim().toLowerCase() ?? '';
  if (mime.startsWith('image/')) return true;
  final clean = pathOrName.split('?').first.split('#').first.trim();
  final dot = clean.lastIndexOf('.');
  if (dot < 0 || dot == clean.length - 1) return false;
  final ext = clean.substring(dot + 1).toLowerCase();
  return _imageAttachmentExts.contains(ext);
}

/// One uploaded attachment: the server-side path plus the name to show on its chip.
///
/// Preserves optional local bytes / non-temporary local file path / mimeType so
/// the composer can immediately render thumbnails, open confirmation previews,
/// and launch crop/edit/annotate without a redundant round-trip download.
class UploadedAttachment {
  const UploadedAttachment({
    required this.path,
    required this.name,
    this.localBytes,
    this.localPath,
    this.mimeType,
  });

  final String path;
  final String name;
  final Uint8List? localBytes;
  final String? localPath;
  final String? mimeType;

  bool get isImage =>
      isImageAttachmentPath(name, mimeType: mimeType) ||
      isImageAttachmentPath(path, mimeType: mimeType);

  UploadedAttachment copyWith({
    String? path,
    String? name,
    Uint8List? localBytes,
    String? localPath,
    String? mimeType,
    bool clearLocalBytes = false,
    bool clearLocalPath = false,
  }) => UploadedAttachment(
    path: path ?? this.path,
    name: name ?? this.name,
    localBytes: clearLocalBytes ? null : (localBytes ?? this.localBytes),
    localPath: clearLocalPath ? null : (localPath ?? this.localPath),
    mimeType: mimeType ?? this.mimeType,
  );
}

/// 上传一个附件到 `/api/upload`，换回它的服务端路径。
///
/// 聊天输入区和 Air 的快速新建都走这一条 —— Web 那边两个 composer 用的也是
/// 同一个 `/api/upload`，返回的 `path` 会被拼进正文（`\n\n附件：…`），不是
/// 单独挂一个附件列表。
Future<UploadedAttachment> uploadChatAttachment({
  required SettingsService settings,
  required PickedAttachment picked,
  http.Client? httpClient,
}) async {
  final prepared = await prepareChatAttachment(picked);
  try {
    final uri = Uri.parse(settings.buildHttpUrl('/api/upload'));
    final request = http.MultipartRequest('POST', uri);
    if (settings.token.isNotEmpty) {
      request.headers['X-Access-Token'] = settings.token;
    }
    request.files.add(
      prepared.path != null
          ? await http.MultipartFile.fromPath(
              'file',
              prepared.path!,
              filename: prepared.filename,
              contentType: prepared.mimeType != null
                  ? MediaType.parse(prepared.mimeType!)
                  : MediaType('application', 'octet-stream'),
            )
          : http.MultipartFile.fromBytes(
              'file',
              prepared.bytes!,
              filename: prepared.filename,
              contentType: prepared.mimeType != null
                  ? MediaType.parse(prepared.mimeType!)
                  : MediaType('application', 'octet-stream'),
            ),
    );
    final res = await _sendMultipart(request, httpClient);
    final body = await res.stream.bytesToString();
    if (res.statusCode != 200) {
      throw Exception('HTTP ${res.statusCode}');
    }
    final json = jsonDecode(body) as Map<String, dynamic>;
    final path = json['path'] as String?;
    if (path == null || path.isEmpty) {
      throw Exception('${json['error'] ?? '上传失败'}');
    }
    return UploadedAttachment(
      path: path,
      name: json['name'] as String? ?? prepared.filename,
      localBytes: prepared.bytes,
      localPath: prepared.temporary ? null : prepared.path,
      mimeType: prepared.mimeType,
    );
  } finally {
    if (prepared.temporary && prepared.path != null) {
      final file = File(prepared.path!);
      if (await file.exists()) await file.delete();
    }
  }
}

/// 走调用方给的 client（测试拿 MockClient 就能整条桩掉）；没给就自己开一个，
/// 用完关掉。`MultipartRequest.send()` 自带的那个 client 是从外面塞不进去的。
Future<http.StreamedResponse> _sendMultipart(
  http.MultipartRequest request,
  http.Client? httpClient,
) async {
  final client = httpClient ?? http.Client();
  try {
    return await client.send(request).timeout(const Duration(seconds: 30));
  } finally {
    if (httpClient == null) client.close();
  }
}

class _AttachmentSourceTile extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;

  const _AttachmentSourceTile({
    required this.icon,
    required this.label,
    required this.value,
  });

  @override
  Widget build(BuildContext context) {
    return ListTile(
      onTap: () => Navigator.of(context).pop(value),
      contentPadding: const EdgeInsets.symmetric(horizontal: 24),
      leading: Icon(icon, color: const Color(0xFF6f8096), size: 22),
      title: Text(
        label,
        style: const TextStyle(
          color: AppColors.text,
          fontSize: 15,
          fontWeight: FontWeight.w500,
        ),
      ),
      dense: true,
    );
  }
}
