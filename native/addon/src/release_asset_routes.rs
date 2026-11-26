//! Release-asset dependency contracts and host route registration. The gateway
//! owns the public routes, while these callbacks borrow live host services.
use crate::{host_methods::method, js_iteration::read, js_live::invoke, route_response::*};
use napi_derive::napi;
use std::ffi::CStr;

fn assert_dependencies(deps: L<'_>) -> Result<()> {
    if !deps.truthy()? || deps.kind()? != sys::ValueType::napi_object {
        return Err(deps.type_error("system route dependencies are required"));
    }
    for (name, methods, message) in [
        (
            c"apkDistribution",
            [c"info", c"downloadHandler"],
            "system route APK distribution runtime is required",
        ),
        (
            c"iosOta",
            [c"info", c"manifestHandler"],
            "system route iOS OTA runtime is required",
        ),
    ] {
        if !deps.get(name)?.truthy()? {
            return Err(deps.type_error(message));
        }
        for method in methods {
            if deps.get(name)?.get(method)?.kind()? != sys::ValueType::napi_function {
                return Err(deps.type_error(message));
            }
        }
    }
    Ok(())
}

fn info<'a>(deps: L<'a>, service: &CStr, site: &str) -> Result<L<'a>> {
    let runtime = read(deps, service)?;
    invoke(runtime, read(runtime, c"info")?, &[], site)
}

#[napi]
pub fn release_asset_apk_info(env: Env, deps: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(info(
        L::new(&env, deps),
        c"apkDistribution",
        "deps.apkDistribution.info",
    )?
    .raw())
}

#[napi]
pub fn release_asset_ios_handler(env: Env, deps: Unknown<'_>) -> Result<sys::napi_value> {
    let deps = L::new(&env, deps);
    let handler = method(&env, deps, "iosOtaInfoHandler", 3, 3, |deps, args| {
        let res = args[1];
        let operation = (|| {
            let json = read(res, c"json")?;
            let value = info(deps, c"iosOta", "deps.iosOta.info")?;
            invoke(res, json, &[value], "res.json")
        })();
        if let Err(error) = operation {
            let cause = deps.exception_value()?.ok_or(error)?;
            invoke(deps.from_value(&V::Undefined)?, args[2], &[cause], "next")?;
        }
        deps.from_value(&V::Undefined)
    })?;
    Ok(handler.raw())
}

#[napi]
pub fn release_asset_mount(
    env: Env,
    app: Unknown<'_>,
    deps: Unknown<'_>,
    ports: Unknown<'_>,
    download: bool,
) -> Result<()> {
    let app = L::new(&env, app);
    if !app.truthy()?
        || app.get(c"get")?.kind()? != sys::ValueType::napi_function
        || (!download && app.get(c"post")?.kind()? != sys::ValueType::napi_function)
    {
        return Err(app.type_error(if download {
            "Express app.get is required"
        } else {
            "Express app.get and app.post are required"
        }));
    }
    let deps = L::new(&env, deps);
    assert_dependencies(deps)?;
    if download {
        let get = app.get(c"get")?;
        let handler = deps.get(c"apkDistribution")?.get(c"downloadHandler")?;
        get.call(app, &[text(app, "/multicc.apk")?, handler])?;
        return Ok(());
    }
    let ports = L::new(&env, ports);
    for (path, factory) in [
        ("/api/apk-info", c"createApkInfoHandler"),
        ("/api/ios-ota-info", c"createIosOtaInfoHandler"),
    ] {
        let get = app.get(c"get")?;
        let handler = ports.get(factory)?.call_plain(&[deps])?;
        get.call(app, &[text(app, path)?, handler])?;
    }
    let get = app.get(c"get")?;
    get.call(
        app,
        &[
            text(app, "/ios-ota/manifest.plist")?,
            deps.get(c"iosOta")?.get(c"manifestHandler")?,
        ],
    )?;
    let udid = deps.get(c"iosUdid")?;
    let udid = if udid.truthy()? {
        udid
    } else {
        ports.get(c"createIosUdid")?.call_plain(&[])?
    };
    call(udid, c"mountHostRoutes", &[app])?;
    Ok(())
}
