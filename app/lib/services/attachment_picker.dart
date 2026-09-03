import 'dart:io';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../i18n.dart';
import '../theme.dart';

/// One in-memory attachment ready for the /api/upload multipart flow.
class PickedAttachment {
  final Uint8List bytes;
  final String filename;

  /// e.g. 'image/jpeg' from the photo picker; files keep octet-stream.
  final String? mimeType;

  const PickedAttachment({
    required this.bytes,
    required this.filename,
    this.mimeType,
  });
}

/// Pick one chat attachment (file or photo).
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
                color: Color(0xFF8a909b),
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
  final result = await FilePicker.platform.pickFiles(withData: true);
  if (result == null || result.files.isEmpty) return null;
  final file = result.files.first;
  if (file.bytes == null) return null;
  return PickedAttachment(bytes: file.bytes!, filename: file.name);
}

Future<PickedAttachment?> _pickFromPhotos() async {
  final photo = await ImagePicker().pickImage(source: ImageSource.gallery);
  if (photo == null) return null;
  final bytes = await photo.readAsBytes();
  // PHPicker 以隐私为由不给原图文件名（IMG_1234.HEIC），按 iOS 惯例用时间戳
  // 生成一个；image_picker 在 iOS 会把 HEIC 转成 JPEG，扩展名取自临时文件。
  final name = photo.name;
  final dot = name.lastIndexOf('.');
  var ext = dot > 0 ? name.substring(dot).toLowerCase() : '.jpg';
  if (ext.length > 6) ext = '.jpg';
  final now = DateTime.now();
  String two(int v) => v.toString().padLeft(2, '0');
  final filename =
      'IMG_${now.year}${two(now.month)}${two(now.day)}_${two(now.hour)}${two(now.minute)}${two(now.second)}$ext';
  return PickedAttachment(
    bytes: bytes,
    filename: filename,
    mimeType: photo.mimeType,
  );
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
      leading: Icon(icon, color: const Color(0xFFb6bcc6), size: 22),
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
