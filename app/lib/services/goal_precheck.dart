/// Goal 预检要等多久。
///
/// 只有一个来源：服务端 `/api/settings/goal` 公布的 `precheckWaitMs` —— 它拥有 Aux
/// 队列（并发池 + 一条严格顺序 lane，classify / memory_review 都在里面），只有它知
/// 道一次预检最多要排多久。客户端只在这个数字之上留一点余量，好让超时的时候用户看到的是服务端那句
/// 「辅助模型没返回，请检查配额或直接发送」，而不是一个裸的客户端 abort。
///
/// 为什么以前每次都失败：通用 HTTP 预算是 15s，而实测一次预检本身就要 ~18s（队列空闲
/// 时也是如此），排在有 classify 的队列后面就更久。
const int goalPrecheckFallbackWaitMs = 180000;
const int goalPrecheckClientSlackMs = 30000;

/// 服务端没给（旧服务端）就用兜底值；给了非法值也不许把预算缩到 0。
int goalPrecheckTimeoutMs(int? serverWaitMs) {
  final wait = (serverWaitMs != null && serverWaitMs > 0)
      ? serverWaitMs
      : goalPrecheckFallbackWaitMs;
  return wait + goalPrecheckClientSlackMs;
}
