//! Encoding comparison against server frames recorded from the live Node chat host.
//! This tests the frame encoder only; it does not claim Rust owns `/ws/chat`.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::Value;
use tokio_tungstenite::tungstenite::protocol::frame::{
    coding::{Data, OpCode},
    Frame,
};

#[test]
fn rust_encoder_matches_captured_node_chat_data_frames() {
    let golden: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../docs/rust-migration/differential/chat-replay-buffer-golden.json"
    )))
    .unwrap();
    let mut checked = 0;
    for scenario in golden["scenarios"].as_array().unwrap() {
        for field in ["liveWireFrames", "wireFrames"] {
            for frame in scenario[field].as_array().unwrap() {
                let expected = STANDARD.decode(frame["base64"].as_str().unwrap()).unwrap();
                let opcode = match expected[0] & 0x0f {
                    0 => Data::Continue,
                    1 => Data::Text,
                    2 => Data::Binary,
                    8..=10 => continue,
                    code => panic!("unexpected opcode {code}"),
                };
                assert_eq!(expected[0] & 0x70, 0, "capture disables compression");
                assert_eq!(expected[1] & 0x80, 0, "server frames are unmasked");
                let offset = match expected[1] & 0x7f {
                    126 => 4,
                    127 => 10,
                    _ => 2,
                };
                let mut actual = Vec::new();
                Frame::message(
                    expected[offset..].to_vec(),
                    OpCode::Data(opcode),
                    expected[0] & 0x80 != 0,
                )
                .format(&mut actual)
                .unwrap();
                assert_eq!(
                    actual, expected,
                    "{}: {field} frame {checked}",
                    scenario["name"]
                );
                checked += 1;
            }
        }
    }
    assert!(
        checked > 1000,
        "capture unexpectedly lost data frames: {checked}"
    );
    eprintln!("matched {checked} captured Node data frames");
}
