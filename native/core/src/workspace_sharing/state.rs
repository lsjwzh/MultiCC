use super::*;
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex, RwLock},
    time::{Duration, Instant},
};

#[derive(Clone)]
struct Snapshot {
    shares: V,
    external: V,
}
#[derive(Debug)]
pub struct VerifiedAccess {
    owner: Arc<()>,
    record: V,
    token: V,
    created: Instant,
}
impl VerifiedAccess {
    pub fn workspace_id(&self) -> &V {
        get(&self.record, "fleetId")
    }
}
/// Writers serialize crypto and durable state transitions. Readers clone an
/// immutable Arc under a short lock: no synchronous reader waits for scrypt/I/O.
pub struct Store {
    shares_file: Option<PathBuf>,
    external_file: Option<PathBuf>,
    snapshot: RwLock<Arc<Snapshot>>,
    writer: Mutex<()>,
    owner: Arc<()>,
}
fn internal() -> Error {
    Error::new("WORKSPACE_SHARING_INTERNAL", "工作区分享操作失败", 500)
}
fn lookup<'a>(object: &'a V, key: &V) -> &'a V {
    let key = js::js_to_string(key);
    if let V::Object(fields) = object {
        fields
            .iter()
            .find(|(k, _)| k == &key)
            .map(|(_, v)| v)
            .unwrap_or(&V::Undefined)
    } else {
        &V::Undefined
    }
}
fn remove(object: &mut V, key: &V) {
    let key = js::js_to_string(key);
    if let V::Object(fields) = object {
        fields.retain(|(k, _)| k != &key);
    }
}
fn load(file: &PathBuf) -> V {
    fs::read(file)
        .ok()
        .and_then(|b| js::json_parse(&String::from_utf8_lossy(&b)).ok())
        .map(|v| object(&v))
        .unwrap_or(V::Object(vec![]))
}
fn or(value: &V, fallback: V) -> V {
    if truth(value) {
        value.clone()
    } else {
        fallback
    }
}
fn copy_sessions(value: &V) -> V {
    // Preserve the old `{ ...session }` projection for legacy cache entries.
    V::Array(
        array(value)
            .iter()
            .map(|value| match value {
                V::Object(_) => value.clone(),
                V::Array(items) => V::Object(
                    items
                        .iter()
                        .enumerate()
                        .map(|(i, v)| (i.to_string().into(), v.clone()))
                        .collect(),
                ),
                V::String(s) => V::Object(
                    s.as_units()
                        .iter()
                        .enumerate()
                        .map(|(i, u)| {
                            (
                                i.to_string().into(),
                                V::String(JsString::from_units(vec![*u])),
                            )
                        })
                        .collect(),
                ),
                _ => V::Object(vec![]),
            })
            .collect(),
    )
}
fn public_share(record: &V, now: f64) -> V {
    let count = or(get(record, "accessCount"), 0.0.into());
    let mut v = V::Object(vec![]);
    for key in ["token", "fleetId"] {
        put(&mut v, key, get(record, key).clone());
    }
    put(
        &mut v,
        "description",
        or(get(record, "description"), V::string("")),
    );
    for key in ["createdAt", "expiresAt", "maxAccesses"] {
        put(&mut v, key, get(record, key).clone());
    }
    put(&mut v, "accessCount", count.clone());
    let remaining = number(get(record, "maxAccesses")) - number(&count);
    put(
        &mut v,
        "remainingAccesses",
        if remaining.is_nan() {
            V::Number(f64::NAN)
        } else {
            remaining.max(0.0).into()
        },
    );
    put(
        &mut v,
        "expired",
        V::Bool(now > number(get(record, "expiresAt"))),
    );
    v
}
fn public_external(record: &V) -> V {
    let mut v = V::Object(vec![]);
    put(&mut v, "id", get(record, "id").clone());
    put(
        &mut v,
        "name",
        or(get(record, "alias"), get(record, "remoteName").clone()),
    );
    put(&mut v, "alias", or(get(record, "alias"), V::string("")));
    put(&mut v, "remoteName", get(record, "remoteName").clone());
    put(
        &mut v,
        "description",
        or(get(record, "description"), V::string("")),
    );
    for key in [
        "sourceOrigin",
        "shareUrl",
        "sourceInstanceId",
        "sourceFleetId",
    ] {
        put(&mut v, key, get(record, key).clone());
    }
    put(&mut v, "sessions", copy_sessions(get(record, "sessions")));
    let count = get(record, "sessionCount");
    put(
        &mut v,
        "sessionCount",
        if matches!(count,V::Number(n) if n.is_finite() && n.fract()==0.0) {
            count.clone()
        } else {
            0.0.into()
        },
    );
    put(
        &mut v,
        "interactive",
        V::Bool(token_valid(get(record, "remoteToken")) && grant_valid(get(record, "remoteGrant"))),
    );
    for key in ["importedAt", "refreshedAt"] {
        put(&mut v, key, get(record, key).clone());
    }
    v
}
fn sorted(mut values: Vec<V>, key: &str) -> V {
    values.sort_by(|a, b| {
        number(get(b, key))
            .partial_cmp(&number(get(a, key)))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    V::Array(values)
}
impl Snapshot {
    fn record(&self, token: &V, now: f64) -> Result<&V> {
        let record = lookup(get(&self.shares, "shares"), token);
        if !truth(record) || now > number(get(record, "expiresAt")) {
            Err(Error::new("SHARE_NOT_FOUND", "分享不存在或已失效", 404))
        } else {
            Ok(record)
        }
    }
    fn authorized(&self, input: &V, now: f64) -> Result<&V> {
        let record = self.record(get(input, "token"), now)?;
        if !secret_matches(get(input, "grant"), get(record, "accessGrant")) {
            return Err(Error::new("FLEET_SCOPE_FORBIDDEN", "工作区授权无效", 403));
        }
        Ok(record)
    }
}
impl Store {
    pub fn open(shares_file: PathBuf, external_file: PathBuf) -> Result<Self> {
        Self::open_owned(Some(shares_file), Some(external_file))
    }
    pub fn open_source(file: PathBuf) -> Result<Self> {
        Self::open_owned(Some(file), None)
    }
    pub fn open_external(file: PathBuf) -> Result<Self> {
        Self::open_owned(None, Some(file))
    }
    fn open_owned(shares_file: Option<PathBuf>, external_file: Option<PathBuf>) -> Result<Self> {
        let shares = shares_file.as_ref().map(load).unwrap_or(V::Null);
        let external = external_file.as_ref().map(load).unwrap_or(V::Null);
        let id = clean(get(&shares, "instanceId"), 128, "");
        let id = if truth(&id) {
            id
        } else if shares_file.is_some() {
            V::string(&format!("instance_{}", random(12)?))
        } else {
            V::Null
        };
        Ok(Self {
            shares_file,
            external_file,
            snapshot: RwLock::new(Arc::new(Snapshot {
                shares: V::object(vec![
                    ("schemaVersion", SCHEMA_VERSION.into()),
                    ("instanceId", id),
                    ("shares", object(get(&shares, "shares"))),
                ]),
                external: V::object(vec![
                    ("schemaVersion", SCHEMA_VERSION.into()),
                    ("fleets", object(get(&external, "fleets"))),
                ]),
            })),
            writer: Mutex::new(()),
            owner: Arc::new(()),
        })
    }
    fn read(&self) -> Result<Arc<Snapshot>> {
        Ok(self.snapshot.read().map_err(|_| internal())?.clone())
    }
    fn save(&self, next: Snapshot, external: bool) -> Result<()> {
        let (file, value) = if external {
            (&self.external_file, &next.external)
        } else {
            (&self.shares_file, &next.shares)
        };
        crate::state_file::write_text_atomic(
            file.as_ref().ok_or_else(internal)?,
            &crate::durable_state::pretty(value),
            0o600,
            0o700,
        )
        .map_err(|_| internal())?;
        *self.snapshot.write().map_err(|_| internal())? = Arc::new(next);
        Ok(())
    }
    fn owns(&self, operation: &str) -> Result<()> {
        let external = matches!(
            operation,
            "listExternal"
                | "externalAuthority"
                | "removeExternal"
                | "importExternal"
                | "refreshExternal"
        );
        if (external && self.external_file.is_none()) || (!external && self.shares_file.is_none()) {
            Err(internal())
        } else {
            Ok(())
        }
    }
    /// Pure reads and authority plans; never write files or perform scrypt.
    pub fn query(&self, operation: &str, input: &V, now: f64) -> Result<V> {
        self.owns(operation)?;
        let state = self.read()?;
        match operation {
            "listShares" => Ok(sorted(
                values(get(&state.shares, "shares"))
                    .into_iter()
                    .filter(|r| get(r, "fleetId") == input)
                    .map(|r| public_share(r, now))
                    .collect(),
                "createdAt",
            )),
            "listExternal" => Ok(sorted(
                values(get(&state.external, "fleets"))
                    .into_iter()
                    .map(public_external)
                    .collect(),
                "refreshedAt",
            )),
            "externalAuthority" => {
                let r = lookup(get(&state.external, "fleets"), input);
                if !truth(r)
                    || !token_valid(get(r, "remoteToken"))
                    || !grant_valid(get(r, "remoteGrant"))
                {
                    return Err(Error::new(
                        "EXTERNAL_FLEET_NOT_INTERACTIVE",
                        "该共享工作区需要重新导入后才能操作",
                        409,
                    ));
                }
                Ok(V::object(vec![
                    ("id", get(r, "id").clone()),
                    ("name", or(get(r, "alias"), get(r, "remoteName").clone())),
                    ("remoteName", get(r, "remoteName").clone()),
                    ("sourceOrigin", get(r, "sourceOrigin").clone()),
                    ("sourceFleetId", get(r, "sourceFleetId").clone()),
                    ("token", get(r, "remoteToken").clone()),
                    ("grant", get(r, "remoteGrant").clone()),
                    ("sessions", copy_sessions(get(r, "sessions"))),
                ]))
            }
            "authorizePlan" | "authorizeMembers" => {
                let Ok(record) = state.authorized(input, now) else {
                    return Ok(false.into());
                };
                let plan =
                    authority::plan(record, input, get(input, "webSocket") == &V::Bool(true));
                Ok(if operation == "authorizeMembers" {
                    authority::resolve(plan, input)
                } else {
                    plan
                })
            }
            "payloadPlan" => Ok(get(state.authorized(input, now)?, "fleetId").clone()),
            "payload" => {
                let record = state.authorized(input, now)?;
                let directory = get(input, "directory");
                if !truth(directory) {
                    return Err(Error::new("FLEET_NOT_FOUND", "工作区已不存在", 404));
                }
                let sessions = sessions(get(input, "members"), true);
                let created = clean(&V::string(&or_text(get(directory, "createdAt"))), 64, "");
                Ok(V::object(vec![
                    ("schemaVersion", SCHEMA_VERSION.into()),
                    ("instanceId", get(&state.shares, "instanceId").clone()),
                    (
                        "exportedAt",
                        V::string(&js::json::date_to_iso_string(now).ok_or_else(internal)?),
                    ),
                    (
                        "capability",
                        V::object(vec![
                            ("token", get(input, "token").clone()),
                            ("grant", get(record, "accessGrant").clone()),
                        ]),
                    ),
                    (
                        "fleet",
                        V::object(vec![
                            ("id", get(directory, "id").clone()),
                            ("name", clean(get(directory, "name"), 120, "未命名工作区")),
                            ("description", get(record, "description").clone()),
                            ("createdAt", if truth(&created) { created } else { V::Null }),
                            ("sessionCount", (array(&sessions).len() as f64).into()),
                            ("sessions", sessions),
                        ]),
                    ),
                ]))
            }
            _ => Err(internal()),
        }
    }

    /// Hold publication through the synchronous commit so revocation cannot
    /// publish between the final scope check and ticket insertion. Never await
    /// or enter the host here. Lock order is source snapshot, then auth runtime.
    pub fn with_websocket_authority<T>(
        &self,
        input: &V,
        now: f64,
        commit: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        self.owns("authorizeMembers")?;
        let state = self.snapshot.read().map_err(|_| internal())?;
        let allowed = state.authorized(input, now).ok().is_some_and(|record| {
            authority::resolve(authority::plan(record, input, true), input) == V::Bool(true)
        });
        if !allowed {
            return Err(super::source::scope_forbidden());
        }
        commit()
    }
    /// Native, owner-bound verification result. Passing it by value consumes
    /// it once; no nonce table or JSON proof crosses the host boundary.
    pub fn verify_password(&self, input: &V, now: f64) -> Result<VerifiedAccess> {
        self.owns("verifyPassword")?;
        let state = self.read()?;
        let token = get(input, "token");
        let record = state.record(token, now)?;
        let candidate = password(get(input, "password"))
            .map_err(|_| Error::new("WRONG_PASSWORD", "密码错误", 403))?;
        if !password_matches(&candidate, record) {
            return Err(Error::new("WRONG_PASSWORD", "密码错误", 403));
        }
        if number(&or(get(record, "accessCount"), 0.0.into())) >= number(get(record, "maxAccesses"))
        {
            return Err(Error::new("SHARE_EXHAUSTED", "分享访问次数已用完", 410));
        }
        Ok(VerifiedAccess {
            owner: Arc::clone(&self.owner),
            record: record.clone(),
            token: token.clone(),
            created: Instant::now(),
        })
    }
    pub fn consume_access(&self, proof: VerifiedAccess, directory: bool, now: f64) -> Result<V> {
        self.owns("consumeAccess")?;
        if !Arc::ptr_eq(&self.owner, &proof.owner)
            || proof.created.elapsed() >= Duration::from_secs(30)
        {
            return Err(internal());
        }
        let _guard = self.writer.lock().map_err(|_| internal())?;
        let mut state = (*self.read()?).clone();
        let record = state.record(&proof.token, now)?;
        for key in ["fleetId", "passwordHash", "salt", "expiresAt"] {
            if get(record, key) != get(&proof.record, key) {
                return Err(Error::new("SHARE_NOT_FOUND", "分享不存在或已失效", 404));
            }
        }
        let count = or(get(record, "accessCount"), 0.0.into());
        if number(&count) >= number(get(record, "maxAccesses")) {
            return Err(Error::new("SHARE_EXHAUSTED", "分享访问次数已用完", 410));
        }
        if !directory {
            return Err(Error::new("FLEET_NOT_FOUND", "工作区已不存在", 404));
        }
        let mut record = record.clone();
        let count = if matches!(count, V::String(_)) {
            V::string(&format!("{}1", text(&count)))
        } else {
            (number(&count) + 1.0).into()
        };
        put(&mut record, "accessCount", count);
        if !grant_valid(get(&record, "accessGrant")) {
            put(&mut record, "accessGrant", V::string(&random(32)?));
        }
        let result = V::object(vec![
            ("token", proof.token.clone()),
            ("grant", get(&record, "accessGrant").clone()),
        ]);
        let mut shares = get(&state.shares, "shares").clone();
        put_key(&mut shares, js::js_to_string(&proof.token), record);
        put(&mut state.shares, "shares", shares);
        self.save(state, false)?;
        Ok(result)
    }
    pub fn mutate(&self, operation: &str, input: &V, now: f64) -> Result<V> {
        self.owns(operation)?;
        let _guard = self.writer.lock().map_err(|_| internal())?;
        let mut state = (*self.read()?).clone();
        match operation {
            "createShare" => {
                if !truth(get(input, "directory")) {
                    return Err(Error::new("FLEET_NOT_FOUND", "工作区不存在", 404));
                }
                let options = get(input, "options");
                let password = password(get(options, "password"))?;
                let days = positive(get(options, "expiresInDays"), 1.0, 365.0, 7.0, "有效天数")?;
                let max = positive(get(options, "maxAccesses"), 1.0, 10000.0, 10.0, "访问次数")?;
                let token = format!("fleet_share_{}", random(24)?);
                let mut salt = [0u8; 16];
                getrandom::fill(&mut salt).map_err(|_| internal())?;
                let salt: String = salt.iter().map(|v| format!("{v:02x}")).collect();
                let record = V::object(vec![
                    ("token", V::string(&token)),
                    ("fleetId", get(input, "id").clone()),
                    ("description", clean(get(options, "description"), 500, "")),
                    ("createdAt", now.into()),
                    ("expiresAt", (now + days * 86400000.0).into()),
                    ("maxAccesses", max.into()),
                    ("accessCount", 0.0.into()),
                    ("accessGrant", V::string(&random(32)?)),
                    ("salt", V::string(&salt)),
                    ("passwordHash", V::string(&hash(&password, &salt)?)),
                ]);
                let result = public_share(&record, now);
                let mut shares = get(&state.shares, "shares").clone();
                put(&mut shares, &token, record);
                put(&mut state.shares, "shares", shares);
                self.save(state, false)?;
                Ok(result)
            }
            "revokeShare" => {
                let token = get(input, "token");
                let record = lookup(get(&state.shares, "shares"), token);
                if !truth(record) {
                    return Ok(false.into());
                }
                if get(record, "fleetId") != get(input, "id") {
                    return Err(Error::new(
                        "SHARE_FLEET_MISMATCH",
                        "分享不属于该工作区",
                        400,
                    ));
                }
                let mut shares = get(&state.shares, "shares").clone();
                remove(&mut shares, token);
                put(&mut state.shares, "shares", shares);
                self.save(state, false)?;
                Ok(true.into())
            }
            "removeExternal" => {
                let mut records = get(&state.external, "fleets").clone();
                if !truth(lookup(&records, input)) {
                    return Ok(false.into());
                }
                remove(&mut records, input);
                put(&mut state.external, "fleets", records);
                self.save(state, true)?;
                Ok(true.into())
            }
            "importExternal" => {
                let remote = validate_payload(get(input, "payload"))?;
                let old = values(get(&state.external, "fleets"))
                    .into_iter()
                    .find(|r| {
                        get(r, "sourceInstanceId") == get(&remote, "sourceInstanceId")
                            && get(r, "sourceFleetId") == get(&remote, "sourceFleetId")
                    });
                let id = if let Some(r) = old {
                    get(r, "id").clone()
                } else {
                    V::string(&format!("external_{}", random(12)?))
                };
                let alias = clean(get(input, "alias"), 120, "");
                let mut record = remote;
                put(&mut record, "id", id.clone());
                put(
                    &mut record,
                    "alias",
                    if truth(&alias) {
                        alias
                    } else {
                        old.map(|r| or(get(r, "alias"), V::string("")))
                            .unwrap_or(V::string(""))
                    },
                );
                put(
                    &mut record,
                    "sourceOrigin",
                    get(input, "sourceOrigin").clone(),
                );
                put(&mut record, "shareUrl", get(input, "shareUrl").clone());
                put(
                    &mut record,
                    "importedAt",
                    old.map(|r| get(r, "importedAt").clone())
                        .unwrap_or(now.into()),
                );
                put(&mut record, "refreshedAt", now.into());
                let result = public_external(&record);
                let mut records = get(&state.external, "fleets").clone();
                put_key(&mut records, js::js_to_string(&id), record);
                put(&mut state.external, "fleets", records);
                self.save(state, true)?;
                Ok(result)
            }
            "refreshExternal" => {
                let remote = validate_payload(get(input, "payload"))?;
                let id = get(input, "id");
                let current = lookup(get(&state.external, "fleets"), id);
                if !truth(current) {
                    return Err(Error::new(
                        "EXTERNAL_FLEET_NOT_FOUND",
                        "共享工作区不存在",
                        404,
                    ));
                }
                if get(&remote, "sourceInstanceId") != get(current, "sourceInstanceId")
                    || get(&remote, "sourceFleetId") != get(current, "sourceFleetId")
                {
                    return Err(Error::new(
                        "INVALID_REMOTE_RESPONSE",
                        "远端工作区身份发生变化",
                        502,
                    ));
                }
                let mut record = current.clone();
                for key in ["remoteName", "description", "sessions", "sessionCount"] {
                    put(&mut record, key, get(&remote, key).clone());
                }
                put(&mut record, "refreshedAt", now.into());
                let result = public_external(&record);
                let mut records = get(&state.external, "fleets").clone();
                put_key(&mut records, js::js_to_string(id), record);
                put(&mut state.external, "fleets", records);
                self.save(state, true)?;
                Ok(result)
            }
            _ => Err(internal()),
        }
    }
}
