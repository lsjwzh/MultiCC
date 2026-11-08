//! Borrowed JavaScript values for policies that must read properties lazily.
//! Unlike the value bridge, this does not enumerate or clone the input. Getters,
//! short circuits, exceptions and reference identity stay with the host engine.
use multicc_core::js::{JsString, JsValue};
use napi::bindgen_prelude::{JsValue as _, Unknown};
use napi::{check_status, sys, Env, Error, Result, Status};
use std::{
    ffi::{CStr, CString},
    marker::PhantomData,
    ptr,
};

#[derive(Clone, Copy)]
pub(crate) struct LiveValue<'env> {
    env: sys::napi_env,
    value: sys::napi_value,
    scope: PhantomData<&'env Env>,
}

impl<'env> LiveValue<'env> {
    pub fn new(env: &'env Env, value: Unknown<'env>) -> Self {
        Self {
            env: env.raw(),
            value: value.raw(),
            scope: PhantomData,
        }
    }
    /// Wrap a handle this module already obtained (array element, property
    /// value) in the same call's scope.
    pub fn from_raw(env: sys::napi_env, value: sys::napi_value) -> Self {
        Self {
            env,
            value,
            scope: PhantomData,
        }
    }
    fn with_value(self, value: sys::napi_value) -> Self {
        Self { value, ..self }
    }
    pub fn raw(self) -> sys::napi_value {
        self.value
    }
    pub fn env(self) -> sys::napi_env {
        self.env
    }
    pub fn global(self) -> Result<Self> {
        let mut value = ptr::null_mut();
        check_status!(unsafe { sys::napi_get_global(self.env, &mut value) })?;
        Ok(self.with_value(value))
    }
    pub fn get_key(self, key: Self) -> Result<Self> {
        let mut object = ptr::null_mut();
        check_status!(unsafe { sys::napi_coerce_to_object(self.env, self.value, &mut object) })?;
        let mut value = ptr::null_mut();
        check_status!(unsafe { sys::napi_get_property(self.env, object, key.raw(), &mut value) })?;
        Ok(self.with_value(value))
    }
    pub fn element(self, index: u32) -> Result<Self> {
        let mut value = ptr::null_mut();
        check_status!(unsafe { sys::napi_get_element(self.env, self.value, index, &mut value) })?;
        Ok(self.with_value(value))
    }
    pub fn number_value(self) -> Result<Option<f64>> {
        if self.kind()? != sys::ValueType::napi_number {
            return Ok(None);
        }
        let mut result = 0.0;
        check_status!(unsafe { sys::napi_get_value_double(self.env, self.value, &mut result) })?;
        Ok(Some(result))
    }
    pub fn is_array(self) -> Result<bool> {
        // N-API's IsArray does not unwrap a Proxy in V8; ECMAScript's does.
        let constructor = self.global()?.get(c"Array")?;
        constructor
            .get(c"isArray")?
            .call(constructor, &[self])?
            .truthy()
    }
    pub fn number(self) -> Result<f64> {
        let mut value = ptr::null_mut();
        check_status!(unsafe { sys::napi_coerce_to_number(self.env, self.value, &mut value) })?;
        let mut result = 0.0;
        check_status!(unsafe { sys::napi_get_value_double(self.env, value, &mut result) })?;
        Ok(result)
    }
    /// Explicit Number(value), which accepts BigInt unlike implicit ToNumber.
    pub fn explicit_number(self) -> Result<f64> {
        self.global()?.get(c"Number")?.call_plain(&[self])?.number()
    }
    fn primitive(self) -> Result<bool> {
        Ok(!matches!(
            self.kind()?,
            sys::ValueType::napi_object | sys::ValueType::napi_function
        ))
    }
    /// The numeric hint used by relational operators accepts BigInt as well as
    /// Number. ToNumber alone would incorrectly throw for a BigInt length.
    pub fn positive(self) -> Result<bool> {
        let value = if self.primitive()? {
            self
        } else {
            self.number_hint_primitive()?
        };
        if value.kind()? == sys::ValueType::napi_bigint {
            let text = value.coerce_string()?;
            return Ok(text != "0" && text.code_unit_at(0) != Some(b'-' as u16));
        }
        Ok(value.number()? > 0.0)
    }
    fn number_hint_primitive(self) -> Result<Self> {
        let key = self.global()?.get(c"Symbol")?.get(c"toPrimitive")?;
        let exotic = self.get_key(key)?;
        if !exotic.nullish()? {
            let value = exotic.call(self, &[self.from_value(&JsValue::string("number"))?])?;
            if value.primitive()? {
                return Ok(value);
            }
            return Err(self.type_error("Cannot convert object to primitive value"));
        }
        for key in [c"valueOf", c"toString"] {
            let method = self.get(key)?;
            if method.kind()? == sys::ValueType::napi_function {
                let value = method.call(self, &[])?;
                if value.primitive()? {
                    return Ok(value);
                }
            }
        }
        Err(self.type_error("Cannot convert object to primitive value"))
    }
    pub fn kind(self) -> Result<sys::napi_valuetype> {
        let mut kind = sys::ValueType::napi_undefined;
        check_status!(unsafe { sys::napi_typeof(self.env, self.value, &mut kind) })?;
        Ok(kind)
    }
    pub fn nullish(self) -> Result<bool> {
        Ok(matches!(
            self.kind()?,
            sys::ValueType::napi_null | sys::ValueType::napi_undefined
        ))
    }
    pub fn undefined(self) -> Result<bool> {
        Ok(self.kind()? == sys::ValueType::napi_undefined)
    }
    pub fn truthy(self) -> Result<bool> {
        let mut value = ptr::null_mut();
        check_status!(unsafe { sys::napi_coerce_to_bool(self.env, self.value, &mut value) })?;
        let mut result = false;
        check_status!(unsafe { sys::napi_get_value_bool(self.env, value, &mut result) })?;
        Ok(result)
    }
    pub fn get(self, name: &CStr) -> Result<Self> {
        let mut object = ptr::null_mut();
        check_status!(unsafe { sys::napi_coerce_to_object(self.env, self.value, &mut object) })?;
        let mut value = ptr::null_mut();
        check_status!(unsafe {
            sys::napi_get_named_property(self.env, object, name.as_ptr(), &mut value)
        })?;
        Ok(self.with_value(value))
    }
    pub fn optional(self, name: &CStr) -> Result<Self> {
        if self.nullish()? {
            return self.from_value(&JsValue::Undefined);
        }
        self.get(name)
    }
    pub fn equals(self, other: Self) -> Result<bool> {
        let mut result = false;
        check_status!(unsafe {
            sys::napi_strict_equals(self.env, self.value, other.value, &mut result)
        })?;
        Ok(result)
    }
    pub fn is_string(self, text: &str) -> Result<bool> {
        self.equals(self.from_value(&JsValue::string(text))?)
    }
    pub fn is_true(self) -> Result<bool> {
        self.equals(self.from_value(&JsValue::Bool(true))?)
    }
    pub fn is_false(self) -> Result<bool> {
        self.equals(self.from_value(&JsValue::Bool(false))?)
    }
    pub fn is_number(self, number: f64) -> Result<bool> {
        self.equals(self.from_value(&JsValue::Number(number))?)
    }
    pub fn string(self) -> Result<Option<JsString>> {
        if self.kind()? != sys::ValueType::napi_string {
            return Ok(None);
        }
        match unsafe { crate::js_bridge::read_value(self.env, self.value, 0, &mut Vec::new()) }? {
            JsValue::String(value) => Ok(Some(value)),
            _ => unreachable!(),
        }
    }
    /// ECMAScript ToString (as used by RegExp.test), not String(Symbol()).
    pub fn coerce_string(self) -> Result<JsString> {
        let mut value = ptr::null_mut();
        check_status!(unsafe { sys::napi_coerce_to_string(self.env, self.value, &mut value) })?;
        Ok(self
            .with_value(value)
            .string()?
            .expect("ToString returned a string"))
    }
    pub fn from_value(self, value: &JsValue) -> Result<Self> {
        Ok(self.with_value(unsafe { crate::js_bridge::write_value(self.env, value) }?))
    }
    pub fn set(self, name: &CStr, value: Self) -> Result<()> {
        let key = self.from_value(&JsValue::string(name.to_str().expect("static property")))?;
        unsafe { crate::js_bridge::define_value(self.env, self.value, key.raw(), value.raw()) }
    }
    pub fn define_key(self, key: Self, value: Self) -> Result<()> {
        unsafe { crate::js_bridge::define_value(self.env, self.value, key.raw(), value.raw()) }
    }
    /// Strict-mode property assignment, including Proxy/setter side effects.
    /// napi_set_named_property alone can silently ignore a read-only property.
    pub fn assign(self, name: &CStr, value: Self) -> Result<()> {
        let mut object = ptr::null_mut();
        check_status!(unsafe { sys::napi_coerce_to_object(self.env, self.value, &mut object) })?;
        let reflect = self.global()?.get(c"Reflect")?;
        let key = self.from_value(&JsValue::string(name.to_str().expect("static property")))?;
        if !reflect
            .get(c"set")?
            .call(reflect, &[self.with_value(object), key, value, self])?
            .truthy()?
        {
            return Err(self.type_error("Cannot assign to read-only property"));
        }
        Ok(())
    }
    /// `{ ...source }` into this object (CopyDataProperties): the source's own
    /// keys in [[OwnPropertyKeys]] order, then per key its descriptor and a
    /// [[Get]] for enumerable ones only, each defined as a data property, so a
    /// Proxy sees the same traps in the same order. Nullish copies nothing.
    pub fn spread_from(self, source: Self) -> Result<()> {
        if source.nullish()? {
            return Ok(());
        }
        let global = self.global()?;
        let object = global.get(c"Object")?.call_plain(&[source])?;
        let reflect = global.get(c"Reflect")?;
        let keys = reflect.get(c"ownKeys")?.call(reflect, &[object])?;
        let length = keys.get(c"length")?.number()?;
        let describe = reflect.get(c"getOwnPropertyDescriptor")?;
        let read = reflect.get(c"get")?;
        for index in 0..length as u32 {
            let key = keys.element(index)?;
            let descriptor = describe.call(reflect, &[object, key])?;
            if descriptor.undefined()? || !descriptor.get(c"enumerable")?.truthy()? {
                continue;
            }
            self.define_key(key, read.call(reflect, &[object, key, object])?)?;
        }
        Ok(())
    }
    /// `delete object[name]` on an object this module created.
    pub fn delete(self, name: &CStr) -> Result<()> {
        let reflect = self.global()?.get(c"Reflect")?;
        let key = self.from_value(&JsValue::string(name.to_str().expect("static property")))?;
        reflect
            .get(c"deleteProperty")?
            .call(reflect, &[self, key])?;
        Ok(())
    }
    pub fn clean_text(self) -> Result<Self> {
        if self.nullish()? {
            return self.from_value(&JsValue::string(""));
        }
        let text = self.global()?.get(c"String")?.call_plain(&[self])?;
        text.get(c"trim")?.call(text, &[])
    }
    pub fn freeze(self) -> Result<Self> {
        check_status!(unsafe { sys::napi_object_freeze(self.env, self.value) })?;
        Ok(self)
    }
    pub fn call(self, receiver: Self, arguments: &[Self]) -> Result<Self> {
        if self.kind()? != sys::ValueType::napi_function {
            return Err(self.type_error("completion hook is not a function"));
        }
        let arguments: Vec<_> = arguments.iter().map(|value| value.raw()).collect();
        let mut result = ptr::null_mut();
        check_status!(unsafe {
            sys::napi_call_function(
                self.env,
                receiver.raw(),
                self.raw(),
                arguments.len(),
                arguments.as_ptr(),
                &mut result,
            )
        })?;
        Ok(self.with_value(result))
    }
    pub fn call_plain(self, arguments: &[Self]) -> Result<Self> {
        self.call(self.from_value(&JsValue::Undefined)?, arguments)
    }
    /// A JavaScript try/catch boundary. Merely dropping napi::Error leaves the
    /// engine's pending exception set, poisoning the next host call.
    pub fn catch<T>(self, operation: impl FnOnce() -> Result<T>) -> Result<Option<T>> {
        match operation() {
            Ok(value) => Ok(Some(value)),
            Err(_) => {
                let mut pending = false;
                check_status!(unsafe { sys::napi_is_exception_pending(self.env, &mut pending) })?;
                if pending {
                    let mut exception = ptr::null_mut();
                    check_status!(unsafe {
                        sys::napi_get_and_clear_last_exception(self.env, &mut exception)
                    })?;
                }
                Ok(None)
            }
        }
    }
    pub fn construct(self, arguments: &[Self]) -> Result<Self> {
        let arguments: Vec<_> = arguments.iter().map(|value| value.raw()).collect();
        let mut value = ptr::null_mut();
        check_status!(unsafe {
            sys::napi_new_instance(
                self.env,
                self.value,
                arguments.len(),
                arguments.as_ptr(),
                &mut value,
            )
        })?;
        Ok(self.with_value(value))
    }
    pub fn throw_error(self) -> Error {
        unsafe {
            sys::napi_throw(self.env, self.value);
        }
        Error::new(Status::PendingException, "host error")
    }
    pub fn type_error(self, message: &str) -> Error {
        let text = CString::new(message).expect("static error message");
        unsafe {
            sys::napi_throw_type_error(self.env, ptr::null(), text.as_ptr());
        }
        Error::new(Status::PendingException, message)
    }
}
