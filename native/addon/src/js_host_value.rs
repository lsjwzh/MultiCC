//! Opaque host values for native owners. Scalars stay native; objects, symbols
//! and BigInts retain their engine identity without serialization or traversal.
//! A JS-visible anchor traces cycles. Rust holds only a weak reference to it.
use crate::js_live::LiveValue;
use multicc_core::js::JsValue;
use napi::{check_status, sys, Env, Result};
use std::{
    cell::{Cell, RefCell},
    ptr,
    rc::Rc,
};

#[derive(Clone)]
pub(crate) enum Value {
    Native(JsValue),
    Host(Rc<Slot>),
}
pub(crate) struct Slot {
    id: u64,
    retired: Rc<RefCell<Vec<u64>>>,
}
impl Drop for Slot {
    fn drop(&mut self) {
        self.retired.borrow_mut().push(self.id);
    }
}
pub(crate) struct Values {
    env: sys::napi_env,
    anchor: sys::napi_ref,
    next: Cell<u64>,
    retired: Rc<RefCell<Vec<u64>>>,
}
impl Values {
    pub fn new(anchor: LiveValue<'_>) -> Result<Self> {
        anchor.set(c"values", anchor.from_value(&JsValue::Object(vec![]))?)?;
        let mut reference = ptr::null_mut();
        check_status!(unsafe {
            sys::napi_create_reference(anchor.env(), anchor.raw(), 0, &mut reference)
        })?;
        Ok(Self {
            env: anchor.env(),
            anchor: reference,
            next: Cell::new(0),
            retired: Rc::default(),
        })
    }
    fn table<'a>(&self, env: &'a Env) -> Result<LiveValue<'a>> {
        let anchor = self.anchor(env)?;
        anchor.get(c"values")
    }
    /// The JS object that owns the live-value table. Borrowed for one call; the
    /// native owner keeps only a weak reference to it.
    pub fn anchor<'a>(&self, env: &'a Env) -> Result<LiveValue<'a>> {
        let mut value = ptr::null_mut();
        check_status!(unsafe {
            sys::napi_get_reference_value(env.raw(), self.anchor, &mut value)
        })?;
        if value.is_null() {
            return Err(napi::Error::from_reason("host value anchor released"));
        }
        Ok(LiveValue::from_raw(env.raw(), value))
    }
    pub fn drain(&self, env: &Env) -> Result<()> {
        // A failed getter may leave a pending exception. Retired handles are
        // released at the next entry, without clearing or replacing that error.
        let retired = std::mem::take(&mut *self.retired.borrow_mut());
        if retired.is_empty() {
            return Ok(());
        }
        let table = self.table(env)?;
        for id in retired {
            let key = table.from_value(&JsValue::string(&id.to_string()))?;
            let mut removed = false;
            check_status!(unsafe {
                sys::napi_delete_property(env.raw(), table.raw(), key.raw(), &mut removed)
            })?;
        }
        Ok(())
    }
    pub fn capture(&self, env: &Env, value: LiveValue<'_>) -> Result<Value> {
        match value.kind()? {
            sys::ValueType::napi_undefined
            | sys::ValueType::napi_null
            | sys::ValueType::napi_boolean
            | sys::ValueType::napi_number
            | sys::ValueType::napi_string => Ok(Value::Native(unsafe {
                crate::js_bridge::read_value(env.raw(), value.raw(), 0, &mut Vec::new())
            }?)),
            _ => {
                let id = self
                    .next
                    .get()
                    .checked_add(1)
                    .ok_or_else(|| napi::Error::from_reason("host value slots exhausted"))?;
                self.next.set(id);
                let table = self.table(env)?;
                table.define_key(table.from_value(&JsValue::string(&id.to_string()))?, value)?;
                Ok(Value::Host(Rc::new(Slot {
                    id,
                    retired: self.retired.clone(),
                })))
            }
        }
    }
    pub fn read<'a>(
        &self,
        env: &'a Env,
        anchor: LiveValue<'a>,
        value: &Value,
    ) -> Result<LiveValue<'a>> {
        match value {
            Value::Native(value) => anchor.from_value(value),
            Value::Host(slot) => {
                let table = self.table(env)?;
                table.get_key(table.from_value(&JsValue::string(&slot.id.to_string()))?)
            }
        }
    }
}
impl Drop for Values {
    fn drop(&mut self) {
        unsafe {
            sys::napi_delete_reference(self.env, self.anchor);
        }
    }
}
