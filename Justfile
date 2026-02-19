set shell := ["pwsh", "-NoLogo", "-NoProfile", "-Command"]
default: verify

setup:
  pnpm install
  pwsh -NoLogo -NoProfile -File ./scripts/bootstrap-rust.ps1

frontend-dev:
  pnpm --dir frontend dev

tauri-dev:
  pnpm --dir frontend tauri:dev

tauri-build:
  pnpm --dir frontend tauri:build

backend-reset-sqlite:
  pwsh -NoLogo -NoProfile -File ./scripts/backend-reset-sqlite.ps1

backend-reset-sqlite-all:
  pwsh -NoLogo -NoProfile -File ./scripts/backend-reset-sqlite.ps1 -AllDb

lint:
  pnpm --dir frontend lint

format:
  pnpm --dir frontend format:fix
  pnpm --dir frontend format

type:
  pnpm --dir frontend type-check

test:
  pnpm --dir frontend test

frontend-e2e:
  pnpm --dir frontend test:e2e

build:
  pnpm --dir frontend build

scan:
  pnpm audit --prod

frontend-verify:
  just format
  just lint
  just type
  just test
  just build
  just scan

rust-lint:
  cargo fmt --manifest-path frontend/src-tauri/Cargo.toml --all --check
  cargo clippy --manifest-path frontend/src-tauri/Cargo.toml --all-targets -- -D warnings

rust-test:
  cargo test --manifest-path frontend/src-tauri/Cargo.toml

rust-check:
  cargo check --manifest-path frontend/src-tauri/Cargo.toml

rust-verify:
  just rust-lint
  just rust-test
  just rust-check

verify:
  just frontend-verify
  just rust-verify

gh url:
  Remove-Item -Recurse -Force .git
  git init
  git add .
  git commit -m "Initial Commit"
  git remote add origin {{url}}
  git push -u --force origin main

versions:
  git --version
  node --version
  pnpm --version
  cargo --version
  rustc --version
