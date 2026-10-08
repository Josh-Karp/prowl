# Repository guidance

Prowl is a TypeScript ESM CLI that uses an Ollama model and Playwright MCP to fill and verify browser forms. Read [README.md](README.md) for setup, CLI behavior, and troubleshooting.

## Setup and verification

- Use the Node range in `package.json` (`^22.22.1 || >=24`) and pnpm for repository dependencies. Keep `pnpm-lock.yaml` in sync with manifest changes; npm is used for packing and consumer installation.
- Install with `pnpm install`. Set up a local `.env` from `.env.example` only when running a live task; choose a model tag available on your Ollama service.
- For code changes, run `pnpm typecheck`, `pnpm test`, `pnpm lint`, and `pnpm format:check`. Documentation-only changes need formatting and verification of the documented commands and paths.
- Run `pnpm test:package` when changing the build, package contents, runtime dependencies, CLI entry point, or paths used by installed modules. This test uses a temporary npm prefix; do not substitute an installation into the machine's real global prefix for routine verification.
- Routine tests need no live Ollama or browser. A live demo check uses `pnpm demo` in one terminal and `pnpm prowl run --url http://localhost:5173` in another. The demo serves `/`, not `/provider`.

## Code layout and conventions

- `src/cli.ts` parses CLI options; `src/index.ts` is the development entry point. Both call `src/actions/runAction.ts`, which validates inputs, configures logging, connects Playwright, runs the agent, and closes the client.
- `src/agent/` contains the shared tool loop, form prompts, and MCP-to-Ollama tool mapping. Multiple submissions share one conversation and iteration budget; completion and confirmation are model-driven.
- `src/models/ollama.ts` owns model requests. `src/mcp/` owns MCP connections and the Playwright subprocess. Keep the MCP version derived from `package.json` rather than introducing another version literal.
- Preserve ESM and NodeNext resolution: local TypeScript imports use `.js` extensions. Keep `#!/usr/bin/env node` at the start of the CLI entry point.
- Use `src/logger.ts` for application logging. Detailed payloads go into the file; use `{ console: true }` for visible progress and `reportError` at entry points to avoid duplicate error output. Preserve separate log files across invocations.
- Tests use `node:test` through tsx. `tests/*.test.ts` is the normal suite; `tests/package.integration.ts` runs separately through `pnpm test:package`. Use local fixtures for subprocess and protocol checks rather than relying on a live model or website.

## Packaging and generated files

- `tsconfig.json` checks source and demo without emitting. `tsconfig.build.json` compiles only `src` into `dist`; builds remove stale `dist` output first.
- The installed `prowl` command points to `dist/cli.js`. Preserve the relative package metadata lookup from compiled modules when changing the output layout.
- `npm pack` runs the build through `prepack`. Keep the package allowlist limited to runtime output and `scripts/prepare.mjs`; npm also includes package metadata and README. Contributor guidance, source, tests, demos, and environment files belong in the checkout.
- `scripts/prepare.mjs` sets up Husky only in a development checkout with the dependency present, outside CI/production and without `HUSKY=0`. Preserve those guards so installed users do not need Husky.
- `dist/`, `*.tgz`, logs, Playwright artifacts, and `node_modules/` are generated and ignored. Edit source and rebuild instead of editing generated JavaScript. `pnpm clean` removes default logs and Playwright artifacts, not build output or tarballs.
- Publishing is disabled with `private: true`. Keep README installation and packing instructions aligned with the current local-tarball distribution method and version.

## Maintenance

- Update README when changing public flags, environment settings, defaults, exit behavior, or packaging. Runtime behavior and package scripts are the sources of truth.
- Preserve the existing Husky hooks: pre-commit formats staged files and checks lint; commit-msg removes recognized AI attribution while preserving human trailers and normal prose.
- Consult `.github/dependabot.yml` before changing dependency update policy, including its TypeScript compatibility constraint.
