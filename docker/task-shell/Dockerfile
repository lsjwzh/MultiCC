FROM rust:1.98-bookworm AS rust-build
WORKDIR /build
COPY .cargo ./.cargo
COPY native ./native
RUN cargo build --locked --release --manifest-path native/Cargo.toml

# Node-free runtime: only the two Rust executables and the system CA store (rustls
# reads it for outbound TLS). Nothing in this image provides Node; the build
# asserts that and smoke-runs both binaries. It is a build artifact, not a
# deployable server: multicc-gateway still spawns `node server.js` as its upstream
# for the routes that have not moved into Rust yet (docs/gateway.md §9).
FROM debian:bookworm-slim AS node-free-runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --home-dir /var/lib/multicc --shell /bin/false multicc
COPY --from=rust-build /build/native/target/release/multicc-gateway /usr/local/bin/multicc-gateway
COPY --from=rust-build /build/native/target/release/multicc-writer /usr/local/bin/multicc-writer
# Exit codes are the binaries' own documented contract: gateway with no
# arguments prints usage and exits 2; writer with no arguments exits 64 (EX_USAGE).
RUN set -eu; \
    if command -v node >/dev/null 2>&1; then echo "node-free runtime must not contain node" >&2; exit 1; fi; \
    if [ -e /usr/bin/node ] || [ -e /usr/local/bin/node ]; then echo "node-free runtime must not contain node" >&2; exit 1; fi; \
    multicc-gateway --version | grep -Eq '^multicc-gateway [0-9]+ [0-9]+\.[0-9]+\.[0-9]+$'; \
    multicc-gateway --help | grep -q 'multicc-gateway serve --cwd'; \
    code=0; multicc-gateway >/dev/null 2>&1 || code=$?; [ "$code" -eq 2 ]; \
    code=0; multicc-writer >/dev/null 2>&1 || code=$?; [ "$code" -eq 64 ]; \
    echo "node-free runtime smoke passed"; \
    multicc-gateway --version
WORKDIR /srv/multicc
USER multicc
# `docker run <image> --version` runs the front door; the default command only
# prints usage because serving still needs a Node upstream (see above).
ENTRYPOINT ["/usr/local/bin/multicc-gateway"]
CMD ["--help"]

FROM node:22-bookworm-slim AS tools

# curl + tar + unzip are the only tools install.sh is allowed to need: it
# downloads the standalone package and unpacks it, nothing else.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git curl unzip python3 make g++ chromium fonts-noto-cjk tini tmux openssl \
    && rm -rf /var/lib/apt/lists/*

# No node_modules or npm cache: the release gate starts from a fresh container,
# and the standalone package it installs carries its own runtime.
FROM tools AS clean-install
WORKDIR /candidate
COPY . .
COPY --from=rust-build /build/native/target/release/libmulticc_addon.so /tmp/multicc-core.node
# 远控进程、CDP 网关和原生模块同目录：服务端按这个位置找 multicc-remote 与
# multicc-cdpd，「🖥 屏幕」和浏览器网关才有后端。
COPY --from=rust-build /build/native/target/release/multicc-remote /tmp/multicc-remote
COPY --from=rust-build /build/native/target/release/multicc-cdpd /tmp/multicc-cdpd
COPY --from=rust-build /build/native/target/release/multicc-gateway /tmp/multicc-gateway
RUN arch="$(uname -m)"; case "$arch" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) exit 1 ;; esac; \
    mkdir -p "native/prebuilt/linux-$arch" && mv /tmp/multicc-core.node "native/prebuilt/linux-$arch/multicc_core.node" && \
    cp /tmp/multicc-remote "native/prebuilt/linux-$arch/multicc-remote" && \
    cp /tmp/multicc-cdpd "native/prebuilt/linux-$arch/multicc-cdpd" && \
    cp /tmp/multicc-gateway "native/prebuilt/linux-$arch/multicc-gateway" && \
    chmod 0755 "native/prebuilt/linux-$arch/multicc-remote" "native/prebuilt/linux-$arch/multicc-cdpd" "native/prebuilt/linux-$arch/multicc-gateway"
RUN chown -R node:node /candidate
USER node
ENV NODE_ENV=test ASR_LOCAL=off MULTICC_CHROME_BIN=/usr/bin/chromium
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "docker/task-shell/install-and-test.js"]

FROM tools AS regression
WORKDIR /opt/multicc
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
COPY --from=rust-build /build/native/target/release/libmulticc_addon.so /tmp/multicc-core.node
COPY --from=rust-build /build/native/target/release/multicc-remote /tmp/multicc-remote
COPY --from=rust-build /build/native/target/release/multicc-cdpd /tmp/multicc-cdpd
COPY --from=rust-build /build/native/target/release/multicc-gateway /tmp/multicc-gateway
COPY --from=rust-build /build/native/target/release/multicc-writer /tmp/multicc-writer
RUN arch="$(uname -m)"; case "$arch" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) exit 1 ;; esac; \
    mkdir -p "native/prebuilt/linux-$arch" && mv /tmp/multicc-core.node "native/prebuilt/linux-$arch/multicc_core.node" && \
    cp /tmp/multicc-remote "native/prebuilt/linux-$arch/multicc-remote" && \
    cp /tmp/multicc-cdpd "native/prebuilt/linux-$arch/multicc-cdpd" && \
    cp /tmp/multicc-gateway "native/prebuilt/linux-$arch/multicc-gateway" && \
    cp /tmp/multicc-writer "native/prebuilt/linux-$arch/multicc-writer" && \
    chmod 0755 "native/prebuilt/linux-$arch/multicc-remote" "native/prebuilt/linux-$arch/multicc-cdpd" "native/prebuilt/linux-$arch/multicc-gateway" "native/prebuilt/linux-$arch/multicc-writer"
RUN chmod +x docker/task-shell/fake-codex.js \
    && mkdir -p /var/lib/multicc \
    && chown -R node:node /opt/multicc /var/lib/multicc
USER node
RUN git config --global user.name 'MultiCC Docker Lab' \
    && git config --global user.email 'lab@multicc.invalid' \
    && git config --global init.defaultBranch main
ENV NODE_ENV=test ASR_LOCAL=off MULTICC_CHROME_BIN=/usr/bin/chromium \
    MULTICC_DATA_DIR=/var/lib/multicc/data \
    MULTICC_MEMORY_ROOT=/var/lib/multicc/data/memories \
    MULTICC_ENV_FILE=/var/lib/multicc/lab.env \
    CODEX_CMD=/opt/multicc/docker/task-shell/fake-codex.js \
    CLAUDE_CMD=/nonexistent/claude CLAUDE_BIN=/nonexistent/claude \
    OPENCODE_CMD=/nonexistent/opencode QODER_CMD=/nonexistent/qoder
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "docker/task-shell/run-tests.js"]

# Command Code 实验实例：独立数据卷，不读取宿主账号、会话或密钥文件。
FROM tools AS command-code-runtime
WORKDIR /opt/command-code
COPY docker/command-code/package.json docker/command-code/package-lock.json ./
RUN npm ci --legacy-peer-deps --no-audit --no-fund \
    && /opt/command-code/node_modules/.bin/command-code --version

FROM regression AS command-code
USER root
COPY --from=command-code-runtime /opt/command-code /opt/command-code
ENV COMMAND_CODE_CMD=/opt/command-code/node_modules/.bin/command-code \
    CMD_LOCAL_ONLY=1 DO_NOT_TRACK=1 CODEX_CMD=/nonexistent/codex
WORKDIR /opt/multicc
USER node
CMD ["node", "docker/command-code/start.js"]
