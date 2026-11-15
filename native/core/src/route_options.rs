//! Express's automatic `OPTIONS` method union.
//!
//! `express/lib/router/index.js` walks its layer stack in registration order and
//! calls `appendMethods(options, route._options())` for every route that matches
//! the request path but not the method. `appendMethods` pushes a method only the
//! first time it appears, so the answer is the registration-order union with
//! duplicates removed. `Route._options` lists the route's registered methods in
//! insertion order and appends `HEAD` after a `GET`.
//!
//! The front door answers each path the same way, but its routes live in
//! several clusters with their own matchers. Each cluster contributes the
//! methods it registers on the path (in registration order) and
//! [`merge`] folds those shares together exactly like `appendMethods`.

/// Append the comma-separated `allow` list to `methods`, first occurrence wins.
///
/// An empty list (or an empty string) contributes nothing, like a cluster that
/// has no route on the path.
pub fn append_methods(methods: &mut Vec<String>, allow: &str) {
    for method in allow.split(',') {
        let method = method.trim();
        if method.is_empty() || methods.iter().any(|seen| seen == method) {
            continue;
        }
        methods.push(method.to_string());
    }
}

/// Fold each cluster's ordered `Allow` list into one, in cluster order.
///
/// `shares` must already be in Express registration order (see
/// `native/gateway/src/app/mod.rs` `OPTIONS_SOURCES`); this function only adds
/// the duplicate-removal rule `appendMethods` applies.
pub fn merge<'a>(shares: impl IntoIterator<Item = &'a str>) -> String {
    let mut methods = Vec::new();
    for share in shares {
        append_methods(&mut methods, share);
    }
    methods.join(",")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_the_first_registration_order() {
        // session-admin's `GET/HEAD` is registered before session-profile's
        // PATCH, which is before bundle's literal POST and lifecycle's DELETE.
        assert_eq!(
            merge(["GET,HEAD", "PATCH,POST,DELETE"]),
            "GET,HEAD,PATCH,POST,DELETE"
        );
    }

    #[test]
    fn a_method_is_added_only_once() {
        assert_eq!(merge(["GET,HEAD", "GET,HEAD", "POST"]), "GET,HEAD,POST");
        assert_eq!(merge(["POST", "POST,GET,HEAD"]), "POST,GET,HEAD");
    }

    #[test]
    fn empty_shares_contribute_nothing() {
        assert_eq!(merge(["", "PUT"]), "PUT");
        assert_eq!(merge(Vec::<&str>::new()), "");
        let mut methods = vec!["GET".to_string()];
        append_methods(&mut methods, "");
        assert_eq!(methods, vec!["GET"]);
    }

    #[test]
    fn whitespace_around_a_method_is_ignored() {
        let mut methods = Vec::new();
        append_methods(&mut methods, "GET, HEAD ,PATCH");
        assert_eq!(methods, vec!["GET", "HEAD", "PATCH"]);
    }
}
