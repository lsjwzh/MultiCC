# 批次 A0 — 示范切片：抽离 main_shell.dart 的两个 badge widget

> 目的：用最小、最自包含的切片跑通「设计→测试设计→改代码→验证」四步循环，作为后续所有批次的模板。
> 关联：总纲 `docs/modularization-roadmap.md` §6。

## ① 设计

### 现状
`app/lib/screens/main_shell.dart`（4938 行）末尾定义了两个纯 UI badge 组件：

| 类 | 行号 | 行数 | 引用点（全在 main_shell.dart） | 外部依赖 |
|---|---|---|---|---|
| `_MiniBadge` | 4128–4162 | 34 | 1245, 1247, 3350, 3352（4 处调用） | 仅 Flutter material |
| `_AddSessionChip` | 4164–4197 | 33 | 1683–1697（8 处调用） | 仅 Flutter material |

- 调用点 `_AddSessionChip(color: _kClaudeColor, ...)` 里的 `_kClaudeColor` 等是 main_shell.dart 顶部常量（行 27+），**组件本身不引用**，只是调用方传参 → 搬走不受影响，常量留原处。

### Dart 关键坑
`_` 前缀是**库私有**。搬到新文件后 main_shell.dart 引用不到 → 必须改名去下划线。项目 `widgets/` 现有组件（`MessageBubble`/`ToolCard`/`ThinkingIndicator`/`RainbowBorder`）均为公开命名，去下划线符合约定。

### 改动
1. **新建** `app/lib/widgets/session_badges.dart`：
   ```dart
   import 'package:flutter/material.dart';

   class MiniBadge extends StatelessWidget { /* 原 _MiniBadge 4128-4162 */ }
   class AddSessionChip extends StatelessWidget { /* 原 _AddSessionChip 4164-4197 */ }
   ```
2. **main_shell.dart**：
   - 顶部 import 区加 `import '../widgets/session_badges.dart';`
   - 删除 4128–4197 两个 class 定义（含其间空行）
   - 12 处调用去下划线：`_MiniBadge(` → `MiniBadge(`，`_AddSessionChip(` → `AddSessionChip(`

### 不动
- `_kClaudeColor` / `_kCodexColor` 等常量、`_inputDec` 函数、`_CreateSessionDialog`、`_GitStatusRow` —— 留在 main_shell.dart（后续切片再处理）。

## ② 测试设计（通过判据）
1. `flutter analyze`（app 目录）的 **error 数 = 基线**（0 error），不新增 error。
2. `grep -rn "_MiniBadge\|_AddSessionChip" app/lib/` 返回空 → 无遗漏私有引用。
3. 6 个纯逻辑单测保持 green（JS 单测，本不相关，跑一次防误伤）。
4. （可选）app 能编译启动。

## ③ 代码修改（已执行）
- 新建 `app/lib/widgets/session_badges.dart`（74 行），导出 `MiniBadge` + `AddSessionChip`
- main_shell.dart：加 `import '../widgets/session_badges.dart';`、删除原两个私有 class、12 处调用去下划线
- 规范化：构造函数加 `super.key`（公开 widget 惯例），顺带消除 `use_key_in_widget_constructors` info

## ④ 验证（2026-07-13 通过）
- 私有引用：`grep -rn "_MiniBadge\|_AddSessionChip" app/lib/` → **完全空** ✓
- `flutter analyze`：**error 0**，总 issues **15（= 基线，零新增）**，session_badges.dart 零 issue ✓
- 行数守恒：main_shell.dart **4938 → 4868（-70）**，新文件 74 行 ✓
- 行为不变：纯 UI 组件，构造参数与原一致（仅多一个可选 `key`）✓

**结论：A0 无损拆分成功，四步循环模板（设计→测试设计→改代码→验证）跑通，可作为后续所有批次的标准流程。**
