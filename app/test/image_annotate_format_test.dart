import 'package:flutter_test/flutter_test.dart';
import 'package:multicc_app/utils/annotation_format.dart';

void main() {
  test('point / reversed box / arrow serialize with 3-decimal coords', () {
    final text = serializeAnnotation(
      src: '/tmp/shot.png',
      width: 1000,
      height: 500,
      marks: [
        AnnotationMark(kind: AnnotationKind.point, ax: 412, ay: 250),
        // Dragged bottom-right → top-left: normalized to x1<=x2, y1<=y2.
        AnnotationMark(
          kind: AnnotationKind.box,
          ax: 800,
          ay: 400,
          bx: 100,
          by: 50,
          note: 'login',
        ),
        // Arrow keeps its direction.
        AnnotationMark(
          kind: AnnotationKind.arrow,
          ax: 900,
          ay: 450,
          bx: 100,
          by: 50,
        ),
      ],
    );
    expect(
      text,
      '[annotation] src=/tmp/shot.png size=1000x500\n'
      '#1 point 0.412,0.500\n'
      '#2 box 0.100,0.100-0.800,0.800 — login\n'
      '#3 arrow 0.900,0.900->0.100,0.100\n'
      '[/annotation]',
    );
  });

  test('notes are trimmed and newline runs collapse; overall note line', () {
    final text = serializeAnnotation(
      src: '/a/b.png',
      width: 10,
      height: 10,
      marks: [
        AnnotationMark(
          kind: AnnotationKind.point,
          ax: 5,
          ay: 5,
          note: '  click here \n\n  then wait\r\nok  ',
        ),
        AnnotationMark(kind: AnnotationKind.point, ax: 1, ay: 1, note: '  \n '),
      ],
      note: '\n overall\n\nthing \n',
    );
    expect(
      text,
      '[annotation] src=/a/b.png size=10x10\n'
      '#1 point 0.500,0.500 — click here then wait ok\n'
      '#2 point 0.100,0.100\n'
      'note: overall thing\n'
      '[/annotation]',
    );
  });

  test('coords clamp to [0,1]; empty src becomes "-"', () {
    final text = serializeAnnotation(
      src: '',
      width: 200,
      height: 100,
      marks: [
        AnnotationMark(kind: AnnotationKind.point, ax: -20, ay: 150),
        AnnotationMark(
          kind: AnnotationKind.box,
          ax: 250,
          ay: -5,
          bx: 100,
          by: 99.96,
        ),
      ],
    );
    expect(
      text,
      '[annotation] src=- size=200x100\n'
      '#1 point 0.000,1.000\n'
      '#2 box 0.500,0.000-1.000,1.000\n'
      '[/annotation]',
    );
  });

  test('no marks and blank note → header + footer only', () {
    expect(
      serializeAnnotation(src: '/x.png', width: 3, height: 4, marks: const []),
      '[annotation] src=/x.png size=3x4\n[/annotation]',
    );
  });

  test('refresh text', () {
    expect(
      annotationRefreshText('/tmp/a.png'),
      '[annotation-refresh] src=/tmp/a.png\n截图已过期或页面已变化，请重新截图后再问我。',
    );
    expect(
      annotationRefreshText(''),
      '[annotation-refresh] src=-\n截图已过期或页面已变化，请重新截图后再问我。',
    );
  });

  test('source path, export filename, secret line', () {
    expect(
      annotationSourcePathFromUrl(
        'http://h:3000/api/download?path=%2Ftmp%2Fmy%20shot.png&inline=1',
      ),
      '/tmp/my shot.png',
    );
    expect(annotationSourcePathFromUrl('https://example.com/a.png'), '');
    expect(
      annotationExportFileName('/tmp/my.shot.png', 42),
      'annotated-my.shot-42.png',
    );
    expect(annotationExportFileName('', 7), 'annotated-image-7.png');
    expect(
      annotationSecretStoredLine('ASSIST_SECRET'),
      '敏感值已存入本地保险箱，环境变量名 ASSIST_SECRET（值不在对话里）',
    );
    expect(annotationSecretNameRe.hasMatch('ASSIST_SECRET'), isTrue);
    expect(annotationSecretNameRe.hasMatch('bad name'), isFalse);
    expect(annotationSecretNameRe.hasMatch('a' * 65), isFalse);
  });
}
