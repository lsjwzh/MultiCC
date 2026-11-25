use crate::js::{number_to_string, JsString};

fn wait_span(ms: f64) -> String {
    let minutes = (ms / 60_000.0).round();
    if minutes >= 1.0 {
        format!("{} 分钟", number_to_string(minutes))
    } else {
        "一会儿".into()
    }
}

pub fn queued(locked: bool, reasons: &JsString, ms: f64) -> JsString {
    let mut text = JsString::from("⏳ 这条消息等了 ");
    text.push_str(&wait_span(ms));
    text.push_str("还没能开始：");
    text.push_str(if locked {
        "上一条投递尚未结算（"
    } else {
        "工作区被占用（"
    });
    text.push(reasons);
    text.push_str("），而且当前没有轮次在跑。在聊天队列里点「立刻插入」可以强制释放并马上执行这条；不想等也可以先取消占用它的后台任务。");
    text
}

pub fn held(ms: f64) -> String {
    format!("⏳ 这条消息等了 {}还没能开始：本轮的回复已经给出，但本轮的后台任务（Agent / 后台命令 / Monitor）还没结束，回合会一直保持到它们结束。后台任务结束后这条会自动执行；想马上开始，可以在聊天队列里点「立刻插入」（会先结束本轮并停掉这些后台任务）。", wait_span(ms))
}

pub fn hold_cap(rounded_minutes: Option<f64>) -> String {
    let span = rounded_minutes.map_or_else(
        || "一段时间".to_owned(),
        |m| format!("{} 分钟", number_to_string(m)),
    );
    format!("⏱ 本轮的后台任务（Agent / 后台命令 / Monitor）已经跑了 {span}，回合会继续保持开启，直到它们结束（后台工作属于本轮，回复已给出不等于本轮结束）。想马上结束本轮，可以在聊天队列里点「立刻插入」或停止本轮（会同时停掉这些后台任务）。")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_waits_at_half_minutes() {
        assert_eq!(wait_span(29_999.99), "一会儿");
        assert_eq!(wait_span(30_000.0), "1 分钟");
        assert_eq!(wait_span(90_000.0), "2 分钟");
        assert_eq!(wait_span(f64::NAN), "一会儿");
    }

    #[test]
    fn keeps_unpaired_code_units_in_queue_reasons() {
        let reasons = JsString::from_units(vec![0xd800]);
        assert!(queued(false, &reasons, 0.0).as_units().contains(&0xd800));
    }
}
