import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/services/attachment_picker.dart';
import 'package:multicc_app/widgets/attachment_image_editor_screen.dart';
import 'package:multicc_app/widgets/attachment_preview.dart';

const _pngSignature = <int>[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

Future<ui.Image> _makeTestImage(int width, int height) async {
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(
    recorder,
    Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()),
  );
  canvas.drawRect(
    Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()),
    Paint()..color = const Color(0xFF1E88E5),
  );
  canvas.drawRect(
    Rect.fromLTWH(0, 0, width / 2, height / 2),
    Paint()..color = const Color(0xFFE53935),
  );
  canvas.drawCircle(
    Offset(width * 0.75, height * 0.75),
    width * 0.15,
    Paint()..color = const Color(0xFF43A047),
  );
  final picture = recorder.endRecording();
  try {
    return await picture.toImage(width, height);
  } finally {
    picture.dispose();
  }
}

Future<Uint8List> _makeTestPngBytes(int width, int height) async {
  final img = await _makeTestImage(width, height);
  try {
    return await encodeUiImagePng(img);
  } finally {
    img.dispose();
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() => I18n.init('zh'));

  group('Pure helpers', () {
    test('clampCropRect keeps rect inside image bounds and minSize', () {
      const img = Size(200, 120);

      // Out-of-bounds shift
      final shifted = clampCropRect(
        const Rect.fromLTWH(-30, -10, 80, 60),
        img,
      );
      expect(shifted, const Rect.fromLTWH(0, 0, 80, 60));

      // Oversized rect clamps to full image
      final oversized = clampCropRect(
        const Rect.fromLTWH(-10, -20, 400, 300),
        img,
      );
      expect(oversized, const Rect.fromLTWH(0, 0, 200, 120));

      // Tiny rect enforces minSize and stays inside bottom-right corner
      final tiny = clampCropRect(
        const Rect.fromLTWH(195, 115, 4, 5),
        img,
        minSize: 24,
      );
      expect(tiny.width, 24);
      expect(tiny.height, 24);
      expect(tiny.right, lessThanOrEqualTo(200));
      expect(tiny.bottom, lessThanOrEqualTo(120));
      expect(tiny.left, greaterThanOrEqualTo(0));
      expect(tiny.top, greaterThanOrEqualTo(0));

      // Inverted coordinates normalize cleanly
      final inverted = clampCropRect(
        const Rect.fromLTRB(120, 90, 40, 30),
        img,
      );
      expect(inverted, const Rect.fromLTRB(40, 30, 120, 90));
    });

    test('clampCropRect honors 1:1, 4:3, and 16:9 aspect ratios', () {
      const img = Size(200, 120);
      const base = Rect.fromLTWH(10, 10, 160, 100);

      for (final ratio in [1.0, 4 / 3, 16 / 9]) {
        final r = clampCropRect(base, img, aspectRatio: ratio);
        expect(r.left, greaterThanOrEqualTo(0));
        expect(r.top, greaterThanOrEqualTo(0));
        expect(r.right, lessThanOrEqualTo(img.width + 1e-6));
        expect(r.bottom, lessThanOrEqualTo(img.height + 1e-6));
        expect(r.width / r.height, closeTo(ratio, 1e-4));
      }
    });

    test('editedAttachmentFilename produces stable *_edited.png names', () {
      expect(editedAttachmentFilename('IMG_001.jpg'), 'IMG_001_edited.png');
      expect(editedAttachmentFilename('photo.PNG'), 'photo_edited.png');
      expect(editedAttachmentFilename('photo_edited.png'), 'photo_edited.png');
      expect(editedAttachmentFilename('screenshot'), 'screenshot_edited.png');
      expect(
        editedAttachmentFilename('/tmp/uploads/pic.webp'),
        'pic_edited.png',
      );
      expect(editedAttachmentFilename(''), 'image_edited.png');
    });

    test('isImageAttachmentPath detects extensions and mime types', () {
      expect(isImageAttachmentPath('a.png'), isTrue);
      expect(isImageAttachmentPath('photo.JPEG'), isTrue);
      expect(isImageAttachmentPath('/tmp/pic.webp?inline=1'), isTrue);
      expect(isImageAttachmentPath('IMG_1.heic'), isTrue);
      expect(isImageAttachmentPath('blob', mimeType: 'image/png'), isTrue);
      expect(isImageAttachmentPath('report.pdf'), isFalse);
      expect(isImageAttachmentPath('clip.mp4', mimeType: 'video/mp4'), isFalse);
      expect(isImageAttachmentPath('archive.zip'), isFalse);
    });
  });

  group('dart:ui rendering', () {
    test('renderEditedUiImage crops accurately', () async {
      final src = await _makeTestImage(120, 80);
      addTearDown(src.dispose);

      final cropped = await renderEditedUiImage(
        src,
        cropRect: const Rect.fromLTWH(20, 10, 60, 40),
      );
      addTearDown(cropped.dispose);

      expect(cropped.width, 60);
      expect(cropped.height, 40);
    });

    test('renderEditedUiImage rotates 90 degrees clockwise swapping dimensions',
        () async {
      final src = await _makeTestImage(120, 80);
      addTearDown(src.dispose);

      final rotated = await renderEditedUiImage(src, quarterTurns: 1);
      addTearDown(rotated.dispose);

      expect(rotated.width, 80);
      expect(rotated.height, 120);
    });

    test('renderEditedUiImage paints all mark types and encodes valid PNG',
        () async {
      final src = await _makeTestImage(120, 80);
      addTearDown(src.dispose);

      final marks = <EditorStrokeMark>[
        const EditorStrokeMark(
          tool: ImageEditorTool.pen,
          color: Color(0xFFFF3B30),
          strokeWidth: 4,
          points: [Offset(10, 10), Offset(30, 20), Offset(50, 15)],
        ),
        const EditorStrokeMark(
          tool: ImageEditorTool.box,
          color: Color(0xFFFFCC00),
          strokeWidth: 3,
          points: [Offset(15, 25), Offset(55, 65)],
        ),
        const EditorStrokeMark(
          tool: ImageEditorTool.arrow,
          color: Color(0xFF34C759),
          strokeWidth: 3,
          points: [Offset(60, 20), Offset(105, 55)],
        ),
        const EditorStrokeMark(
          tool: ImageEditorTool.text,
          color: Colors.white,
          strokeWidth: 4,
          points: [Offset(60, 40)],
          text: '重点标注',
        ),
        const EditorStrokeMark(
          tool: ImageEditorTool.mosaic,
          color: Colors.black,
          strokeWidth: 4,
          points: [Offset(70, 50), Offset(110, 75)],
        ),
      ];

      final rendered = await renderEditedUiImage(src, marks: marks);
      addTearDown(rendered.dispose);

      final png = await encodeUiImagePng(rendered);
      expect(png.length, greaterThan(64));
      expect(png.sublist(0, 8), _pngSignature);
    });
  });

  group('Widget tests', () {
    testWidgets(
      'AttachmentImageEditorScreen renders tools, rotates, crops, and exports PNG',
      (tester) async {
        final pngBytes = await tester.runAsync(() => _makeTestPngBytes(120, 80));
        expect(pngBytes, isNotNull);

        EditedAttachmentImage? exported;
        await tester.pumpWidget(
          MaterialApp(
            home: Builder(
              builder: (context) => Scaffold(
                body: Center(
                  child: ElevatedButton(
                    onPressed: () async {
                      exported = await Navigator.of(context)
                          .push<EditedAttachmentImage>(
                            MaterialPageRoute(
                              builder: (_) => AttachmentImageEditorScreen(
                                initialBytes: pngBytes,
                                filename: 'IMG_test.jpg',
                              ),
                            ),
                          );
                    },
                    child: const Text('open-editor'),
                  ),
                ),
              ),
            ),
          ),
        );

        await tester.tap(find.text('open-editor'));
        await tester.pump();
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 80)),
        );
        await tester.pumpAndSettle();

        // All main tools and header controls are present.
        expect(find.byKey(const ValueKey('attach-editor-tool-crop')), findsOneWidget);
        expect(find.byKey(const ValueKey('attach-editor-tool-rotate')), findsOneWidget);
        expect(find.byKey(const ValueKey('attach-editor-tool-pen')), findsOneWidget);
        expect(find.byKey(const ValueKey('attach-editor-tool-box')), findsOneWidget);
        expect(find.byKey(const ValueKey('attach-editor-tool-arrow')), findsOneWidget);
        expect(find.byKey(const ValueKey('attach-editor-tool-text')), findsOneWidget);
        expect(find.byKey(const ValueKey('attach-editor-tool-mosaic')), findsOneWidget);
        expect(find.byKey(const ValueKey('attach-editor-tool-pan')), findsOneWidget);
        expect(find.byKey(const ValueKey('attach-editor-undo')), findsOneWidget);
        expect(find.byKey(const ValueKey('attach-editor-done')), findsOneWidget);

        // Rotate 90° clockwise.
        await tester.tap(find.byKey(const ValueKey('attach-editor-tool-rotate')));
        await tester.pump();
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 80)),
        );
        await tester.pumpAndSettle();

        // Switch to crop tool and verify ratio presets + apply/cancel buttons.
        await tester.tap(find.byKey(const ValueKey('attach-editor-tool-crop')));
        await tester.pumpAndSettle();
        expect(find.text('1:1'), findsOneWidget);
        expect(find.text('4:3'), findsOneWidget);
        expect(find.text('16:9'), findsOneWidget);
        expect(
          find.byKey(const ValueKey('attach-editor-apply-crop')),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('attach-editor-cancel-crop')),
          findsOneWidget,
        );

        // Pick 1:1 ratio and finish directly (auto-applies crop).
        await tester.tap(find.text('1:1'));
        await tester.pumpAndSettle();

        await tester.tap(find.byKey(const ValueKey('attach-editor-done')));
        await tester.pump();
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 120)),
        );
        await tester.pumpAndSettle();

        expect(exported, isNotNull);
        expect(exported!.filename, 'IMG_test_edited.png');
        expect(exported!.bytes.sublist(0, 8), _pngSignature);

        // Decoded exported image should be square (80x80 after 90° rotate + 1:1 crop).
        final decoded = await tester.runAsync(() async {
          final codec = await ui.instantiateImageCodec(exported!.bytes);
          final frame = await codec.getNextFrame();
          codec.dispose();
          return frame.image;
        });
        expect(decoded, isNotNull);
        addTearDown(decoded!.dispose);
        expect(decoded.width, decoded.height);
        expect(decoded.width, 80);
      },
    );

    testWidgets(
      'UploadedAttachmentChip fires preview, edit, and remove callbacks',
      (tester) async {
        final pngBytes = await tester.runAsync(() => _makeTestPngBytes(40, 40));
        var tapped = 0;
        var edited = 0;
        var removed = 0;

        final imgAtt = UploadedAttachment(
          path: '/tmp/uploads/photo.png',
          name: 'photo.png',
          localBytes: pngBytes,
          mimeType: 'image/png',
        );
        const docAtt = UploadedAttachment(
          path: '/tmp/uploads/spec.pdf',
          name: 'spec.pdf',
          mimeType: 'application/pdf',
        );

        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: Column(
                children: [
                  UploadedAttachmentChip(
                    attachment: imgAtt,
                    onTap: () => tapped++,
                    onEdit: () => edited++,
                    onRemove: () => removed++,
                  ),
                  UploadedAttachmentChip(
                    attachment: docAtt,
                    onTap: () => tapped++,
                    onRemove: () => removed++,
                  ),
                ],
              ),
            ),
          ),
        );
        await tester.pump();

        expect(find.byType(Image), findsOneWidget);
        expect(find.text('photo.png'), findsOneWidget);
        expect(find.text('spec.pdf'), findsOneWidget);
        expect(
          find.byKey(const ValueKey('attach-chip-edit-photo.png')),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('attach-chip-edit-spec.pdf')),
          findsNothing,
        );

        await tester.tap(find.byKey(const ValueKey('attach-chip-body-photo.png')));
        await tester.tap(find.byKey(const ValueKey('attach-chip-edit-photo.png')));
        await tester.tap(
          find.byKey(const ValueKey('attach-chip-remove-photo.png')),
        );
        await tester.pump();

        expect(tapped, 1);
        expect(edited, 1);
        expect(removed, 1);
      },
    );

    testWidgets(
      'AttachmentImagePreviewScreen returns deleted when remove button tapped',
      (tester) async {
        final pngBytes = await tester.runAsync(() => _makeTestPngBytes(60, 40));
        final imgAtt = UploadedAttachment(
          path: '/tmp/uploads/preview.png',
          name: 'preview.png',
          localBytes: pngBytes,
          mimeType: 'image/png',
        );

        AttachmentPreviewResult? result;
        await tester.pumpWidget(
          MaterialApp(
            home: Builder(
              builder: (context) => Scaffold(
                body: Center(
                  child: ElevatedButton(
                    onPressed: () async {
                      result = await Navigator.of(context)
                          .push<AttachmentPreviewResult>(
                            MaterialPageRoute(
                              builder: (_) => AttachmentImagePreviewScreen(
                                attachment: imgAtt,
                              ),
                            ),
                          );
                    },
                    child: const Text('open-preview'),
                  ),
                ),
              ),
            ),
          ),
        );

        await tester.tap(find.text('open-preview'));
        await tester.pumpAndSettle();

        expect(find.byKey(const ValueKey('attach-preview-edit')), findsOneWidget);
        expect(
          find.byKey(const ValueKey('attach-preview-delete')),
          findsOneWidget,
        );

        await tester.tap(find.byKey(const ValueKey('attach-preview-delete')));
        await tester.pumpAndSettle();

        expect(result, isNotNull);
        expect(result!.deleted, isTrue);
        expect(result!.editedImage, isNull);
      },
    );
  });
}
