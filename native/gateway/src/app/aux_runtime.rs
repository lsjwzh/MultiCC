//! Owns the standalone gateway's persistent background queue and worker set.
use super::{
    aux_transport,
    express::{self, RequestCtx},
    App,
};
use axum::{body::Body, http::Response};
use multicc_core::{
    aux_jobs::Queue,
    http_gate::{query_string, query_value},
    js::serde::truthy,
    orchestration_routes::Route,
    provider_store,
    random_id::random_uuid_v4,
};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{Arc, Mutex},
};
use tokio::sync::{watch, Notify};

pub(crate) struct Runtime {
    db: Mutex<Queue>,
    wake: Notify,
    events: tokio::sync::broadcast::Sender<Value>,
    changes: watch::Sender<()>,
    // Held throughout the lifetime of every worker, including blocking writes.
    _ownership: std::fs::File,
}
impl Runtime {
    pub(crate) fn open(root: &Path) -> Result<Self, String> {
        let ownership = provider_store::lock(&root.join("background-jobs"))?;
        Ok(Self {
            db: Mutex::new(Queue::open(root)?),
            wake: Notify::new(),
            events: tokio::sync::broadcast::channel(64).0,
            changes: watch::channel(()).0,
            _ownership: ownership,
        })
    }
    pub(crate) fn clients(&self) -> usize {
        self.events.receiver_count()
    }
    pub(crate) async fn serve_socket<S>(
        self: &Arc<Self>,
        root: &Path,
        socket: &mut tokio_tungstenite::WebSocketStream<S>,
    ) where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;
        let mut events = self.events.subscribe();
        let root = root.to_owned();
        let Ok((status, history)) = self
            .with_db(move |db| Ok((db.status()?, db.history(&root, 100)?)))
            .await
        else {
            return;
        };
        let timeout = std::time::Duration::from_secs(5);
        for frame in [
            json!({"type":"aux_init","status":status,"health":status["health"]}),
            json!({"type":"aux_history","messages":history}),
        ] {
            if !matches!(
                tokio::time::timeout(timeout, socket.send(Message::text(frame.to_string()))).await,
                Ok(Ok(()))
            ) {
                return;
            }
        }
        loop {
            tokio::select! {
                event=events.recv()=>{let Ok(frame)=event else{break};if !matches!(tokio::time::timeout(timeout,socket.send(Message::text(frame.to_string()))).await,Ok(Ok(()))){break;}}
                frame=socket.next()=>match frame {Some(Ok(Message::Ping(_)))=>{if !matches!(tokio::time::timeout(timeout,socket.flush()).await,Ok(Ok(()))){break;}},Some(Ok(Message::Close(_)))|None|Some(Err(_))=>break,_=>()}
            }
        }
    }
    pub(crate) fn status(&self) -> Result<Value, String> {
        self.db
            .lock()
            .map_err(|_| "Aux queue unavailable")?
            .status()
    }
    async fn with_db<T: Send + 'static>(
        self: &Arc<Self>,
        f: impl FnOnce(&mut Queue) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let runtime = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut db = runtime.db.lock().map_err(|_| "Aux queue unavailable")?;
            f(&mut db)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    pub(super) async fn submit(
        self: &Arc<Self>,
        body: &Value,
        interactive: bool,
    ) -> Result<Value, String> {
        let id = body["id"]
            .as_str()
            .map(str::trim)
            .filter(|s| {
                !s.is_empty()
                    && s.len() <= 80
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            })
            .map(str::to_owned)
            .map(Ok)
            .unwrap_or_else(random_uuid_v4)
            .map_err(|e| e.to_string())?;
        let mut job = json!({"prompt":body["prompt"],"type":body["type"].as_str().filter(|s|!s.is_empty()).unwrap_or("manual"),"meta":body.get("meta").filter(|v|truthy(v)).cloned().unwrap_or(json!({}))});
        if let Some(system) = body.get("systemPrompt") {
            job["systemPrompt"] = system.clone();
        }
        let key = id.clone();
        let mut changes = self.changes.subscribe();
        let lane = if matches!(
            job["type"].as_str(),
            Some("memory_review" | "memory_distill")
        ) {
            "serial"
        } else {
            "pool"
        };
        let task = json!({"id":id,"type":job["type"],"lane":lane,"priority":if interactive{"interactive"}else{"background"},"meta":job["meta"]});
        let (inserted, depth) = self
            .with_db(move |db| {
                let inserted = db.enqueue(&key, &job, interactive)?;
                Ok((inserted, db.status()?["queueDepth"].clone()))
            })
            .await?;
        if inserted {
            let _ = self
                .events
                .send(json!({"type":"aux_event","status":"queued","task":task,"queueDepth":depth}));
        }
        self.wake.notify_one();
        loop {
            let key = id.clone();
            if let Some(answer) = self.with_db(move |db| db.result(&key)).await? {
                return Ok(answer);
            }
            changes
                .changed()
                .await
                .map_err(|_| "server is shutting down")?;
        }
    }
    pub(crate) async fn run(self: Arc<Self>, app: Arc<App>) {
        let mut children = tokio::task::JoinSet::new();
        loop {
            match self.with_db(|db| db.claim()).await {
                Ok(Some((id, job))) => {
                    let root = app.data_root.clone();
                    let home = app.home_dir.clone();
                    let task = json!({"id":id,"type":job["type"],"meta":job["meta"]});
                    let _ = self
                        .events
                        .send(json!({"type":"aux_event","status":"processing","task":task}));
                    let start = std::time::Instant::now();
                    children.spawn(async move {
                        let (meta, result) = aux_transport::execute(root, home, job).await;
                        (id, meta, result, task, start)
                    });
                    continue;
                }
                Err(_) => {
                    eprintln!("[multicc-gateway] Aux claim failed");
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
                Ok(None) => (),
            }
            tokio::select! {
                Some(Ok((id,meta,result,task,start)))=children.join_next(),if !children.is_empty()=>{
                    // If storage is temporarily full, retry the commit, never the upstream call.
                    loop {
                        let (id,meta,result)=(id.clone(),meta.clone(),result.clone());
                        if self.with_db(move|db|db.finish(&id,&meta,&result)).await.is_ok(){break;}
                        eprintln!("[multicc-gateway] Aux result write failed");
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    }
                    if self.events.receiver_count()>0 {
                        let key=id.clone();
                        if let Ok((Some(answer),status))=self.with_db(move|db|Ok((db.result(&key)?,db.status()?))).await{
                            let cancelled=answer["error"]=="cancelled";
                            let mut frame=json!({"type":"aux_event","task":{"id":id,"type":task["type"]},"durationMs":start.elapsed().as_millis(),"status":if result.is_ok()||cancelled{"done"}else{"error"}});
                            if result.is_ok()||cancelled{frame["cancelled"]=cancelled.into();}
                            match result {Ok(text)=>frame["result"]=text.into(),Err(e) if !cancelled=>frame["error"]=e.into(),_=>()}
                            let _=self.events.send(frame);let _=self.events.send(json!({"type":"aux_health","health":status["health"]}));
                        }
                    }
                    self.changes.send_replace(());
                }
                _=self.wake.notified()=>()
            }
        }
    }
}

pub(super) async fn handle(
    app: &Arc<App>,
    ctx: &RequestCtx,
    route: Route,
    body: &Value,
) -> Option<Response<Body>> {
    let rt = app.aux_jobs.get()?;
    let result = match route {
        Route::GoalPrecheck | Route::SettingsGoalGet | Route::SettingsGoalPost => {
            super::aux_goal::handle(app, route, body).await
        }
        Route::AuxConfigPost => {
            let root = app.data_root.clone();
            let home = app.home_dir.clone();
            let v = body.clone();
            tokio::task::spawn_blocking(move || aux_transport::set_config(&root, &home, &v))
                .await
                .map_err(|e| e.to_string())
        }
        Route::AuxEnqueue if !truthy(&body["prompt"]) => {
            Ok((400, json!({"error":"prompt required"})))
        }
        Route::AuxEnqueue => {
            // The public API accepts these four fields. Internal producers can also set a system prompt.
            let job = json!({"id":body["id"], "type":body["type"], "prompt":body["prompt"], "meta":body["meta"]});
            match rt.submit(&job, true).await {
                Err(e) if e == multicc_core::aux_jobs::PAYLOAD_CONFLICT => Ok((
                    409,
                    json!({"ok":false,"error":e,"taskId":body["id"].as_str().map(str::trim)}),
                )),
                result => result.map(|v| (200, v)),
            }
        }
        Route::AuxCancel if !truthy(&body["id"]) => {
            Ok((400, json!({"ok":false,"error":"id required"})))
        }
        Route::AuxCancel => {
            let id = multicc_core::js::js_to_string(&multicc_core::js::from_serde(&body["id"]))
                .to_string_lossy();
            let key = id.clone();
            let r = rt.with_db(move |db| db.cancel(&key)).await;
            if matches!(r, Ok(true)) {
                let _ = rt
                    .events
                    .send(json!({"type":"aux_event","status":"cancelled","task":{"id":id}}));
            }
            rt.changes.send_replace(());
            rt.wake.notify_one();
            r.map(|_| (200, json!({"ok":true})))
        }
        Route::AuxStatus | Route::AuxHealth => rt.with_db(|db| db.status()).await.map(|s| {
            (
                200,
                if route == Route::AuxHealth {
                    json!({"health":s["health"]})
                } else {
                    s
                },
            )
        }),
        Route::AuxHistory => {
            let root = app.data_root.clone();
            let limit = multicc_core::session_git::parse_int10(&query_string(&query_value(
                &ctx.original_url,
                "limit",
            )))
            .filter(|n| *n != 0)
            .unwrap_or(50)
            .min(200);
            rt.with_db(move |db| db.history(&root, limit as i64))
                .await
                .map(|v| (200, v))
        }
        _ => return None,
    };
    Some(match result {
        Ok((code, v)) => express::json(ctx, code, &v, &[]),
        Err(_) => express::error(ctx, 500, "Aux queue unavailable"),
    })
}
