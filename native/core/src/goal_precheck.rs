//! Goal precheck requests from the gateway and the embedded Node host use the
//! same prompt. UTF-16 keeps arbitrary task text intact across the addon.
use crate::js::JsString;

pub const DIMENSIONS: [(&str, &str); 4] = [
    ("objective", "目标明确：清楚要达成什么结果，而非含糊方向。"),
    (
        "criteria",
        "完成标准明确：有可判断「做完了」的验收标准或可观察的产出。",
    ),
    ("scope", "范围清晰：边界明确，不至于无限发散。"),
    (
        "executable",
        "可独立执行：代理无需再追问关键信息即可开工，或缺失信息能用合理默认补足。",
    ),
];

pub fn build_prompt(labels: &[JsString], task: &JsString) -> JsString {
    let mut prompt = JsString::from(
        r#"你是「任务质量审查助手」。下面是用户想交给一个自主 AI 编程代理、以「无人值守」模式（目标驱动、自主规划并执行到完成、最后由辅助模型自检验证）执行的任务。

请只依据以下启用的标准判断它是否满足要求：
"#,
    );
    for (index, label) in labels.iter().enumerate() {
        if index > 0 {
            prompt.push_unit(b'\n' as u16);
        }
        prompt.push_str(&format!("{}. ", index + 1));
        prompt.push(label);
    }
    prompt.push_str(
        r#"

只输出一个 JSON 对象，不要任何额外文字、不要 markdown 代码块，字段如下：
{
  "verdict": "ok" | "needs_work",
  "score": 0,
  "issues": ["不满足之处，没有则空数组"],
  "questions": ["仍需向用户澄清的问题，没有则空数组"],
  "criteria": ["建议的完成/验收标准"],
  "revised": "改写后可直接执行的任务描述，含目标与完成标准；若原任务已经很好可与原文基本一致"
}

score 为 0-100 的整数符合度评分，只针对上面启用的标准评分。所有文本字段用与用户任务相同的语言填写。

用户任务：
<<<
"#,
    );
    prompt.push(task);
    prompt.push_str("\n>>>");
    prompt
}
