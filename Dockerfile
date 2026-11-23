FROM rust:1.98-bookworm AS build
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends libclang-dev \
    && rm -rf /var/lib/apt/lists/*
COPY .cargo/ .cargo/
COPY native/ native/
RUN cargo build --release --locked --manifest-path native/Cargo.toml \
    -p multicc-core -p multicc-gateway -p multicc-writer-launcher -p multicc-remote -p multicc-cdpd --bin restart-supervisor --bin multicc-gateway --bin multicc-writer --bin multicc-remote --bin multicc-cdpd

COPY package.json .
COPY public/ public/
COPY plugins/ plugins/
COPY scripts/stage-rust-runtime.sh scripts/
RUN sh scripts/stage-rust-runtime.sh /runtime

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --home-dir /var/lib/multicc multicc \
    && install -d -o multicc -g multicc /var/lib/multicc/data
WORKDIR /srv/multicc
COPY --from=build /runtime/ ./
ENV PATH="/srv/multicc/bin:${PATH}"
ENV MULTICC_DATA_DIR=/var/lib/multicc/data MULTICC_ENV_FILE=/var/lib/multicc/data/multicc.env
USER multicc
RUN test -z "$(command -v node)" && test -z "$(command -v npm)" && test ! -e package.json && test ! -e node_modules && multicc-gateway --version
ENTRYPOINT ["/srv/multicc/bin/multicc-gateway"]
CMD ["serve", "--cwd", "/srv/multicc", "--no-node"]
