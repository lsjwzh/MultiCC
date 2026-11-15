//! Scoped authorization for the routes the front door answers itself.
//!
//! Node's auth gate (`src/routes/auth.js`) calls `authorizeScopedRequest` for
//! every non-public, non-relay request: `machines.authorize(req)` (the
//! `x-multicc-machine-grant` scope, already handled inside
//! `multicc_core::http_gate`) OR `fleetSharingRuntime.authorizeRequest({
//! token, grant, method, pathname })` (the `x-multicc-fleet-token` /
//! `x-multicc-fleet-grant` pair). The second half lives here because its live
//! state — the published share record plus the member sessions of the shared
//! workspace — is owned by the Node child, reached through the same source
//! control channel (`App::source_workspaces`) the share routes use.
//!
//! The scope itself is not re-implemented here: the store's `authorizePlan`
//! (path → shared workspace, session membership, `dirId` queries, the small
//! global read set) and `authorizeMembers` (live member ids) are the Node
//! authority, already migrated to `multicc_core::workspace_sharing::authority`.
//! This module only supplies the request, awaits the host membership read and
//! fails closed.
//!
//! Locality: the decision never replaces the request's peer. `App::gate` judges
//! every request with the address the PROXY line carried, so a fleet grant
//! cannot turn an external request into a loopback one — the lan-only allowlist
//! still rejects it first (route-inventory §7.1-2).

use multicc_core::{
    http_gate::NodeHeaders,
    js::{self, JsValue as V},
    workspace_sharing::control,
};

use super::{express::RequestCtx, App};

pub const FLEET_TOKEN: &str = "x-multicc-fleet-token";
pub const FLEET_GRANT: &str = "x-multicc-fleet-grant";

/// The token/grant pair a share-scoped request must carry. An empty header is
/// absent, matching the `filter(|value| !value.is_empty())` guards the share
/// routes use (`source_workspaces.rs`), not a distinct third state.
fn fleet_credentials(headers: &NodeHeaders) -> Option<(&str, &str)> {
    Some((
        headers.get(FLEET_TOKEN).filter(|value| !value.is_empty())?,
        headers.get(FLEET_GRANT).filter(|value| !value.is_empty())?,
    ))
}

/// Node's `fleetSharingRuntime?.authorizeRequest(...) === true`.
///
/// A request without both headers cannot be scoped by a share: Node passes
/// `undefined` into `authorizeRequest`, whose `state.authorized` fails on the
/// missing token/grant before any policy runs, so skipping the round trip is
/// the same answer. Every other outcome — malformed encoding, an unreachable
/// control channel, a denial — is `false`; the caller then continues to the
/// ordinary credential check and its refusal, which is the fail-closed path.
pub async fn fleet_scoped(app: &App, ctx: &RequestCtx) -> bool {
    let Some((token, grant)) = fleet_credentials(&ctx.headers) else {
        return false;
    };
    let input = V::object(vec![
        ("token", V::string(token)),
        ("grant", V::string(grant)),
        ("method", V::string(ctx.method.as_str())),
        ("pathname", V::string(&ctx.original_url)),
    ]);
    let Some(encoded) = js::json::json_encode_wire(&input) else {
        return false;
    };
    let request = control::Request::Authorize { input: encoded };
    matches!(
        app.source_workspaces
            .workspace(&request)
            .await
            .and_then(|raw| control::decode(&raw)),
        Ok(Ok(V::Bool(true)))
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> NodeHeaders {
        NodeHeaders::from_raw(pairs.iter().map(|(name, value)| (*name, value.as_bytes())))
    }

    #[test]
    fn a_share_scope_needs_both_non_empty_headers() {
        assert_eq!(
            fleet_credentials(&headers(&[(FLEET_TOKEN, "t"), (FLEET_GRANT, "g")])),
            Some(("t", "g"))
        );
        for pairs in [
            vec![],
            vec![(FLEET_TOKEN, "t")],
            vec![(FLEET_GRANT, "g")],
            vec![(FLEET_TOKEN, ""), (FLEET_GRANT, "g")],
            vec![(FLEET_TOKEN, "t"), (FLEET_GRANT, "")],
            vec![(FLEET_TOKEN, ""), (FLEET_GRANT, "")],
        ] {
            assert_eq!(fleet_credentials(&headers(&pairs)), None, "{pairs:?}");
        }
        // Node folds names to lower case; lookups are case-insensitive.
        assert_eq!(
            fleet_credentials(&headers(&[
                ("X-Multicc-Fleet-Token", "t"),
                ("X-Multicc-Fleet-Grant", "g"),
            ])),
            Some(("t", "g"))
        );
    }
}
