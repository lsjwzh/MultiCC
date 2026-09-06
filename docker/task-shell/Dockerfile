FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git python3 make g++ chromium tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/multicc
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
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
