use multicc_core::js::{JsString, JsValue};
use multicc_core::provider_attempt_lifecycle::{
    AttemptBudget, AttemptFence, AttemptGenerations, AttemptIdentity, AttemptStatus,
    CurrentAttempts, Fence, MainProducer, MainProducers, NonMainProducers, SharedMainProducer,
};
use napi::bindgen_prelude::{JsValue as _, ToNapiValue, Unknown};
use napi::{check_status, sys, Env, Error, Result};
use napi_derive::napi;
use std::{ffi::CStr, ptr};

unsafe fn named(
    env: sys::napi_env,
    object: sys::napi_value,
    name: &CStr,
) -> Result<sys::napi_value> {
    let mut value = ptr::null_mut();
    check_status!(unsafe { sys::napi_get_named_property(env, object, name.as_ptr(), &mut value) })?;
    Ok(value)
}

unsafe fn strict_string(env: sys::napi_env, value: sys::napi_value) -> Result<Option<JsValue>> {
    let mut kind = sys::ValueType::napi_undefined;
    check_status!(unsafe { sys::napi_typeof(env, value, &mut kind) })?;
    if kind != sys::ValueType::napi_string {
        return Ok(None);
    }
    Ok(Some(unsafe {
        crate::js_bridge::read_value(env, value, 0, &mut Vec::new())
    }?))
}

#[napi(object)]
pub struct FenceSnapshot {
    pub replay_fence: String,
    pub visible_output_observed: bool,
    pub tool_intent_observed: bool,
    pub side_effect_observed: bool,
}

#[napi]
pub struct RustProviderAttemptLifecycle {
    inner: AttemptFence,
    budget: AttemptBudget,
    status: AttemptStatus,
    identity: AttemptIdentity,
}

#[napi]
pub struct RustProviderAttemptGenerations {
    inner: AttemptGenerations,
}

fn producer_key(env: &Env, key: Unknown<'_>) -> Result<JsString> {
    match unsafe { strict_string(env.raw(), key.raw()) }? {
        Some(JsValue::String(value)) => Ok(value),
        _ => Err(Error::from_reason("invalid producer key")),
    }
}

fn producer_token(env: &Env, token: Unknown<'_>) -> Result<JsValue> {
    if let Some(value) = unsafe { strict_string(env.raw(), token.raw()) }? {
        return Ok(value);
    }
    let mut kind = sys::ValueType::napi_undefined;
    check_status!(unsafe { sys::napi_typeof(env.raw(), token.raw(), &mut kind) })?;
    if kind == sys::ValueType::napi_null {
        return Ok(JsValue::Null);
    }
    Err(Error::from_reason("invalid producer token"))
}

// The request-start snapshot is a frozen JS object. Holding a strong N-API
// reference preserves its identity without retaining a second Node Map.
struct StrongAttempt {
    env: sys::napi_env,
    reference: sys::napi_ref,
}

impl StrongAttempt {
    fn new(env: &Env, value: Unknown<'_>) -> Result<Option<Self>> {
        let raw = env.raw();
        let mut kind = sys::ValueType::napi_undefined;
        check_status!(unsafe { sys::napi_typeof(raw, value.raw(), &mut kind) })?;
        if kind == sys::ValueType::napi_null || kind == sys::ValueType::napi_undefined {
            return Ok(None);
        }
        let mut reference = ptr::null_mut();
        check_status!(unsafe { sys::napi_create_reference(raw, value.raw(), 1, &mut reference) })?;
        Ok(Some(Self {
            env: raw,
            reference,
        }))
    }

    fn value(&self, env: &Env) -> Result<sys::napi_value> {
        let mut value = ptr::null_mut();
        check_status!(unsafe {
            sys::napi_get_reference_value(env.raw(), self.reference, &mut value)
        })?;
        Ok(value)
    }
}

impl Drop for StrongAttempt {
    fn drop(&mut self) {
        // The class and its records are used and finalized on their Node env.
        unsafe {
            sys::napi_delete_reference(self.env, self.reference);
        }
    }
}

#[napi]
pub struct RustCurrentAttempts {
    inner: CurrentAttempts<StrongAttempt>,
}

impl Default for RustCurrentAttempts {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
impl RustCurrentAttempts {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            inner: CurrentAttempts::default(),
        }
    }

    #[napi]
    pub fn get(&self, env: Env, key: Unknown<'_>) -> Result<sys::napi_value> {
        match self.inner.get(&producer_key(&env, key)?) {
            Some(value) => value.value(&env),
            None => {
                let mut undefined = ptr::null_mut();
                check_status!(unsafe { sys::napi_get_undefined(env.raw(), &mut undefined) })?;
                Ok(undefined)
            }
        }
    }

    #[napi]
    pub fn set(&mut self, env: Env, key: Unknown<'_>, value: Unknown<'_>) -> Result<()> {
        let key = producer_key(&env, key)?;
        let value = StrongAttempt::new(&env, value)?
            .ok_or_else(|| Error::from_reason("invalid current attempt"))?;
        self.inner.set(key, value);
        Ok(())
    }

    #[napi]
    pub fn begin_admission(&mut self, env: Env, key: Unknown<'_>) -> Result<bool> {
        Ok(self.inner.begin_admission(producer_key(&env, key)?))
    }

    #[napi]
    pub fn end_admission(&mut self, env: Env, key: Unknown<'_>) -> Result<()> {
        self.inner.end_admission(&producer_key(&env, key)?);
        Ok(())
    }
}

#[napi]
pub struct RustMainProducer {
    inner: SharedMainProducer<StrongAttempt>,
}

#[napi]
impl RustMainProducer {
    #[napi(getter)]
    pub fn count(&self) -> f64 {
        self.inner.borrow().count
    }
    #[napi(setter)]
    pub fn set_count(&mut self, value: f64) {
        self.inner.borrow_mut().count = value;
    }
    #[napi(getter)]
    pub fn ambiguous(&self) -> bool {
        self.inner.borrow().ambiguous
    }
    #[napi(setter)]
    pub fn set_ambiguous(&mut self, value: bool) {
        self.inner.borrow_mut().ambiguous = value;
    }
    #[napi(getter)]
    pub fn last_request_at(&self) -> f64 {
        self.inner.borrow().last_request_at
    }
    #[napi(setter)]
    pub fn set_last_request_at(&mut self, value: f64) {
        self.inner.borrow_mut().last_request_at = value;
    }
    #[napi(getter)]
    pub fn proxy_route_token(&self, env: Env) -> Result<sys::napi_value> {
        unsafe { crate::js_bridge::write_value(env.raw(), &self.inner.borrow().token) }
    }
    #[napi(getter)]
    pub fn attempt(&self, env: Env) -> Result<sys::napi_value> {
        let producer = self.inner.borrow();
        if let Some(attempt) = &producer.attempt {
            return attempt.value(&env);
        }
        let mut null = ptr::null_mut();
        check_status!(unsafe { sys::napi_get_null(env.raw(), &mut null) })?;
        Ok(null)
    }
}

#[napi]
pub struct RustMainProducers {
    inner: MainProducers<StrongAttempt>,
}

fn main_producer_value(
    env: &Env,
    value: Option<SharedMainProducer<StrongAttempt>>,
) -> Result<sys::napi_value> {
    if let Some(inner) = value {
        return unsafe { RustMainProducer::to_napi_value(env.raw(), RustMainProducer { inner }) };
    }
    let mut undefined = ptr::null_mut();
    check_status!(unsafe { sys::napi_get_undefined(env.raw(), &mut undefined) })?;
    Ok(undefined)
}

impl Default for RustMainProducers {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
impl RustMainProducers {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            inner: MainProducers::default(),
        }
    }

    #[napi]
    pub fn get_active(&self, env: Env, key: Unknown<'_>) -> Result<sys::napi_value> {
        main_producer_value(&env, self.inner.active(&producer_key(&env, key)?))
    }

    // JS calls this method positionally; its arity is the napi ABI.
    #[allow(clippy::too_many_arguments)]
    #[napi]
    pub fn set_active(
        &mut self,
        env: Env,
        key: Unknown<'_>,
        attempt: Unknown<'_>,
        token: Unknown<'_>,
        count: f64,
        ambiguous: bool,
        last_request_at: f64,
    ) -> Result<()> {
        let key = producer_key(&env, key)?;
        let token = producer_token(&env, token)?;
        let attempt = StrongAttempt::new(&env, attempt)?;
        self.inner.insert_active(
            key,
            MainProducer {
                attempt,
                token,
                count,
                ambiguous,
                last_request_at,
            },
        );
        Ok(())
    }

    #[napi]
    pub fn delete_active(&mut self, env: Env, key: Unknown<'_>) -> Result<bool> {
        Ok(self.inner.delete_active(&producer_key(&env, key)?))
    }

    #[napi]
    pub fn get_ended(&self, env: Env, key: Unknown<'_>) -> Result<sys::napi_value> {
        main_producer_value(&env, self.inner.ended(&producer_key(&env, key)?))
    }

    #[napi]
    pub fn set_ended(
        &mut self,
        env: Env,
        key: Unknown<'_>,
        attempt: Unknown<'_>,
        token: Unknown<'_>,
    ) -> Result<()> {
        let key = producer_key(&env, key)?;
        let token = producer_token(&env, token)?;
        let attempt = StrongAttempt::new(&env, attempt)?;
        self.inner.insert_ended(
            key,
            MainProducer {
                attempt,
                token,
                count: 0.0,
                ambiguous: false,
                last_request_at: 0.0,
            },
        );
        Ok(())
    }

    #[napi]
    pub fn delete_ended(&mut self, env: Env, key: Unknown<'_>) -> Result<bool> {
        Ok(self.inner.delete_ended(&producer_key(&env, key)?))
    }

    #[napi]
    pub fn has_ended(&self, env: Env, key: Unknown<'_>) -> Result<bool> {
        Ok(self.inner.has_ended(&producer_key(&env, key)?))
    }
}

#[napi]
pub struct RustNonMainProducers {
    inner: NonMainProducers,
}

impl Default for RustNonMainProducers {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
impl RustNonMainProducers {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            inner: NonMainProducers::default(),
        }
    }
    #[napi]
    pub fn start(&mut self, env: Env, key: Unknown<'_>) -> Result<()> {
        self.inner.start(producer_key(&env, key)?);
        Ok(())
    }
    #[napi]
    pub fn end(&mut self, env: Env, key: Unknown<'_>) -> Result<bool> {
        Ok(self.inner.end(&producer_key(&env, key)?))
    }
    #[napi]
    pub fn has_active(&self, env: Env, key: Unknown<'_>) -> Result<bool> {
        Ok(self.inner.has_active(&producer_key(&env, key)?))
    }
    #[napi]
    pub fn bind_usage(&mut self, env: Env, key: Unknown<'_>) -> Result<bool> {
        Ok(self.inner.bind_usage(&producer_key(&env, key)?))
    }
}

impl Default for RustProviderAttemptGenerations {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
impl RustProviderAttemptGenerations {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            inner: AttemptGenerations::default(),
        }
    }
    #[napi]
    pub fn next(&mut self, env: Env, session: Unknown<'_>) -> Result<f64> {
        let value =
            unsafe { crate::js_bridge::read_value(env.raw(), session.raw(), 0, &mut Vec::new()) }?;
        let JsValue::String(session) = value else {
            return Err(Error::from_reason("invalid session identity"));
        };
        Ok(self.inner.next(session))
    }
}

#[napi(object)]
pub struct BudgetSnapshot {
    pub request_deadline_at: Option<f64>,
    pub request_failures: f64,
    pub stalled: bool,
}

#[napi(object)]
pub struct AttemptStatusSnapshot {
    pub outcome: String,
    pub error_category: Option<String>,
    pub finished_at: Option<f64>,
}

#[napi]
impl RustProviderAttemptLifecycle {
    // JS calls this constructor positionally; its arity is the napi ABI.
    #[allow(clippy::too_many_arguments)]
    #[napi(constructor)]
    pub fn new(
        env: Env,
        level: String,
        visible: bool,
        tool: bool,
        side_effect: bool,
        deadline: Option<f64>,
        failures: f64,
        identity: Unknown<'_>,
    ) -> Result<Self> {
        let level = Fence::parse(&level)
            .ok_or_else(|| Error::from_reason("invalid provider replay fence"))?;
        let identity =
            unsafe { crate::js_bridge::read_value(env.raw(), identity.raw(), 0, &mut Vec::new()) }?;
        Ok(Self {
            inner: AttemptFence::new(level, visible, tool, side_effect),
            budget: AttemptBudget::new(deadline, failures),
            status: AttemptStatus::default(),
            identity: AttemptIdentity::new(&identity),
        })
    }
    #[napi]
    pub fn snapshot(&self) -> FenceSnapshot {
        FenceSnapshot {
            replay_fence: self.inner.level.as_str().into(),
            visible_output_observed: self.inner.visible,
            tool_intent_observed: self.inner.tool,
            side_effect_observed: self.inner.side_effect,
        }
    }
    #[napi]
    pub fn advance(&mut self, value: String) -> Result<bool> {
        let next = Fence::parse(&value)
            .ok_or_else(|| Error::from_reason("invalid provider replay fence"))?;
        Ok(self.inner.advance(next))
    }
    #[napi]
    pub fn reconcile_host_error(&mut self) -> bool {
        self.inner.reconcile_host_error()
    }

    #[napi]
    pub fn budget(&self) -> BudgetSnapshot {
        BudgetSnapshot {
            request_deadline_at: self.budget.deadline,
            request_failures: self.budget.failures,
            stalled: self.budget.stalled,
        }
    }
    #[napi]
    pub fn completed(&mut self) {
        self.budget.completed();
    }
    #[napi]
    pub fn observe_failure(
        &mut self,
        deadline: f64,
        upstream_failure: bool,
        http_status: u32,
    ) -> bool {
        self.budget
            .observe_failure(deadline, upstream_failure, http_status)
    }
    #[napi]
    pub fn stall_retry_exhausted(&self, code: String) -> bool {
        self.budget.stall_retry_exhausted(&code)
    }
    #[napi]
    pub fn deadline_reached(&self, now: f64) -> bool {
        self.budget.deadline_reached(now)
    }
    #[napi]
    pub fn retire_if_stalled(&mut self, code: String, exhausted: bool) -> bool {
        self.budget.retire_if_stalled(&code, exhausted)
    }
    #[napi]
    pub fn status(&self) -> AttemptStatusSnapshot {
        AttemptStatusSnapshot {
            outcome: self.status.outcome.clone(),
            error_category: self.status.error_category.clone(),
            finished_at: self.status.finished_at,
        }
    }
    #[napi]
    pub fn running(&self) -> bool {
        self.status.running()
    }
    #[napi]
    pub fn succeeded(&self) -> bool {
        self.status.outcome == "succeeded"
    }
    #[napi]
    pub fn set_outcome(&mut self, outcome: String) {
        self.status.set_outcome(outcome);
    }
    #[napi]
    pub fn set_error_category(&mut self, value: Option<String>) {
        self.status.error_category = value;
    }
    #[napi]
    pub fn set_finished_at(&mut self, value: f64) {
        self.status.finished_at = Some(value);
    }
    #[napi]
    pub fn matches(&self, env: Env, reference: Unknown<'_>) -> Result<bool> {
        let raw = env.raw();
        let mut object = ptr::null_mut();
        check_status!(unsafe { sys::napi_coerce_to_object(raw, reference.raw(), &mut object) })?;
        let epoch = unsafe { named(raw, object, c"runtimeEpoch") }?;
        if !unsafe { strict_string(raw, epoch) }?.is_some_and(|v| self.identity.matches_epoch(&v)) {
            return Ok(false);
        }
        let attempt = unsafe { named(raw, object, c"routeAttemptId") }?;
        if !unsafe { strict_string(raw, attempt) }?
            .is_some_and(|v| self.identity.matches_attempt(&v))
        {
            return Ok(false);
        }
        // JavaScript Number(), rather than ToNumber, also accepts BigInt and
        // preserves the host's getter order and conversion exceptions.
        let mut global = ptr::null_mut();
        check_status!(unsafe { sys::napi_get_global(raw, &mut global) })?;
        let number = unsafe { named(raw, global, c"Number") }?;
        let generation = unsafe { named(raw, object, c"routeGeneration") }?;
        let mut receiver = ptr::null_mut();
        check_status!(unsafe { sys::napi_get_undefined(raw, &mut receiver) })?;
        let mut converted = ptr::null_mut();
        check_status!(unsafe {
            sys::napi_call_function(raw, receiver, number, 1, &generation, &mut converted)
        })?;
        let mut kind = sys::ValueType::napi_undefined;
        check_status!(unsafe { sys::napi_typeof(raw, converted, &mut kind) })?;
        if kind != sys::ValueType::napi_number {
            return Ok(false);
        }
        let mut generation_value = 0.0;
        check_status!(unsafe {
            sys::napi_get_value_double(raw, converted, &mut generation_value)
        })?;
        if !self.identity.matches_generation(generation_value) {
            return Ok(false);
        }
        let turn = unsafe { named(raw, object, c"turnId") }?;
        Ok(unsafe { strict_string(raw, turn) }?.is_some_and(|v| self.identity.matches_turn(&v)))
    }
}
