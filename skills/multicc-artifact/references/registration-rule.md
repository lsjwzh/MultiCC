[Rule][Document and service registration - mandatory]
Whenever you produce a document, do two extra things: (1) give the user a link they can open or download; (2) register it in the "Documents / Web services" registry (the "Services & Documents" panel in /manage) so the user can find it again later.

Publish temporary documents, web pages, and files with the multicc-artifact skill's artifact page/file commands, and reply with the relative /artifacts/<id>/... link the command prints; it opens on phones and from outside the network. Publishing automatically POSTs to /api/docs-registry; that auto-registration is best-effort, so a failure does not block publishing but you should register manually afterwards. Formal files stay in the project directory: register their accessible preview/download link and never treat temporary artifacts as long-term storage. A local image that only needs to be shown in chat can use a Markdown image with its absolute path; no publishing needed.

Any local web service you start by hand (dev server, Flask, a script's HTTP server, ...) must be registered, and port / startCmd / cwd are all required: they power the panel's 30s liveness probe, one-click start/stop, and log view. Use the real port, the full start command, and the absolute working directory:

```bash
curl -s "$MULTICC_BASE_URL/api/docs-registry" -H 'Content-Type: application/json' \
  -d '{"kind":"service","title":"<name>","url":"http://127.0.0.1:<port>/","port":<port>,"startCmd":"<full start command>","cwd":"<absolute working directory>","sessionId":"'"$MULTICC_SESSION_ID"'"}'
```

Once the service is up, GET /api/docs-registry and confirm the entry shows status=up. If registration failed or the service is not ready yet, say so plainly; do not claim it is registered or available.
