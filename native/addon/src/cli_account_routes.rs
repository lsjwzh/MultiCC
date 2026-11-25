//! Captured CRUD operations on the CLI account store. Release session picks
//! under its persistence transaction before deleting an account.
use crate::route_response::*;
use napi_derive::napi;

fn failed_input<'a>(res: L<'a>, err: L<'a>) -> Result<L<'a>> {
    let known = err.truthy()?
        && string(fallback(err.get(c"code")?, "".into())?)?
            .coerce_string()?
            .as_str_lossy()
            .starts_with("CLI_KEY_ACCOUNT_");
    if known {
        let sender = call(res, c"status", &[num(res, 400.0)?])?;
        return call(
            sender,
            c"json",
            &[fields(
                res,
                &[("ok", flag(res, false)?), ("error", err.get(c"message")?)],
            )?],
        );
    }
    error(res, 500, "账户保存失败", true)
}

#[napi]
pub fn cli_account_response(
    env: Env,
    action: String,
    store: Unknown<'_>,
    allow: Unknown<'_>,
    release: Unknown<'_>,
    req: Unknown<'_>,
    res: Unknown<'_>,
) -> Result<sys::napi_value> {
    let (store, req, res) = (L::new(&env, store), L::new(&env, req), L::new(&env, res));
    let cli = string(fallback(req.get(c"params")?.get(c"cli")?, "".into())?)?;
    let none = req.from_value(&V::Undefined)?;
    if !L::new(&env, allow).call_plain(&[cli])?.truthy()? || !cli.truthy()? {
        error(res, 404, "该 CLI 不支持 API Key 账户", true)?;
        return Ok(none.raw());
    }
    if action == "list" {
        let json = res.get(c"json")?;
        json.call(
            res,
            &[fields(
                res,
                &[
                    ("ok", flag(res, true)?),
                    ("cli", cli),
                    ("accounts", call(store, c"list", &[cli])?),
                ],
            )?],
        )?;
        return Ok(none.raw());
    }
    if action == "delete" {
        let id = string(fallback(req.get(c"params")?.get(c"id")?, "".into())?)?;
        if !call(store, c"has", &[cli, id])?.truthy()? {
            return Ok(error(res, 404, "账户不存在", true)?.raw());
        }
        let result = (|| {
            let released = L::new(&env, release).call_plain(&[cli, id])?;
            call(store, c"remove", &[cli, id])?;
            send(
                res,
                None,
                fields(
                    res,
                    &[("ok", flag(res, true)?), ("releasedSessions", released)],
                )?,
            )
        })();
        if let Err(err) = result {
            res.exception_value()?.ok_or(err)?;
            error(res, 500, "账户删除失败", true)?;
        }
        return Ok(none.raw());
    }
    let body = fallback(req.get(c"body")?, V::Object(vec![]))?;
    let credentials = || {
        fields(
            body,
            &[
                ("label", body.get(c"label")?),
                ("apiKey", body.get(c"apiKey")?),
            ],
        )
    };
    let result = (|| {
        if action == "create" {
            let sender = call(res, c"status", &[num(res, 201.0)?])?;
            let json = sender.get(c"json")?;
            let account = store.get(c"create")?.call(store, &[cli, credentials()?])?;
            json.call(
                sender,
                &[fields(
                    res,
                    &[("ok", flag(res, true)?), ("account", account)],
                )?],
            )?;
        } else {
            let account = store.get(c"update")?.call(
                store,
                &[cli, req.get(c"params")?.get(c"id")?, credentials()?],
            )?;
            if !account.truthy()? {
                return error(res, 404, "账户不存在", true);
            }
            send(
                res,
                None,
                fields(res, &[("ok", flag(res, true)?), ("account", account)])?,
            )?;
        }
        Ok(none)
    })();
    match result {
        Ok(value) => Ok(value.raw()),
        Err(err) => {
            failed_input(res, res.exception_value()?.ok_or(err)?)?;
            Ok(none.raw())
        }
    }
}
