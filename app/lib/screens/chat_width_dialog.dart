import 'package:flutter/material.dart';

import '../i18n.dart';
import '../services/settings_service.dart';

/// 「聊天宽度」弹窗 —— 对齐 Web 的 `chat-layout.js`：一个「限制最大宽度」开关
/// 加一条 640–2400 的滑杆。跟那边一样是**边改边生效**：拖滑杆时聊天区立刻重排，
/// 点「保存」才落盘，点「取消」（或点背景关掉）回到打开前的样子。
///
/// 「恢复默认」只把草稿拨回默认值，不落盘 —— 它跟滑杆、开关是一类动作，都要
/// 再点一次「保存」才算数。
///
/// 从 chat_screen.dart 拆出来的独立文件：聊天页本身已经贴着源码行数上限，而这个
/// 弹窗跟会话状态零耦合，只看设置。
Future<void> showChatWidthDialog(
  BuildContext context,
  SettingsService settings,
) async {
  final original = settings.chatWidth.value;
  const step = 40;
  final saved = await showDialog<bool>(
    context: context,
    builder: (dialogContext) => StatefulBuilder(
      builder: (dialogContext, setLocal) {
        final draft = settings.chatWidth.value;
        void preview(ChatWidthSetting next) {
          settings.chatWidth.value = next;
          setLocal(() {});
        }

        return AlertDialog(
          backgroundColor: const Color(0xFFffffff),
          title: Text(
            t('chatWidthTitle'),
            style: const TextStyle(fontSize: 15, color: Color(0xFF20364d)),
          ),
          content: SizedBox(
            width: 340,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  t('chatWidthBody'),
                  style: const TextStyle(
                    color: Color(0xFF5f7286),
                    fontSize: 12.5,
                    height: 1.6,
                  ),
                ),
                const SizedBox(height: 8),
                InkWell(
                  onTap: () => preview(draft.copyWith(limited: !draft.limited)),
                  child: Row(
                    children: [
                      Checkbox(
                        key: const Key('chat-width-limit'),
                        value: draft.limited,
                        visualDensity: VisualDensity.compact,
                        onChanged: (value) =>
                            preview(draft.copyWith(limited: value ?? false)),
                      ),
                      Expanded(
                        child: Text(
                          t('chatWidthLimit'),
                          style: const TextStyle(
                            color: Color(0xFF233249),
                            fontSize: 13,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                Row(
                  children: [
                    Expanded(
                      child: Slider(
                        key: const Key('chat-width-slider'),
                        value: draft.max
                            .clamp(
                              SettingsService.chatWidthMin,
                              SettingsService.chatWidthMaxLimit,
                            )
                            .toDouble(),
                        min: SettingsService.chatWidthMin.toDouble(),
                        max: SettingsService.chatWidthMaxLimit.toDouble(),
                        divisions:
                            (SettingsService.chatWidthMaxLimit -
                                SettingsService.chatWidthMin) ~/
                            step,
                        label: '${draft.max} px',
                        // 关掉限制时滑杆是灰的：那个数这时不生效，让它可拖反而是
                        // 在骗人。Web 也是这么干的（range.disabled = !limited）。
                        onChanged: draft.limited
                            ? (value) => preview(
                                draft.copyWith(
                                  max: (value / step).round() * step,
                                ),
                              )
                            : null,
                      ),
                    ),
                    SizedBox(
                      width: 62,
                      child: Text(
                        '${draft.max} px',
                        key: const Key('chat-width-value'),
                        textAlign: TextAlign.right,
                        style: const TextStyle(
                          color: Color(0xFF6f8096),
                          fontSize: 12,
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              key: const Key('chat-width-reset'),
              onPressed: () => preview(ChatWidthSetting.defaults),
              child: Text(
                t('chatWidthReset'),
                style: const TextStyle(color: Color(0xFF6f8096)),
              ),
            ),
            TextButton(
              key: const Key('chat-width-cancel'),
              onPressed: () => Navigator.pop(dialogContext, false),
              child: Text(
                t('cancel'),
                style: const TextStyle(color: Color(0xFF6f8096)),
              ),
            ),
            TextButton(
              key: const Key('chat-width-save'),
              onPressed: () => Navigator.pop(dialogContext, true),
              child: Text(
                t('save'),
                style: const TextStyle(
                  color: Color(0xFF1267b5),
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        );
      },
    ),
  );
  if (saved != true) {
    // 取消（含点背景/返回键关掉）：把预览回滚成打开前的值，不落盘。
    settings.chatWidth.value = original;
    return;
  }
  await settings.saveChatWidth();
  if (!context.mounted) return;
  final current = settings.chatWidth.value;
  ScaffoldMessenger.of(context).showSnackBar(
    SnackBar(
      content: Text(
        current.limited
            ? t('chatWidthSavedLimited', {'n': '${current.max}'})
            : t('chatWidthSavedFull'),
      ),
    ),
  );
}
