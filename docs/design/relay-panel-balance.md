# 第三方中转站余额查询

状态：第一期已实现（2026-11-12）；第二、三期未做。决策：access token 明文同 apiKey、自定义模板只做声明式 JSON、第三期暂不做。参考 CC Switch 的「用量查询」，但默认自动识别、不要求用户先选模板。

## 1. 目标与非目标

目标
- 对 baseUrl 指向第三方中转（new-api 系 / sub2api / 通用 `/user/balance`）的 provider，在限流条显示余额，复用现有 `kind:"balance"` DTO 与缓存、推送链路。
- 只用 sk 能查到的就零配置；查不到时允许补 access token（new-api）或写自定义模板。
- 全部新逻辑落 Rust（规则：Node 冻结，只在 Rust 上迭代）。

非目标
- 不读响应头（已实测 new-api 不返回额度头）。
- 不做浏览器登录抓页面（那是定时巡检任务的事）。
- 不支持 claude-relay-service / VoAPI v2（只有管理员或控制台 JWT 接口），走自定义模板兜底。
- 不把令牌限额或速率限制当成账户余额。

## 2. 现状（改动前）

| 环节 | 位置 | 现状 |
|---|---|---|
| strategy 判定 | `src/providers/core.js:833 getProviderLimitTarget`（Node） | 只按域名认 deepseek / glm / kimi，加借道 `relay-quota`；其他返回 null |
| 白名单 | `native/gateway/src/app/provider_balance_adapters.rs:17 supported()` | 6 种 |
| unsupported 出口 | `native/gateway/src/app/provider_balance.rs:262` | 第三方都落在这里 |
| DTO / 条 | `provider_balance_adapters.rs:299-345`、`native/core/src/quota_bar_view.rs:521 balance_bar` | balance 类固定阈值 ≤5 红 ≤20 黄 |
| 缓存 / 推送 | `limit_cache_recorder.rs`、`provider-limit-cache.js`（10 分钟）、`provider_limit_updated` | 可直接复用 |
| Auto 选线 | `native/core/src/auto_provider_policy.rs:387` | balance 类无百分比，当作「未测量」 |
| 借道 | 借入方 `relay-quota` 透传到出借方 | 出借方支持后借入方自动可用，无需额外工作 |

## 3. 三套面板接口

| 模板 id | 适用 | 请求 | 凭据 | 解析 |
|---|---|---|---|---|
| `newapi-token` | one-api / new-api / Veloera / AnyRouter 等 | `GET {origin}/api/usage/token` | sk | `total_available` 等；若带 `user_quota` 则取账户余额（令牌须开「允许查询账户额度」）；`unlimited_quota=true` 时令牌维度视为无限 |
| `newapi-user` | 同上，sk 查不到账户余额时 | `GET {origin}/api/user/self` | access token + `New-Api-User: {userId}` | `data.quota / 500000` 为美元；`used_quota` 同理 |
| `newapi-billing` | 老 one-api 兜底 | `GET /v1/dashboard/billing/subscription` + `/usage` | sk | `hard_limit_usd - total_usage/100`；`hard_limit_usd == 100000000` 视为无限，判为「查不到余额」 |
| `sub2api` | sub2api | `GET {origin}/v1/usage` | sk | `mode=quota_limited` 取 `quota{limit,used,remaining,unit}`；`unrestricted` 时取 `balance` |
| `general` | 通用约定 | `GET {baseUrl}/user/balance` | sk | `balance` / `total_balance` 字段 |
| `custom` | 其余 | 用户声明 | 任选 | 见第 5 节 |

`{origin}` = baseUrl 去掉尾部 `/v1`、`/` 之后的部分。单位归一：new-api 显示类型为 CNY 或 TOKENS 时，`/api/status` 里的 `quota_per_unit` / `display_type` 用于换算，换不了就原样标注单位，不硬转美元。

## 4. 自动识别（`auto`，默认）

1. strategy 判定迁到 Rust：把 `getProviderLimitTarget` 的域名表搬进 Rust（provider_store 旁新增 `provider_balance_target`），Node 只转调。这是前置步骤，符合「只有 Node 实现的先切 Rust 再改」。
2. 已知域名（deepseek / glm / kimi / 借道）保持原策略不变；其余非官方 baseUrl 进入 `auto`。
3. `auto` 依次探测（每步超时 4s，总体不超过 6s 现有上限）：`sub2api` → `newapi-token` → `newapi-user`（仅当配置了 access token）→ `newapi-billing` → `general`。第一个返回可解析结果的模板胜出。
4. 识别结果按 baseUrl origin 缓存 24 小时（存 provider 的 `balanceProbe.detected`），之后直接用该模板；连续 3 次失败清掉缓存重新探测。
5. 全部失败返回 `unsupported`，并带 `tried:[...]` 便于排错（UI 显示「该中转站未开放余额接口，可在 provider 设置里补 access token 或自定义模板」）。

## 5. Provider 配置新增字段

`providers.json` 每条 provider 新增可选对象，不填即 `auto`：

```json
"balanceProbe": {
  "mode": "auto | newapi-token | newapi-user | newapi-billing | sub2api | general | custom | off",
  "accessToken": "…",          // 仅 newapi-user；与 apiKey 同等保管方式
  "userId": "123",
  "custom": {
    "url": "{{origin}}/api/xxx",
    "method": "GET",
    "headers": { "Authorization": "Bearer {{apiKey}}" },
    "map": { "remaining": "/data/balance", "total": "/data/total", "used": "/data/used" },
    "divisor": 1,
    "currency": "USD"
  },
  "detected": { "mode": "newapi-token", "at": 0 }
}
```

自定义模板只用声明式 JSON（JSON Pointer 取值 + 除数 + 币种），不嵌 JS 沙箱：功能覆盖 CC Switch 绝大多数实际脚本，又不用往 Rust 里引 QuickJS。变量：`{{apiKey}} {{baseUrl}} {{origin}} {{accessToken}} {{userId}}`。安全约束：请求必须同 origin 的 HTTPS（`custom` 允许不同 origin，但 UI 明确提示凭据会发给该地址）；只允许 GET/POST；响应体上限 64KB。

## 6. 输出与消费

- 复用 `kind:"balance"` DTO，新增两个可选字段：`scope: "account" | "token"`（余额是账户的还是令牌的）、`source`（命中的模板 id）。缓存摘要随之多存这两项。
- 限流条：沿用 `balance_bar` 的 ≤5 红 / ≤20 黄；`scope=token` 时文案标「令牌余额」。
- Auto 选线：第一阶段不改。第二阶段可选：有 `total` 时折算 `usedPercentage` 参与 preferMaxQuota；`available <= 0` 视为已耗尽、按现有门控让位。
- 借道：出借方实现后，借入方 `relay-quota` 自动透传，不改。

## 7. UI（`public/air-provider.js`）

provider 编辑表单加「余额查询」折叠区：模式下拉（默认自动）、access token、用户 ID、自定义模板 JSON 文本框、「测试」按钮（调 `GET /api/providers/:appType/:id/balance` 并显示命中模板与原始解析值）。App 端只读显示，不加编辑。

## 8. 落点与测试

- Rust：`native/gateway/src/app/provider_balance_panels.rs`（新文件，五个模板 + auto 探测 + custom 映射），`supported()` 加 `panel-auto` 与各模板 id；`native/core` 里 strategy 判定与 DTO 新字段。
- Node：`getProviderLimitTarget` 改为转调 Rust，删除原 JS 域名表（不留双轨）。
- 测试：每个模板一份响应 fixture（含 1e8 无限哨兵、`unlimited_quota`、CNY 显示、401、HTML 错页）；auto 探测顺序与缓存失效用本地 mock HTTP；provider_store 新字段读写往返；route 清单同步。
- 实网验证：EronMind（new-api）用其 sk 测 `/api/usage/token`，确认 `user_quota` 是否返回。

## 9. 分期

1. strategy 判定迁 Rust + `newapi-token` / `newapi-billing` / `sub2api` / `general` + auto 探测 + 限流条显示。
2. `newapi-user`（access token）+ 自定义模板 + 编辑 UI 与测试按钮。
3. （可选）Auto 选线接入余额。

## 10. 待确认

1. access token 与 apiKey 一样明文存在 `providers.json`，还是改存 MultiCC 保险箱只存引用？
2. 自定义模板只做声明式 JSON，不支持 JS 脚本，是否可以接受？
3. 第三阶段（Auto 选线按余额让位）要不要做？

## 11. 第一期实现记录

- 策略判定：`native/core/src/provider_balance_target.rs`（napi `providerBalanceStrategy`），`src/providers/core.js` 的 JS 域名表已删除；第三方公网中转判为 `panel-auto` 并在 target 上带 `baseUrl`；loopback/内网与官方厂商域名不探测。
- 探测：`native/gateway/src/app/provider_balance_panels.rs`，顺序 `newapi-token` → `sub2api` → `newapi-billing` → `general`，单步 4s。
- 与设计的差异：识别结果只缓存在网关进程内存（按 origin，命中 24h、未命中 1h、连续 3 次失败重探），不写 `providers.json`；网关重启后重新探测一次。
- new-api 换算单位取 `/api/status` 的 `quota_per_unit`，取不到用 500000。
- 余额条：`provider` 归一为 `relay` / `relay-token`，标题用 `quotaRelayBalanceTitle` / `quotaRelayTokenBalanceTitle`。
- EronMind 实测：`/api/usage/token` 返回 `unlimited_quota:true` 且无 `user_quota`，因此该令牌查不到余额，余额条显示失败原因；要显示余额需在中转站后台给令牌设额度或开启账户额度查询，或等第二期 access token。
