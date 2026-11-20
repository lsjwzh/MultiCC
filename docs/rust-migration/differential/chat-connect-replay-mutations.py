#!/usr/bin/env python3
"""Mutate the connect-replay kernel and require the corpus tests to fail.

Each variant breaks exactly one rule the retired connect path enforced. A
green differential only means something if every rule is load-bearing.

Run through the shared runner, so a variant that does not compile aborts the
batch instead of being counted as a detection (see mutation_runner.py). The
suite covers the pure kernel AND the JSON bridge the turn engine actually
calls: the first version of this file only mutated the kernel, which left the
bridge -- the code that finally runs in production -- with no mutation
coverage at all.

Variants deliberately NOT listed, because the corpus cannot tell them apart:

* Removing the `replay_messages > 0` conjunct of the clear condition.
  `last_message_is_assistant` can only be true when there is a last message,
  so the corpus cannot express the combination that would tell the two apart.
* The non-finite / negative arm of `count`. The turn engine only sends
  `.length` values, which are never negative or non-finite.
"""
from mutation_runner import ROOT, Mutator, run_suite

KERNEL = "native/core/src/chat_connect_replay.rs"
source = (ROOT / KERNEL).read_text()
m = Mutator(source)

# `skips-instead-of-clearing` needs two coordinated edits, so the second one is
# applied to the result of the first.
skip_step_one = m.apply("""    let buffered = if steps.contains(&Step::ClearBuffer) {
        0
    } else {
        facts.buffered_events
    };""", "    let buffered = facts.buffered_events;", "skips-instead-of-clearing/1")
skips_instead_of_clearing = Mutator(skip_step_one).apply(
    """pub fn buffer_after(facts: &Facts, steps: &[Step]) -> usize {
    if steps.contains(&Step::ClearBuffer) {
        0
    } else {
        facts.buffered_events
    }
}""", """pub fn buffer_after(facts: &Facts, _steps: &[Step]) -> usize {
    facts.buffered_events
}""", "skips-instead-of-clearing/2")

variants = [
    ("baseline", source, True),

    # ---- the pure kernel -------------------------------------------------------
    # Clearing the buffer without checking it has anything in it: the client
    # sees the same frames, but an empty-buffer connect gains a step.
    ("clears-an-empty-buffer",
     m.apply("\n            && facts.buffered_events > 0\n        {", "\n        {",
             "clears-an-empty-buffer"), False),
    # Skipping the burst instead of clearing the session buffer: the client
    # sees the same frames, but the session keeps a stale buffer.
    ("skips-instead-of-clearing", skips_instead_of_clearing, False),
    # The streaming gate is dropped from the burst: a stale buffer left by a
    # finished turn would be replayed to the new client.
    ("replays-a-finished-turns-buffer",
     m.apply("if facts.is_streaming && buffered > 0 {", "if buffered > 0 {",
             "replays-a-finished-turns-buffer"), False),
    # The token-usage-only case loses its history frame (and its seed).
    ("requires-messages-for-the-history-frame",
     m.apply("facts.replay_messages > 0 || facts.has_token_usage", "facts.replay_messages > 0",
             "requires-messages-for-the-history-frame"), False),
    # A quiet session is sent a history frame it has nothing to put in.
    ("always-sends-a-history-frame",
     m.apply("facts.replay_messages > 0 || facts.has_token_usage", "true",
             "always-sends-a-history-frame"), False),
    # The seed is emitted before the history frame.
    ("reorders-the-seed",
     m.apply("""        steps.push(Step::ChatHistory);
        if facts.has_task_state_seed {
            steps.push(Step::TaskStateSeed);
        }""", """        if facts.has_task_state_seed {
            steps.push(Step::TaskStateSeed);
        }
        steps.push(Step::ChatHistory);""", "reorders-the-seed"), False),
    # The clear no longer requires the in-progress assistant message.
    ("clears-when-the-last-message-is-not-the-assistant",
     m.apply("\n            && facts.last_message_is_assistant\n", "\n",
             "clears-when-the-last-message-is-not-the-assistant"), False),
    # The clear no longer requires an active stream.
    ("clears-a-finished-turns-buffer",
     m.apply("\n            && facts.is_streaming\n            && facts.buffered_events > 0",
             "\n            && facts.buffered_events > 0", "clears-a-finished-turns-buffer"), False),

    # ---- the JSON bridge the turn engine calls ------------------------------------
    # A key misread: the connect would believe nothing is streaming.
    ("bridge-reads-is-streaming-from-the-wrong-key",
     m.apply('is_streaming: value["isStreaming"].as_bool().unwrap_or(false),',
             'is_streaming: value["streaming"].as_bool().unwrap_or(false),',
             "bridge-reads-is-streaming-from-the-wrong-key"), False),
    ("bridge-reads-the-buffer-depth-from-the-wrong-key",
     m.apply('buffered_events: count(&value["bufferedEvents"]),',
             'buffered_events: count(&value["buffered"]),',
             "bridge-reads-the-buffer-depth-from-the-wrong-key"), False),
    # The burst reports a different frame count than the plan holds.
    ("bridge-burst-reports-no-frames",
     m.apply('serde_json::json!({ "op": "replayBurst", "frames": frames })',
             'serde_json::json!({ "op": "replayBurst", "frames": 0 })',
             "bridge-burst-reports-no-frames"), False),
    # A step renamed on the wire: the turn engine would ignore it.
    ("bridge-renames-the-clear-step",
     m.apply('Step::ClearBuffer => serde_json::json!({ "op": "clearBuffer" })',
             'Step::ClearBuffer => serde_json::json!({ "op": "clear" })',
             "bridge-renames-the-clear-step"), False),
    # The bridge claims the seed is always consulted.
    ("bridge-says-the-seed-is-always-consulted",
     m.apply('"needsTaskStateSeed": needs_task_state_seed(&facts),',
             '"needsTaskStateSeed": true,', "bridge-says-the-seed-is-always-consulted"), False),
    ("bridge-ignores-token-usage",
     m.apply('has_token_usage: value["hasTokenUsage"].as_bool().unwrap_or(false),',
             'has_token_usage: false,', "bridge-ignores-token-usage"), False),
    ("bridge-skips-lazy-seed",
     m.apply('has_task_state_seed: value["hasTaskStateSeed"].as_bool().unwrap_or(true),',
             'has_task_state_seed: value["hasTaskStateSeed"].as_bool().unwrap_or(false),',
             "bridge-skips-lazy-seed"), False),
]

run_suite(KERNEL, "chat-connect-replay-golden.json", "chat_connect_replay", variants,
          min_tests=10, tag="chat-connect-replay")
