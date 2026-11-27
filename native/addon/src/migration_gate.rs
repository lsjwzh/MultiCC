//! Blocking pre-boot migration. The Node worker owns its temporary listener;
//! the normal HTTP host may start only after that worker relinquishes the port.
use crate::{route_response::*, task_store};
use napi_derive::napi;

#[napi]
pub fn task_migration_gate(
    env: Env,
    options: Unknown<'_>,
    system: bool,
) -> Result<sys::napi_value> {
    let opts = L::new(&env, options);
    let file = opts.get(c"file")?;
    let path = file.coerce_string()?.to_string_lossy();
    let addon = opts.get(c"addon")?;
    let pending = if system {
        task_store::task_store_migration_pending(path.clone())
    } else {
        addon.optional(c"taskStoreMigrationPending")?.kind()? == sys::ValueType::napi_function
            && call(addon, c"taskStoreMigrationPending", &[file])?.truthy()?
    };
    if !pending {
        let _ = std::fs::remove_file(format!("{path}.migration.json"));
        return Ok(fields(opts, &[("migrated", flag(opts, false)?)])?.raw());
    }
    let logger = opts.get(c"logger")?;
    call(
        logger,
        c"info",
        &[text(
            opts,
            "[multicc] 正在把任务数据升级到 v2（仅此一次，期间端口只提供升级进度）",
        )?],
    )?;
    let page = opts.get(c"openPage")?.call_plain(&[fields(
        opts,
        &[
            ("file", file),
            ("port", opts.get(c"port")?),
            ("host", opts.get(c"host")?),
        ],
    )?])?;
    let sleep = |ms: u64| -> Result<()> {
        let sleeper = opts.get(c"sleep")?;
        if sleeper.undefined()? {
            std::thread::sleep(std::time::Duration::from_millis(ms));
        } else {
            sleeper.call_plain(&[num(opts, ms as f64)?])?;
        }
        Ok(())
    };
    loop {
        let migrated = (|| -> Result<L<'_>> {
            let json = if system {
                text(opts, &task_store::migrate_task_store(path.clone())?)?
            } else {
                call(addon, c"migrateTaskStore", &[file])?
            };
            let report = call(opts.global()?.get(c"JSON")?, c"parse", &[json])?;
            call(
                logger,
                c"info",
                &[text(opts, "[multicc] 任务仓储已升级到 v2")?, report],
            )?;
            if !page.nullish()? {
                call(page, c"stop", &[])?;
            }
            fields(opts, &[("migrated", flag(opts, true)?), ("report", report)])
        })();
        let error = match migrated {
            Ok(report) => return Ok(report.raw()),
            Err(error) => error,
        };
        let cause = match opts.exception_value()? {
            Some(e) => e,
            None => opts
                .global()?
                .get(c"Error")?
                .construct(&[text(opts, &error.reason)?])?,
        };
        let message = cause.optional(c"message")?;
        let detail = string(if message.truthy()? { message } else { cause })?
            .coerce_string()?
            .to_string_lossy();
        let retry = detail.contains("task_store_migration_needs_space");
        let suffix = if retry {
            "；腾出磁盘空间后 30 秒内自动重试"
        } else {
            ""
        };
        call(
            logger,
            c"error",
            &[text(
                opts,
                &format!(
                    "[multicc] 任务数据升级未完成，数据没有改动：{}{suffix}",
                    message.coerce_string()?.to_string_lossy()
                ),
            )?],
        )?;
        if !page.nullish()? {
            call(
                page,
                c"fail",
                &[fields(
                    opts,
                    &[("error", message), ("retrying", flag(opts, retry)?)],
                )?],
            )?;
        }
        if !retry {
            loop {
                sleep(3600000)?;
            }
        }
        sleep(30000)?;
        if !page.nullish()? {
            call(page, c"fail", &[null(opts)?])?;
        }
    }
}
