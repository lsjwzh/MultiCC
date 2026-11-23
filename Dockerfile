FROM rust:1.98-bookworm AS build
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends libclang-dev \
    && rm -rf /var/lib/apt/lists/*
COPY .cargo/ .cargo/
COPY native/ native/
RUN cargo build --release --locked --manifest-path native/Cargo.toml \
    -p multicc-core -p multicc-gateway -p multicc-writer-launcher -p multicc-remote -p multicc-cdpd --bin restart-supervisor --bin multicc-gateway --bin multicc-writer --bin multicc-remote --bin multicc-cdpd

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --home-dir /var/lib/multicc multicc \
    && install -d -o multicc -g multicc /var/lib/multicc/data
WORKDIR /srv/multicc
COPY --from=build /build/native/target/release/multicc-gateway /build/native/target/release/multicc-writer /build/native/target/release/restart-supervisor /build/native/target/release/multicc-cdpd /build/native/target/release/multicc-remote /usr/local/bin/
COPY package.json .
COPY public/ public/
COPY plugins/chrome-proxy-launcher/ui/ plugins/chrome-proxy-launcher/ui/
ENV MULTICC_DATA_DIR=/var/lib/multicc/data MULTICC_ENV_FILE=/var/lib/multicc/data/multicc.env
USER multicc
RUN test -z "$(command -v node)" && test -z "$(command -v npm)" && multicc-gateway --version
ENTRYPOINT ["/usr/local/bin/multicc-gateway"]
CMD ["serve", "--cwd", "/srv/multicc", "--no-node"]
