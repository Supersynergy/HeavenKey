use super::*;

#[derive(Clone, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct Reference {
    id: String,
    kind: String,
}

pub(super) struct Workspace {
    id: String,
    pub(super) client: String,
    pub(super) source: String,
    pub(super) origin: String,
    epoch: u64,
    revision: u64,
    references: Vec<Reference>,
    prompt: String,
    until: Instant,
    expires: u64,
    request: Option<String>,
    draft: Option<String>,
    closed: bool,
}
impl Workspace {
    pub(super) fn live(&self, s: &Inner) -> bool {
        !self.closed
            && self.until > Instant::now()
            && s.owner.is_some()
            && self.epoch == s.epoch
            && self.revision == s.revision
            && s.clients.get(&self.client).is_some_and(|c| c.protected)
    }
    fn status(&self, s: &Inner) -> &'static str {
        if self.closed {
            "closed"
        } else if !self.live(s) {
            "expired"
        } else if self.draft.is_some() {
            "drafted"
        } else {
            self.request
                .as_ref()
                .and_then(|id| s.requests.get(id))
                .map_or("published", |p| p.status)
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Publish {
    workspace_id: String,
    client_id: String,
    epoch: u64,
    revision: u64,
    source_id: String,
    origin: String,
    template: String,
    references: Vec<Reference>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceId {
    workspace_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Draft {
    workspace_id: String,
    text: String,
}

fn uuid(s: &str) -> bool {
    Uuid::parse_str(s).is_ok_and(|u| u.hyphenated().to_string() == s && !u.is_nil())
}
fn references_valid(refs: &[Reference]) -> bool {
    refs.len() == 3
        && ["person", "email", "case"]
            .iter()
            .all(|kind| refs.iter().filter(|r| r.kind == *kind).count() == 1)
        && refs.iter().all(|r| uuid(&r.id))
        && refs
            .iter()
            .enumerate()
            .all(|(i, r)| refs[..i].iter().all(|other| other.id != r.id))
}
fn prompt(refs: &[Reference]) -> ApiResult<String> {
    let token = |kind: &str| {
        refs.iter()
            .find(|r| r.kind == kind)
            .map(|r| format!("[[HK:{}]]", r.id))
            .ok_or_else(invalid)
    };
    Ok(format!(
        "Erstelle einen kurzen deutschen Antwortentwurf für {} zur Anfrage {}. Verwende {} als E-Mail-Referenz. Bewahre die Platzhalter unverändert. Keine URLs, kein HTML, keine externen Aktionen.",
        token("person")?,
        token("case")?,
        token("email")?
    ))
}
fn valid_draft(text: &str, refs: &[Reference]) -> bool {
    if text.is_empty()
        || text.len() > 8000
        || text.chars().any(char::is_control)
        || text.contains(['<', '>', '\\'])
        || text.contains("//")
        || text.contains("www.")
    {
        return false;
    }
    let mut rest = text;
    let mut seen = false;
    while let Some(start) = rest.find('[') {
        if rest[..start].contains(']') || unsafe_text(&rest[..start]) {
            return false;
        }
        let Some(token) = rest[start..].strip_prefix("[[HK:") else {
            return false;
        };
        let Some(end) = token.find("]]") else {
            return false;
        };
        if !refs.iter().any(|r| r.id == token[..end]) {
            return false;
        }
        seen = true;
        rest = &token[end + 2..];
    }
    seen && !rest.contains(']') && !unsafe_text(rest)
}
fn unsafe_text(text: &str) -> bool {
    text.contains(':')
        || text.split_whitespace().any(|word| {
            let chars: Vec<_> = word.chars().collect();
            chars
                .windows(3)
                .any(|w| w[0].is_alphanumeric() && w[1] == '.' && w[2].is_alphanumeric())
        })
}
impl Inner {
    fn close_workspace(&mut self, id: &str) {
        let request = self.workspaces.get_mut(id).and_then(|w| {
            w.closed = true;
            w.request.clone()
        });
        if let Some(p) = request.and_then(|id| self.requests.get_mut(&id)) {
            p.status = "denied";
            if let Some(j) = p.session.take().and_then(|sid| self.jobs.remove(&sid)) {
                j.cancel.store(true, Ordering::SeqCst);
            }
        }
    }
    pub(super) fn sweep_workspaces(&mut self) {
        let expired: Vec<_> = self
            .workspaces
            .values()
            .filter(|w| !w.live(self))
            .map(|w| w.id.clone())
            .collect();
        for id in expired {
            self.close_workspace(&id);
        }
    }
}
async fn pairing_protected(
    State(app): State<VaultApp>,
    h: HeaderMap,
    Json(_): Json<Empty>,
) -> ApiResult<Json<Value>> {
    access(&app, &h, true)?;
    let mut s = app.broker.state(&app)?;
    if s.owner.is_none() {
        return Err(denied());
    }
    let code = random_secret();
    s.pair = Some(Pairing {
        code: code.clone(),
        expires: Instant::now() + PAIRING_TTL,
        attempts: 0,
    });
    s.protected_pair = true;
    Ok(Json(json!({"code":code,"expires_in":120})))
}
async fn publish(
    State(app): State<VaultApp>,
    h: HeaderMap,
    Json(input): Json<Publish>,
) -> ApiResult<Json<Value>> {
    access(&app, &h, true)?;
    if !uuid(&input.workspace_id)
        || !uuid(&input.client_id)
        || input.source_id.is_empty()
        || input.source_id.len() > 200
        || input.source_id.chars().any(char::is_control)
        || !canonical_origin(&input.origin)
        || input.template != "reply"
        || !references_valid(&input.references)
        || input
            .references
            .iter()
            .any(|r| r.id == input.workspace_id || r.id == input.client_id)
    {
        return Err(invalid());
    }
    let mut s = app.broker.state(&app)?;
    if s.owner.is_none()
        || s.epoch != input.epoch
        || s.revision != input.revision
        || !s.clients.get(&input.client_id).is_some_and(|c| c.protected)
    {
        return Err(denied());
    }
    if s.workspaces.contains_key(&input.workspace_id) {
        return Err(busy());
    }
    // Retain bounded tombstones until the epoch changes so old job IDs cannot be replayed.
    if s.workspaces.len() >= 128 || s.workspaces.values().filter(|w| w.live(&s)).count() >= 32 {
        return Err(busy());
    }
    let id = input.workspace_id;
    let expires = now() + SESSION_TTL;
    let w = Workspace {
        id: id.clone(),
        client: input.client_id,
        source: input.source_id,
        origin: input.origin,
        epoch: input.epoch,
        revision: input.revision,
        prompt: prompt(&input.references)?,
        references: input.references,
        until: Instant::now() + Duration::from_secs(SESSION_TTL),
        expires,
        request: None,
        draft: None,
        closed: false,
    };
    s.workspaces.insert(id.clone(), w);
    Ok(Json(
        json!({"workspace_id":id,"status":"published","expires_at":expires}),
    ))
}
async fn owner_list(State(app): State<VaultApp>, h: HeaderMap) -> ApiResult<Json<Value>> {
    access(&app, &h, true)?;
    let s = app.broker.state(&app)?;
    if s.owner.is_none() {
        return Err(denied());
    }
    Ok(Json(
        json!({"workspaces":s.workspaces.values().map(|w| json!({"workspace_id":w.id,"client_id":w.client,"status":w.status(&s),"expires_at":w.expires,"request_id":w.request,"draft":w.draft})).collect::<Vec<_>>()}),
    ))
}
async fn owner_close(
    State(app): State<VaultApp>,
    h: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> ApiResult<Json<Value>> {
    access(&app, &h, true)?;
    let mut s = app.broker.state(&app)?;
    if s.owner.is_none() || !s.workspaces.contains_key(&id) {
        return Err(denied());
    }
    s.close_workspace(&id);
    Ok(Json(json!({"closed":true})))
}
fn protected_client(s: &mut Inner, h: &HeaderMap) -> ApiResult<Client> {
    let c = s.client(h)?;
    if !c.protected || s.owner.is_none() {
        return Err(denied());
    }
    Ok(c)
}
async fn list(
    State(app): State<VaultApp>,
    h: HeaderMap,
    Json(_): Json<Empty>,
) -> ApiResult<Json<Value>> {
    let mut s = app.broker.state(&app)?;
    let c = protected_client(&mut s, &h)?;
    Ok(Json(
        json!({"workspaces":s.workspaces.values().filter(|w| w.client == c.id && w.live(&s)).map(|w| json!({"workspace_id":w.id,"prompt":w.prompt,"references":w.references,"status":w.status(&s),"expires_at":w.expires})).collect::<Vec<_>>()}),
    ))
}
async fn login(
    State(app): State<VaultApp>,
    h: HeaderMap,
    Json(input): Json<WorkspaceId>,
) -> ApiResult<Json<Value>> {
    let mut s = app.broker.state(&app)?;
    let c = protected_client(&mut s, &h)?;
    let w = s
        .workspaces
        .get(&input.workspace_id)
        .filter(|w| w.client == c.id && w.live(&s))
        .ok_or_else(denied)?;
    if w.request.is_some() {
        return Err(busy());
    }
    if s.requests
        .values()
        .filter(|p| matches!(p.status, "pending" | "running"))
        .count()
        >= 8
    {
        return Err(busy());
    }
    let id = Uuid::new_v4().to_string();
    let until = w.until.min(Instant::now() + Duration::from_secs(120));
    let expires = w.expires.min(now() + 120);
    let origin = w.origin.clone();
    if s.requests.len() >= 32 {
        s.requests
            .retain(|_, p| matches!(p.status, "pending" | "running" | "ready"));
    }
    s.requests.insert(
        id.clone(),
        Pending {
            workspace: Some(input.workspace_id.clone()),
            id: id.clone(),
            client: c.id,
            label: c.label,
            origin,
            status: "pending",
            until,
            expires,
            session: None,
        },
    );
    s.workspaces
        .get_mut(&input.workspace_id)
        .ok_or_else(denied)?
        .request = Some(id.clone());
    s.audit("protected_login", "pending", &id);
    Ok(Json(json!({"request_id":id,"status":"pending"})))
}
async fn draft(
    State(app): State<VaultApp>,
    h: HeaderMap,
    Json(input): Json<Draft>,
) -> ApiResult<Json<Value>> {
    let mut s = app.broker.state(&app)?;
    let c = protected_client(&mut s, &h)?;
    let w = s
        .workspaces
        .get(&input.workspace_id)
        .filter(|w| w.client == c.id && w.live(&s))
        .ok_or_else(denied)?;
    if w.draft.is_some() {
        return Err(busy());
    }
    let ready = w
        .request
        .as_ref()
        .and_then(|id| s.requests.get(id))
        .filter(|p| p.status == "ready")
        .and_then(|p| p.session.as_ref())
        .and_then(|id| s.jobs.get(id))
        .is_some_and(|j| j.protected && j.client == c.id && !j.cancel.load(Ordering::SeqCst));
    if !ready {
        return Err(denied());
    }
    if !valid_draft(&input.text, &w.references) {
        return Err(invalid());
    }
    s.workspaces
        .get_mut(&input.workspace_id)
        .ok_or_else(denied)?
        .draft = Some(input.text);
    Ok(Json(json!({"status":"drafted"})))
}
async fn close(
    State(app): State<VaultApp>,
    h: HeaderMap,
    Json(input): Json<WorkspaceId>,
) -> ApiResult<Json<Value>> {
    let mut s = app.broker.state(&app)?;
    let c = protected_client(&mut s, &h)?;
    if !s
        .workspaces
        .get(&input.workspace_id)
        .is_some_and(|w| w.client == c.id && w.live(&s))
    {
        return Err(denied());
    }
    s.close_workspace(&input.workspace_id);
    Ok(Json(json!({"closed":true})))
}
pub(super) fn routes() -> Router<VaultApp> {
    Router::new()
        .route(
            "/api/password-broker/protected-pairing",
            post(pairing_protected),
        )
        .route(
            "/api/password-broker/protected/workspaces",
            get(owner_list).post(publish),
        )
        .route(
            "/api/password-broker/protected/workspaces/{id}",
            axum::routing::delete(owner_close),
        )
        .route("/api/password-broker/agent/protected-list", post(list))
        .route("/api/password-broker/agent/protected-login", post(login))
        .route("/api/password-broker/agent/protected-draft", post(draft))
        .route("/api/password-broker/agent/protected-close", post(close))
}

#[cfg(test)]
mod tests {
    use super::super::tests::{agent, app, owner};
    use super::*;

    async fn setup(a: &VaultApp) -> (HeaderMap, String) {
        let _ = unlock(State(a.clone()), owner(a), Json(Empty {}))
            .await
            .unwrap();
        add_client(a).await
    }
    async fn add_client(a: &VaultApp) -> (HeaderMap, String) {
        let Json(p) = pairing_protected(State(a.clone()), owner(a), Json(Empty {}))
            .await
            .unwrap();
        let Json(c) = connect(
            State(a.clone()),
            agent(""),
            Json(Connect {
                code: p["code"].as_str().unwrap().into(),
                label: "Protected synthetic".into(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(c["protected"], true);
        (
            agent(c["token"].as_str().unwrap()),
            c["client_id"].as_str().unwrap().into(),
        )
    }
    fn input(a: &VaultApp, client: &str) -> Publish {
        let s = a.broker.state(a).unwrap();
        Publish {
            workspace_id: Uuid::new_v4().to_string(),
            client_id: client.into(),
            epoch: s.epoch,
            revision: s.revision,
            source_id: "private-login-source".into(),
            origin: "https://example.com".into(),
            template: "reply".into(),
            references: ["person", "email", "case"]
                .iter()
                .map(|kind| Reference {
                    id: Uuid::new_v4().to_string(),
                    kind: (*kind).into(),
                })
                .collect(),
        }
    }
    async fn published(a: &VaultApp, client: &str) -> String {
        let p = input(a, client);
        let id = p.workspace_id.clone();
        let _ = publish(State(a.clone()), owner(a), Json(p)).await.unwrap();
        id
    }
    async fn requested(a: &VaultApp, h: &HeaderMap, id: &str) -> String {
        let Json(r) = login(
            State(a.clone()),
            h.clone(),
            Json(WorkspaceId {
                workspace_id: id.into(),
            }),
        )
        .await
        .unwrap();
        r["request_id"].as_str().unwrap().into()
    }
    fn ready(a: &VaultApp, rid: &str) -> (String, Arc<AtomicBool>) {
        let mut s = a.broker.state(a).unwrap();
        let client = s.requests[rid].client.clone();
        let sid = Uuid::new_v4().to_string();
        let cancel = Arc::new(AtomicBool::new(false));
        let (tx, _rx) = mpsc::sync_channel(1);
        s.jobs.insert(
            sid.clone(),
            Job {
                protected: true,
                id: sid.clone(),
                client,
                label: "Protected".into(),
                origin: "https://example.com".into(),
                until: Instant::now() + Duration::from_secs(60),
                expires: now() + 60,
                cancel: cancel.clone(),
                tx,
            },
        );
        let p = s.requests.get_mut(rid).unwrap();
        p.status = "ready";
        p.session = Some(sid.clone());
        (sid, cancel)
    }
    #[tokio::test]
    async fn protected_identity_cannot_upgrade_or_read_even_a_guessed_live_session() {
        let a = app();
        let (h, client) = setup(&a).await;
        assert!(
            request(
                State(a.clone()),
                h.clone(),
                Json(Ask {
                    origin: "https://example.com".into(),
                    scope: "login_read".into()
                })
            )
            .await
            .is_err()
        );
        assert!(transfer_client(&a, &h).is_err());
        assert!(!transfer_client_alive(&a, &client));
        assert!(
            pairing(State(a.clone()), h.clone(), Json(Empty {}))
                .await
                .is_err()
        );
        let id = published(&a, &client).await;
        let rid = requested(&a, &h, &id).await;
        let (sid, _) = ready(&a, &rid);
        assert!(
            read_page(
                State(a.clone()),
                h.clone(),
                Json(Read {
                    session_id: sid.clone(),
                    path: "/".into()
                })
            )
            .await
            .is_err()
        );
        // A job must remain unreadable even if client metadata is accidentally downgraded.
        a.broker
            .state(&a)
            .unwrap()
            .clients
            .get_mut(&client)
            .unwrap()
            .protected = false;
        assert!(
            read_page(
                State(a.clone()),
                h,
                Json(Read {
                    session_id: sid,
                    path: "/".into()
                })
            )
            .await
            .is_err()
        );
    }
    #[tokio::test]
    async fn protected_namespace_hides_private_routing_and_denies_cross_client_and_replay() {
        let a = app();
        let (h, client) = setup(&a).await;
        let (other, _) = add_client(&a).await;
        let id = published(&a, &client).await;
        let Json(out) = list(State(a.clone()), h.clone(), Json(Empty {}))
            .await
            .unwrap();
        let wire = out.to_string();
        assert!(
            !wire.contains("example.com")
                && !wire.contains("private-login-source")
                && !wire.contains("source_id")
                && !wire.contains("label")
        );
        let Json(empty) = list(State(a.clone()), other.clone(), Json(Empty {}))
            .await
            .unwrap();
        assert_eq!(empty["workspaces"].as_array().unwrap().len(), 0);
        assert!(
            login(
                State(a.clone()),
                other,
                Json(WorkspaceId {
                    workspace_id: id.clone()
                })
            )
            .await
            .is_err()
        );
        requested(&a, &h, &id).await;
        assert!(
            login(
                State(a.clone()),
                h,
                Json(WorkspaceId {
                    workspace_id: id.clone()
                })
            )
            .await
            .is_err()
        );
        let mut replay = input(&a, &client);
        replay.workspace_id = id;
        assert!(
            publish(State(a.clone()), owner(&a), Json(replay))
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn protected_approval_is_source_bound_before_unseal() {
        let a = app();
        let (h, client) = setup(&a).await;
        let id = published(&a, &client).await;
        let rid = requested(&a, &h, &id).await;
        let (epoch, revision) = {
            let s = a.broker.state(&a).unwrap();
            (s.epoch, s.revision)
        };
        let error = approve(
            State(a.clone()),
            owner(&a),
            axum::extract::Path(rid.clone()),
            Json(Approval {
                epoch,
                revision,
                source_id: "other-source".into(),
                sealed: Sealed {
                    key: "".into(),
                    iv: "".into(),
                    ciphertext: "".into(),
                },
            }),
        )
        .await
        .err()
        .unwrap();
        assert_eq!(error.0, StatusCode::FORBIDDEN);
        let s = a.broker.state(&a).unwrap();
        assert!(s.jobs.is_empty());
        assert_eq!(s.requests[&rid].status, "pending");
    }
    #[tokio::test]
    async fn protected_drafts_require_live_ready_login_and_exact_refs_and_are_once_only() {
        let a = app();
        let (h, client) = setup(&a).await;
        let id = published(&a, &client).await;
        let text = {
            let s = a.broker.state(&a).unwrap();
            format!("Hallo [[HK:{}]].", s.workspaces[&id].references[0].id)
        };
        assert!(
            draft(
                State(a.clone()),
                h.clone(),
                Json(Draft {
                    workspace_id: id.clone(),
                    text: text.clone()
                })
            )
            .await
            .is_err()
        );
        let rid = requested(&a, &h, &id).await;
        let (_, cancel) = ready(&a, &rid);
        let Json(receipt) = draft(
            State(a.clone()),
            h.clone(),
            Json(Draft {
                workspace_id: id.clone(),
                text: text.clone(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(receipt, json!({"status":"drafted"}));
        let Json(owner_out) = owner_list(State(a.clone()), owner(&a)).await.unwrap();
        assert_eq!(owner_out["workspaces"][0]["draft"], text);
        assert!(
            draft(
                State(a.clone()),
                h.clone(),
                Json(Draft {
                    workspace_id: id.clone(),
                    text
                })
            )
            .await
            .is_err()
        );
        let _ = close(
            State(a.clone()),
            h.clone(),
            Json(WorkspaceId {
                workspace_id: id.clone(),
            }),
        )
        .await
        .unwrap();
        assert!(cancel.load(Ordering::SeqCst));
        assert!(
            login(State(a), h, Json(WorkspaceId { workspace_id: id }))
                .await
                .is_err()
        );
    }
    #[test]
    fn protected_draft_and_typed_input_validation_fails_closed() {
        let refs: Vec<_> = ["person", "email", "case"]
            .iter()
            .map(|kind| Reference {
                id: Uuid::new_v4().to_string(),
                kind: (*kind).into(),
            })
            .collect();
        let t = format!("[[HK:{}]]", refs[0].id);
        assert!(valid_draft(&t, &refs));
        for bad in [
            "plain".to_owned(),
            format!("[[HK:{}]]", Uuid::new_v4()),
            format!("{t} [[HK:nope]]"),
            format!("{t} [[HK:"),
            format!("{t} <img>"),
            format!("{t} https://example.com"),
            format!("{t} example.com"),
            format!("{t} data:text/html"),
            format!("{t}\n"),
            format!("{t} {}", "x".repeat(8000)),
            format!("{t} ]"),
            format!("{t} [label]"),
        ] {
            assert!(!valid_draft(&bad, &refs), "accepted {bad}");
        }
        assert!(
            serde_json::from_value::<WorkspaceId>(json!({"workspace_id":"x","cookies":true}))
                .is_err()
        );
        assert!(
            serde_json::from_value::<Draft>(json!({"workspace_id":"x","text":t,"decrypt":true}))
                .is_err()
        );
        let mut duplicate = refs.clone();
        duplicate[1].id = duplicate[0].id.clone();
        assert!(!references_valid(&duplicate));
        let mut duplicate = refs.clone();
        duplicate[1].kind = "person".into();
        assert!(!references_valid(&duplicate));
    }
    #[tokio::test]
    async fn protected_grants_expire_on_all_lifecycle_boundaries() {
        for event in [
            "timeout",
            "revision",
            "owner_timeout",
            "client_revoke",
            "lock",
        ] {
            let a = app();
            let (h, client) = setup(&a).await;
            let id = published(&a, &client).await;
            let rid = requested(&a, &h, &id).await;
            let (_, cancel) = ready(&a, &rid);
            {
                let mut s = a.broker.state(&a).unwrap();
                match event {
                    "timeout" => {
                        s.workspaces.get_mut(&id).unwrap().until =
                            Instant::now() - Duration::from_secs(1);
                        s.sweep(1);
                    }
                    "revision" => s.sweep(2),
                    "owner_timeout" => {
                        s.owner = Some(Instant::now() - OWNER_TTL);
                        s.sweep(1);
                    }
                    "client_revoke" => s.revoke_client(&client),
                    _ => s.invalidate(),
                }
            }
            assert!(cancel.load(Ordering::SeqCst), "{event}");
            assert!(
                login(State(a.clone()), h, Json(WorkspaceId { workspace_id: id }))
                    .await
                    .is_err(),
                "{event}"
            );
            assert!(Broker::new().state.lock().unwrap().workspaces.is_empty());
        }
    }
    #[tokio::test]
    async fn protected_publication_checks_owner_revision_reference_shape_and_bounds() {
        let a = app();
        let (h, client) = setup(&a).await;
        let mut p = input(&a, &client);
        p.revision += 1;
        assert!(publish(State(a.clone()), owner(&a), Json(p)).await.is_err());
        assert!(
            publish(State(a.clone()), h, Json(input(&a, &client)))
                .await
                .is_err()
        );
        let mut p = input(&a, &client);
        p.references[0].kind = "custom".into();
        assert!(publish(State(a.clone()), owner(&a), Json(p)).await.is_err());
        for _ in 0..32 {
            published(&a, &client).await;
        }
        assert!(
            publish(State(a.clone()), owner(&a), Json(input(&a, &client)))
                .await
                .is_err()
        );
        let Json(out) = owner_list(State(a.clone()), owner(&a)).await.unwrap();
        assert_eq!(out["workspaces"].as_array().unwrap().len(), 32);
        assert!(
            out["workspaces"]
                .as_array()
                .unwrap()
                .iter()
                .all(|w| w["expires_at"].as_u64().unwrap() <= now() + 300)
        );
    }
}
