//! Live V8 property access and iteration for host interfaces that preserve the
//! source loop's errors, getter order and IteratorClose behavior.
use crate::js_live::LiveValue;
use napi::{check_status, sys, Result, Status};
use std::{ffi::CStr, ptr};

pub(crate) fn is_object(value: LiveValue<'_>) -> Result<bool> {
    Ok(matches!(
        value.kind()?,
        sys::ValueType::napi_object | sys::ValueType::napi_function
    ))
}

pub(crate) fn is_null(value: LiveValue<'_>) -> Result<bool> {
    Ok(value.kind()? == sys::ValueType::napi_null)
}

pub(crate) fn boolean(value: LiveValue<'_>) -> Result<bool> {
    let mut flag = false;
    check_status!(unsafe { sys::napi_get_value_bool(value.env(), value.raw(), &mut flag) })?;
    Ok(flag)
}

/// Throw a TypeError whose message may carry host strings (lone surrogates
/// included), reported back as the pending exception.
pub(crate) fn type_error(env: sys::napi_env, units: &[u16]) -> napi::Error {
    let mut message = ptr::null_mut();
    let mut error = ptr::null_mut();
    unsafe {
        if sys::napi_create_string_utf16(env, units.as_ptr(), units.len() as isize, &mut message)
            == sys::Status::napi_ok
            && sys::napi_create_type_error(env, ptr::null_mut(), message, &mut error)
                == sys::Status::napi_ok
        {
            sys::napi_throw(env, error);
        }
    }
    napi::Error::new(Status::PendingException, "host TypeError")
}

fn utf16(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// ToString(value) for primitives; strings return their own code units.
fn printed_units(value: LiveValue<'_>) -> Result<Vec<u16>> {
    if value.kind()? == sys::ValueType::napi_string {
        return Ok(value.string()?.unwrap_or_default().into_units());
    }
    Ok(value.coerce_string()?.into_units())
}

/// The way V8 prints a non-callable in "<value> is not a function".
fn print_non_callable(value: LiveValue<'_>) -> Result<Vec<u16>> {
    Ok(match value.kind()? {
        sys::ValueType::napi_undefined => utf16("undefined"),
        sys::ValueType::napi_null => utf16("object null"),
        sys::ValueType::napi_boolean => utf16(if boolean(value)? {
            "boolean true"
        } else {
            "boolean false"
        }),
        sys::ValueType::napi_number => {
            let mut units = utf16("number ");
            units.extend(printed_units(value)?);
            units
        }
        sys::ValueType::napi_string => {
            let mut units = utf16("string \"");
            units.extend(value.string()?.unwrap_or_default().into_units());
            units.extend(utf16("\""));
            units
        }
        sys::ValueType::napi_symbol => utf16("symbol"),
        sys::ValueType::napi_bigint => utf16("bigint"),
        _ => utf16("object"),
    })
}

/// The way V8 prints a primitive in "Iterator result <value> is not an object"
/// (symbols go through `String(symbol)`).
fn print_primitive(value: LiveValue<'_>) -> Result<Vec<u16>> {
    Ok(match value.kind()? {
        sys::ValueType::napi_undefined => utf16("undefined"),
        sys::ValueType::napi_null => utf16("null"),
        sys::ValueType::napi_boolean => utf16(if boolean(value)? { "true" } else { "false" }),
        sys::ValueType::napi_symbol => value
            .global()?
            .get(c"String")?
            .call_plain(&[value])?
            .string()?
            .unwrap_or_default()
            .into_units(),
        sys::ValueType::napi_object | sys::ValueType::napi_function => utf16("object"),
        _ => printed_units(value)?,
    })
}

/// `target[name]` with V8's own TypeError text for nullish receivers.
pub(crate) fn read<'env>(target: LiveValue<'env>, name: &CStr) -> Result<LiveValue<'env>> {
    let kind = target.kind()?;
    if matches!(
        kind,
        sys::ValueType::napi_undefined | sys::ValueType::napi_null
    ) {
        let receiver = if kind == sys::ValueType::napi_undefined {
            "undefined"
        } else {
            "null"
        };
        return Err(target.type_error(&format!(
            "Cannot read properties of {receiver} (reading '{}')",
            name.to_str().expect("static property")
        )));
    }
    read_property(target, name)
}

/// The receiver was already checked, so there is no nullish error to format.
pub(crate) fn read_property<'env>(target: LiveValue<'env>, name: &CStr) -> Result<LiveValue<'env>> {
    let env = target.env();
    let mut value = ptr::null_mut();
    check_status!(unsafe {
        sys::napi_get_named_property(env, target.raw(), name.as_ptr(), &mut value)
    })?;
    Ok(LiveValue::from_raw(env, value))
}

/// `Call(f, receiver, args)`; a non-callable gets V8's TypeError text.
pub(crate) fn call<'env>(
    f: LiveValue<'env>,
    receiver: LiveValue<'env>,
    arguments: &[LiveValue<'env>],
) -> Result<LiveValue<'env>> {
    if f.kind()? != sys::ValueType::napi_function {
        let mut units = print_non_callable(f)?;
        units.extend(utf16(" is not a function"));
        return Err(type_error(f.env(), &units));
    }
    f.call(receiver, arguments)
}

#[derive(Clone, Copy)]
pub(crate) struct IteratorRecord<'env> {
    iterator: LiveValue<'env>,
    next: LiveValue<'env>,
}

/// GetIterator for a for-of head. `not_iterable` is the site constant; a
/// nullish iterable has no `Symbol.iterator` to read and takes that branch.
impl<'env> IteratorRecord<'env> {
    pub(crate) fn open(
        value: LiveValue<'env>,
        not_iterable: &CStr,
        iterator_key: impl FnOnce() -> Result<LiveValue<'env>>,
    ) -> Result<Self> {
        if value.nullish()? {
            return Err(value.type_error(not_iterable.to_str().expect("static message")));
        }
        let method = value.get_key(iterator_key()?)?;
        if method.kind()? != sys::ValueType::napi_function {
            return Err(value.type_error(not_iterable.to_str().expect("static message")));
        }
        let iterator = call(method, value, &[])?;
        if !is_object(iterator)? {
            return Err(type_error(
                iterator.env(),
                &utf16("Result of the Symbol.iterator method is not an object"),
            ));
        }
        let next = read(iterator, c"next")?;
        Ok(IteratorRecord { iterator, next })
    }

    /// One IteratorStep: `next()` once, `done` per step, `value` only while
    /// not done.
    fn step(self) -> Result<Option<LiveValue<'env>>> {
        let result = call(self.next, self.iterator, &[])?;
        if !is_object(result)? {
            let mut units = utf16("Iterator result ");
            units.extend(print_primitive(result)?);
            units.extend(utf16(" is not an object"));
            return Err(type_error(result.env(), &units));
        }
        if read_property(result, c"done")?.truthy()? {
            Ok(None)
        } else {
            Ok(Some(read_property(result, c"value")?))
        }
    }

    /// IteratorClose after the body threw: `return` runs best-effort and the
    /// original exception always wins, whatever `return` does.
    fn close_after_throw(self) -> Result<()> {
        let env = self.iterator.env();
        let mut pending = false;
        check_status!(unsafe { sys::napi_is_exception_pending(env, &mut pending) })?;
        let mut exception = ptr::null_mut();
        if pending {
            check_status!(unsafe { sys::napi_get_and_clear_last_exception(env, &mut exception) })?;
        }
        let _ = self.iterator.catch(|| {
            let method = read(self.iterator, c"return")?;
            if method.nullish()? || method.kind()? != sys::ValueType::napi_function {
                return Ok(());
            }
            call(method, self.iterator, &[])?;
            Ok(())
        });
        if !exception.is_null() {
            unsafe {
                sys::napi_throw(env, exception);
            }
        }
        Ok(())
    }
    pub(crate) fn for_each(
        self,
        mut visit: impl FnMut(LiveValue<'env>) -> Result<()>,
    ) -> Result<()> {
        while let Some(item) = self.step()? {
            if let Err(error) = visit(item) {
                let _ = self.close_after_throw();
                return Err(error);
            }
        }
        Ok(())
    }
}
