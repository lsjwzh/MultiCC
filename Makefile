.PHONY: production start stage image
production:
	cargo build --locked --release --manifest-path native/Cargo.toml --target-dir native/target

start: production
	exec native/target/release/multicc-gateway serve --cwd .

stage: production
	sh scripts/stage-rust-runtime.sh "$(DESTDIR)"

image:
	docker build -t multicc-rust .
