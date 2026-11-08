use multicc_core::chat_turn_lifecycle::{ChatRunnerLifecycle, ChatTurnLifecycle};
use multicc_core::js::JsValue;
use napi::bindgen_prelude::{JsValue as _, Unknown};
use napi::{check_status, sys, Env, Result};
use napi_derive::napi;
use std::{ffi::CStr, ptr};

fn read(env: Env, value: Unknown<'_>) -> Result<JsValue> {
    unsafe { crate::js_bridge::read_value(env.raw(), value.raw(), 0, &mut Vec::new()) }
}

unsafe fn property(
    env: sys::napi_env,
    value: sys::napi_value,
    name: &CStr,
) -> Result<sys::napi_value> {
    let mut object = ptr::null_mut();
    check_status!(unsafe { sys::napi_coerce_to_object(env, value, &mut object) })?;
    let mut result = ptr::null_mut();
    check_status!(unsafe {
        sys::napi_get_named_property(env, object, name.as_ptr(), &mut result)
    })?;
    Ok(result)
}

unsafe fn equal(env: sys::napi_env, left: sys::napi_value, right: sys::napi_value) -> Result<bool> {
    let mut result = false;
    check_status!(unsafe { sys::napi_strict_equals(env, left, right, &mut result) })?;
    Ok(result)
}

unsafe fn truthy(env: sys::napi_env, value: sys::napi_value) -> Result<bool> {
    let mut boolean = ptr::null_mut();
    check_status!(unsafe { sys::napi_coerce_to_bool(env, value, &mut boolean) })?;
    let mut result = false;
    check_status!(unsafe { sys::napi_get_value_bool(env, boolean, &mut result) })?;
    Ok(result)
}

unsafe fn is_true(env: sys::napi_env, value: sys::napi_value) -> Result<bool> {
    let mut boolean = ptr::null_mut();
    check_status!(unsafe { sys::napi_get_boolean(env, true, &mut boolean) })?;
    unsafe { equal(env, value, boolean) }
}

unsafe fn is_string(env: sys::napi_env, value: sys::napi_value, expected: &CStr) -> Result<bool> {
    let mut string = ptr::null_mut();
    check_status!(unsafe {
        sys::napi_create_string_utf8(
            env,
            expected.as_ptr(),
            expected.to_bytes().len() as isize,
            &mut string,
        )
    })?;
    unsafe { equal(env, value, string) }
}

unsafe fn finality_result(
    env: sys::napi_env,
    is_final: bool,
    code: Option<&str>,
) -> Result<sys::napi_value> {
    let result = JsValue::object(vec![
        ("final", JsValue::Bool(is_final)),
        ("code", code.map(JsValue::string).unwrap_or(JsValue::Null)),
    ]);
    unsafe { crate::js_bridge::write_value(env, &result) }
}

/// Process and persistent-stream boundaries have distinct evidence rules.
#[napi]
pub fn decide_chat_runner_finality(
    env: Env,
    runner: Unknown<'_>,
    facts: Unknown<'_>,
) -> Result<sys::napi_value> {
    let env = env.raw();
    let runner = runner.raw();
    let facts = facts.raw();
    if !unsafe { truthy(env, runner) }? {
        return unsafe { finality_result(env, false, Some("runner_required")) };
    }
    if unsafe { truthy(env, property(env, runner, c"killReason")?) }?
        || unsafe { truthy(env, property(env, facts, c"killReason")?) }?
    {
        return unsafe { finality_result(env, false, Some("explicit_lifecycle_stop")) };
    }
    if unsafe { truthy(env, property(env, runner, c"retryPlanned")?) }?
        || unsafe { is_true(env, property(env, facts, c"retryPlanned")?) }?
    {
        return unsafe { finality_result(env, false, Some("retry_pending")) };
    }
    if unsafe { is_true(env, property(env, facts, c"apiError")?) }? {
        return unsafe { finality_result(env, false, Some("api_error")) };
    }
    if unsafe { is_true(env, property(env, facts, c"adapterError")?) }? {
        return unsafe { finality_result(env, false, Some("adapter_error")) };
    }
    if unsafe { is_string(env, property(env, runner, c"kind")?, c"stream") }? {
        // The original object literal reads resultEvent twice; a getter can
        // produce different values and its exceptions must remain observable.
        let is_final = unsafe { is_true(env, property(env, runner, c"resultEvent")?) }?;
        let code = if unsafe { is_true(env, property(env, runner, c"resultEvent")?) }? {
            None
        } else {
            Some("stream_result_event_required")
        };
        return unsafe { finality_result(env, is_final, code) };
    }
    let is_final = unsafe { is_true(env, property(env, runner, c"resultEvent")?) }?
        || (unsafe { is_true(env, property(env, facts, c"normalExit")?) }?
            && !unsafe { is_true(env, property(env, facts, c"isRetry")?) }?);
    let code = if is_final {
        None
    } else if unsafe { is_true(env, property(env, facts, c"isRetry")?) }? {
        Some("retry_result_event_required")
    } else {
        Some("clean_exit_required")
    };
    unsafe { finality_result(env, is_final, code) }
}

unsafe fn completed(env: sys::napi_env, outcome: sys::napi_value) -> Result<bool> {
    let mut kind = sys::ValueType::napi_undefined;
    check_status!(unsafe { sys::napi_typeof(env, outcome, &mut kind) })?;
    if kind == sys::ValueType::napi_undefined || kind == sys::ValueType::napi_null {
        return Ok(false);
    }
    let version = unsafe { property(env, outcome, c"version") }?;
    let mut one = ptr::null_mut();
    check_status!(unsafe { sys::napi_create_int32(env, 1, &mut one) })?;
    if !unsafe { equal(env, version, one) }? {
        return Ok(false);
    }
    let state = unsafe { property(env, outcome, c"state") }?;
    let mut expected = ptr::null_mut();
    check_status!(unsafe {
        sys::napi_create_string_utf8(env, c"completed".as_ptr(), 9, &mut expected)
    })?;
    if !unsafe { equal(env, state, expected) }? {
        return Ok(false);
    }
    unsafe { is_true(env, property(env, outcome, c"settled")?) }
}

/// Evaluate in the same order as the host's former guards. Reading properties
/// lazily preserves getter exceptions, identity and short-circuit semantics.
#[napi]
pub fn evaluate_chat_post_turn(
    env: Env,
    turn: Unknown<'_>,
    runner: Unknown<'_>,
    facts: Unknown<'_>,
) -> Result<Option<String>> {
    let env = env.raw();
    let turn = turn.raw();
    let runner = runner.raw();
    let facts = facts.raw();
    let current_turn = unsafe { property(env, facts, c"currentTurn") }?;
    let current_runner = unsafe { property(env, facts, c"currentRunner") }?;
    if !unsafe { equal(env, current_turn, turn) }?
        || !unsafe { equal(env, current_runner, runner) }?
        || !unsafe { truthy(env, turn) }?
        || !unsafe { truthy(env, runner) }?
        || !unsafe {
            equal(
                env,
                property(env, runner, c"turnId")?,
                property(env, turn, c"turnId")?,
            )
        }?
    {
        return Ok(Some("stale_runner".into()));
    }
    if !unsafe { truthy(env, property(env, turn, c"resultDurable")?) }? {
        return Ok(Some("result_not_durable".into()));
    }
    if !unsafe {
        equal(
            env,
            property(env, turn, c"resultRunnerId")?,
            property(env, runner, c"runnerId")?,
        )
    }? {
        return Ok(Some("result_owned_by_other_runner".into()));
    }
    if unsafe { truthy(env, property(env, runner, c"killReason")?) }?
        || unsafe { is_true(env, property(env, facts, c"interrupted")?) }?
    {
        return Ok(Some("turn_interrupted".into()));
    }
    if unsafe { is_true(env, property(env, facts, c"apiError")?) }? {
        return Ok(Some("api_error_retry_pending".into()));
    }
    if unsafe { truthy(env, property(env, runner, c"retryPlanned")?) }?
        || unsafe { is_true(env, property(env, facts, c"retryPlanned")?) }?
    {
        return Ok(Some("retry_pending".into()));
    }
    if unsafe { is_true(env, property(env, facts, c"handoffResumeFailure")?) }? {
        return Ok(Some("handoff_resume_failed".into()));
    }
    if !unsafe { completed(env, property(env, runner, c"completionOutcome")?) }? {
        return Ok(Some("runner_not_completed".into()));
    }
    if unsafe { truthy(env, property(env, turn, c"postTurnClaimed")?) }? {
        return Ok(Some("post_turn_already_claimed".into()));
    }
    Ok(None)
}

#[napi]
pub struct RustChatTurnLifecycle {
    inner: ChatTurnLifecycle,
}

#[napi]
pub struct RustChatRunnerLifecycle {
    inner: ChatRunnerLifecycle,
}

#[napi]
impl RustChatRunnerLifecycle {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            inner: ChatRunnerLifecycle::default(),
        }
    }
    #[napi]
    pub fn usage_recorded(&self) -> bool {
        self.inner.usage_recorded
    }
    #[napi]
    pub fn set_usage_recorded(&mut self, value: bool) {
        self.inner.usage_recorded = value;
    }
    #[napi]
    pub fn claim_usage(&mut self) -> bool {
        self.inner.claim_usage()
    }
    #[napi]
    pub fn begin_usage(&mut self) -> bool {
        self.inner.begin_usage()
    }
    #[napi]
    pub fn end_usage(&mut self) {
        self.inner.end_usage();
    }
}

#[napi]
impl RustChatTurnLifecycle {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            inner: ChatTurnLifecycle::default(),
        }
    }

    #[napi]
    pub fn begin_result_append(&mut self) -> bool {
        self.inner.begin_result_append()
    }

    #[napi]
    pub fn end_result_append(&mut self) {
        self.inner.end_result_append();
    }

    #[napi]
    pub fn record_confirmed_result(&mut self, env: Env, owner: Unknown<'_>) -> Result<bool> {
        Ok(self.inner.record_confirmed_result(read(env, owner)?))
    }

    #[napi]
    pub fn has_confirmed_result(&self) -> bool {
        self.inner.confirmed_result_owner().is_some()
    }

    #[napi]
    pub fn confirmed_result_owner(&self, env: Env) -> Result<sys::napi_value> {
        let value = self
            .inner
            .confirmed_result_owner()
            .unwrap_or(&JsValue::Undefined);
        unsafe { crate::js_bridge::write_value(env.raw(), value) }
    }

    #[napi]
    pub fn result_durable(&self, env: Env) -> Result<sys::napi_value> {
        unsafe { crate::js_bridge::write_value(env.raw(), &self.inner.result_durable) }
    }

    #[napi]
    pub fn result_runner_id(&self, env: Env) -> Result<sys::napi_value> {
        unsafe { crate::js_bridge::write_value(env.raw(), &self.inner.result_runner_id) }
    }

    #[napi]
    pub fn post_turn_claimed(&self, env: Env) -> Result<sys::napi_value> {
        unsafe { crate::js_bridge::write_value(env.raw(), &self.inner.post_turn_claimed) }
    }

    #[napi]
    pub fn set_result_durable(&mut self, env: Env, value: Unknown<'_>) -> Result<()> {
        self.inner.result_durable = read(env, value)?;
        Ok(())
    }

    #[napi]
    pub fn set_result_runner_id(&mut self, env: Env, value: Unknown<'_>) -> Result<()> {
        self.inner.result_runner_id = read(env, value)?;
        Ok(())
    }

    #[napi]
    pub fn set_post_turn_claimed(&mut self, env: Env, value: Unknown<'_>) -> Result<()> {
        self.inner.post_turn_claimed = read(env, value)?;
        Ok(())
    }

    #[napi]
    pub fn claim_post_turn(&mut self) -> bool {
        self.inner.claim_post_turn()
    }
}
