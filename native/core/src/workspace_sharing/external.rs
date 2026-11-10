//! Imported workspace ownership and operations, independent of any HTTP/VM host.
//! The gateway owns this file; the source-sharing addon never opens it.
use super::{
    transport::{self, Response, Upload},
    *,
};
use std::{path::PathBuf, sync::Arc};

fn clock(now: Option<f64>) -> f64 {
    now.unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as f64
    })
}

pub struct Runtime {
    store: Arc<Store>,
}
/// One remote workspace-sharing call. The transport consumes it as the
/// `{kind, record, request, context}` envelope.
struct RemoteCall<'a> {
    kind: &'a str,
    record: V,
    request: V,
    context: V,
}
impl Runtime {
    pub fn open(file: PathBuf) -> Result<Self> {
        Ok(Self {
            store: Arc::new(Store::open_external(file)?),
        })
    }
    pub fn query(&self, operation: &str, input: &V, now: f64) -> Result<V> {
        self.store.query(operation, input, now)
    }
    async fn mutate(&self, operation: &'static str, input: V, now: f64) -> Result<V> {
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || store.mutate(operation, &input, now))
            .await
            .map_err(|_| Error::new("WORKSPACE_SHARING_INTERNAL", "工作区分享操作失败", 500))?
    }
    async fn remote(
        &self,
        call: RemoteCall<'_>,
        body: Option<Vec<u8>>,
        stream: Option<Upload>,
        timeout: f64,
    ) -> Result<Response> {
        let RemoteCall {
            kind,
            record,
            request,
            context,
        } = call;
        transport::execute(
            V::object(vec![
                ("kind", V::string(kind)),
                ("record", record),
                ("request", request),
                ("context", context),
            ]),
            body,
            stream,
            timeout,
        )
        .await
    }
    async fn refresh(&self, id: &V, context: V, now: Option<f64>, timeout: f64) -> Result<V> {
        let record = self.query("externalAuthority", id, clock(now))?;
        let payload = self
            .remote(
                RemoteCall {
                    kind: "refresh",
                    record,
                    request: V::Null,
                    context,
                },
                None,
                None,
                timeout,
            )
            .await?
            .value;
        self.mutate(
            "refreshExternal",
            V::object(vec![("id", id.clone()), ("payload", payload)]),
            clock(now),
        )
        .await
    }
    pub async fn operate(
        &self,
        operation: &str,
        input: V,
        body: Option<Vec<u8>>,
        stream: Option<Upload>,
        now: Option<f64>,
        timeout: f64,
    ) -> Result<Response> {
        let id = get(&input, "id");
        let request = get(&input, "request");
        let context = get(&input, "context").clone();
        let value = match operation {
            "importExternal" => {
                let payload = self
                    .remote(
                        RemoteCall {
                            kind: "import",
                            record: V::Null,
                            request: request.clone(),
                            context,
                        },
                        None,
                        None,
                        timeout,
                    )
                    .await?
                    .value;
                let parsed = remote::normalize_url(get(request, "shareUrl"))?;
                self.mutate(
                    "importExternal",
                    V::object(vec![
                        ("payload", payload),
                        ("alias", get(request, "alias").clone()),
                        ("sourceOrigin", get(&parsed, "origin").clone()),
                        (
                            "shareUrl",
                            V::string(js::string::js_trim(&text(get(request, "shareUrl")))),
                        ),
                    ]),
                    clock(now),
                )
                .await?
            }
            "refreshExternal" => self.refresh(id, context, now, timeout).await?,
            "removeExternal" => {
                self.mutate("removeExternal", id.clone(), clock(now))
                    .await?
            }
            "issueExternalWsTicket" => {
                let record = self.query("externalAuthority", id, clock(now))?;
                self.remote(
                    RemoteCall {
                        kind: "ticket",
                        record,
                        request: request.clone(),
                        context,
                    },
                    None,
                    None,
                    timeout,
                )
                .await?
                .value
            }
            "proxyExternal" => {
                let record = self.query("externalAuthority", id, clock(now))?;
                let method = if truth(get(request, "method")) {
                    text(get(request, "method")).to_uppercase()
                } else {
                    "GET".into()
                };
                let result = self
                    .remote(
                        RemoteCall {
                            kind: "proxy",
                            record,
                            request: request.clone(),
                            context,
                        },
                        body,
                        stream,
                        timeout,
                    )
                    .await?;
                if (200.0..300.0).contains(&number(get(&result.value, "status")))
                    && method != "GET"
                    && method != "HEAD"
                {
                    // The mutation already succeeded. Cache refresh is best effort.
                    let _ = self.refresh(id, V::Null, now, timeout).await;
                }
                return Ok(result);
            }
            _ => {
                return Err(Error::new(
                    "WORKSPACE_SHARING_INTERNAL",
                    "工作区分享操作失败",
                    500,
                ))
            }
        };
        Ok(Response {
            value,
            bytes: vec![],
        })
    }
    /// Legacy dashboard projections are local cache reads, never remote HTTP.
    pub fn projection(&self, id: &V, pathname: &str, now: f64) -> Result<Option<V>> {
        let is_sessions = pathname == "/api/sessions" || pathname.starts_with("/api/sessions?");
        let is_directories =
            pathname == "/api/directories" || pathname.starts_with("/api/directories?");
        if !is_sessions && !is_directories {
            return Ok(None);
        }
        let record = self.query("externalAuthority", id, now)?;
        Ok(Some(if is_sessions {
            V::Array(
                array(get(&record, "sessions"))
                    .iter()
                    .map(|session| {
                        let mut value = object(session);
                        put(&mut value, "dirId", get(&record, "sourceFleetId").clone());
                        value
                    })
                    .collect(),
            )
        } else {
            V::Array(vec![V::object(vec![
                ("id", get(&record, "sourceFleetId").clone()),
                ("name", get(&record, "name").clone()),
                ("path", get(&record, "sourceOrigin").clone()),
                ("external", true.into()),
            ])])
        }))
    }
}
