# Prowl

Prowl is a local AI browser testing CLI. An Ollama model uses Playwright MCP tools to inspect a form, fill its fields, submit it, and report the visible result. The current `run` command focuses on forms; broader end-to-end user journeys are a future direction.

## Install and configure

You need:

- Node.js 22.22.1+ on the 22 branch, or Node.js 24+, with npm/npx available on your `PATH`.
- A running Ollama service and an available model supporting tool calls.
- A running target application that the browser can reach.
- A browser supported by [Playwright MCP](https://github.com/microsoft/playwright-mcp).

Installed users do not need pnpm, TypeScript, or tsx. Contributors also need pnpm.

Prowl is distributed as a local package tarball. Build one using the [packaging steps](#packaging), or install a supplied tarball:

```bash
npm install --global /path/to/prowl-0.1.0.tgz
prowl --help
prowl run --help
```

The filename follows the version in `package.json`; `prowl-0.1.0.tgz` is the current example. Registry publishing remains disabled through `private: true`, so `npm install --global prowl` is not this project's installation method.

Run Prowl from your project directory. It loads `.env` from that directory, not from the installed package. For example:

```dotenv
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=gemma4:12b
```

Set `OLLAMA_MODEL` to the exact tag of a tool-capable model available on your service; the example shows Prowl's fallback model, not a model installed by Prowl. On the Ollama host, `ollama ls` lists available models. If your local Ollama service is not already running, start it in another terminal with `ollama serve`. Download a missing model with `ollama pull <model>`, replacing `<model>` with your chosen tag. See the [Ollama CLI reference](https://docs.ollama.com/cli).

For a remote service, set `OLLAMA_BASE_URL` to its reachable base URL, without `/api/chat`. The installed package does not contain `.env.example`; create your own `.env` or use shell variables and CLI flags.

Prowl starts Playwright MCP automatically through `npx @playwright/mcp@latest`. Its first launch may download packages and require network access. Browser setup is described in the [Playwright MCP documentation](https://github.com/microsoft/playwright-mcp).

To remove the global installation:

```bash
npm uninstall --global prowl
```

## Usage and configuration

With your target application running:

```bash
prowl run --url http://localhost:5173
```

This URL is the bundled demo's root page; start the demo using the [development steps](#development). For another application, supply its full form URL. Quote URLs containing query parameters so your shell preserves them.

To request multiple submissions or provide additional instructions:

```bash
prowl run --url 'http://localhost:5173' \
  --runs 2 \
  --instructions 'Use varied synthetic data and choose Business for one customer' \
  --max-iterations 30
```

| CLI flag                   | Environment fallback  | Default                                    |
| -------------------------- | --------------------- | ------------------------------------------ |
| `--url <url>`              | —                     | `http://localhost:5173`                    |
| `--runs <count>`           | —                     | 1 submission                               |
| `--instructions <text>`    | —                     | No additional instructions                 |
| `--model <name>`           | `OLLAMA_MODEL`        | `gemma4:12b`                               |
| `--base-url <url>`         | `OLLAMA_BASE_URL`     | `http://localhost:11434`                   |
| `--max-iterations <count>` | `MAX_ITERATIONS`      | 30 iterations for the entire task          |
| `--log-file <path>`        | `LOG_FILE`            | `logs/prowl.log`                           |
| `--context-mode <mode>`    | `PROWL_CONTEXT_MODE`  | `auto` (`full` preserves complete history) |
| `--history-bytes <bytes>`  | `PROWL_HISTORY_BYTES` | Twice `OLLAMA_NUM_CTX`                     |
| `--verbose`                | —                     | Off                                        |

`--url`, `--runs`, and `--instructions` belong to `run`. The other options apply to the whole program and can also be supplied after `run`. Use `prowl --help` for global options and `prowl run --help` for the form options. URLs must use HTTP or HTTPS; runs and maximum iterations must be positive safe integers.

Two additional environment settings control model requests:

| Variable            | Default | Meaning                                           |
| ------------------- | ------- | ------------------------------------------------- |
| `OLLAMA_NUM_CTX`    | 16384   | Positive integer context size in tokens           |
| `OLLAMA_TIMEOUT_MS` | 120000  | Per-request deadline, including the response body |

The timeout must be a positive integer no greater than 2147483647 milliseconds. Shell variables override `.env`; CLI flags override environment fallbacks.

All requested submissions share one agent conversation and one iteration budget. Multi-run behavior and confirmation checks are instructions to the model. For uploads, provide a local file path through `--instructions`. The model is instructed to report missing information or an uncertain submission rather than inventing results or repeating that submission.

## Browser context

Automatic mode reduces large inline page snapshots when one native form can be identified safely. It combines a form-scoped accessibility snapshot with native field types, constraints, required states, current values, option values, and page instructions/feedback. Reduction requires an observation of at least 8 KiB and savings of at least 25% and 2 KiB. Small forms pass through. Sidebar guide articles, navigation and footer content may be omitted; ambiguous controls, custom widgets, frames, multiple forms, and unsupported MCP capabilities use a fresh complete snapshot. Explicit snapshot targets, depth, boxes and filenames are respected.

Older complete conversation turns are archived and replaced with deterministic checkpoints without another model call. Completed thinking stays in logs and archives. The original task, latest browser observation, recent turns, current errors and literal confirmation evidence remain available. Compaction uses serialized message bytes and previous provider token usage (80% of the context window); bytes are a proxy rather than a token guarantee. Tool definitions also consume context. A protected current observation exceeding the budget is sent intact and produces a budget-exception event.

The model can call `prowl_full_snapshot` for a fresh complete page or `prowl_browser_history` for archived evidence. Historical refs are marked stale. For troubleshooting, preserve the original behavior with:

```bash
prowl run --url 'http://localhost:5173' --context-mode full
```

## Results and logs

Normal console output shows the log path, connection and iteration progress, tool names, the final model report, and concise failures. `--verbose` also prints detailed model and tool data. Help does not create a log file.

The process exits with code 0 when the model finishes without further tool calls, and code 1 for validation errors, uncaught runtime errors, or an exhausted iteration budget. A model can finish by reporting a blocker, so exit code 0 is not an assertion that the form passed. Read the final report and visible confirmation details to interpret the outcome. Tool-reported errors are returned to the model so it can choose its next action.

Each invocation creates a separate JSON-lines log containing model responses, tool arguments and results, timings, and error details. `logs/prowl.log` is the default base filename; the logger adds a UTC timestamp and unique ID, producing `logs/prowl-<timestamp>-<id>.log`. Multiple requested submissions share that invocation's file, and previous logs are retained. Files are created only when the first entry is written.

Automatic runs save snapshot JSON and original conversation turns in `<unique-log-path>.artifacts/`, beside the invocation's log. These files contain browser/task data; add `*.artifacts/` to your project's ignore rules if logs are outside an already ignored directory. `history.jsonl` preserves original tool receipts and thinking; numbered snapshot files preserve unreduced observations collected by the context adapter. Full mode retains raw results in the log.

Structured `Context event` log records (schema version 1) include effective configuration, reduction/fallback decisions, history compactions, budget exceptions, and inference request sizes. Ollama token counts, cached counts and duration fields are recorded when supplied; durations use the provider's nanoseconds. Missing provider metrics are omitted.

Paths are relative to your working directory unless absolute. The logger creates the directory automatically. `--log-file ./custom.log` changes the base name to `./custom-<timestamp>-<id>.log`; `LOG_FILE` supplies the base filename when the flag is absent. This checkout ignores `logs/` and `*.log`. When using the installed CLI in another project, add the desired log paths to that project's `.gitignore`.

## Development

From the repository root:

```bash
pnpm install
cp .env.example .env
# Set OLLAMA_MODEL to the exact tag available on your service.
pnpm demo
```

Leave the demo running, then use a second terminal in the repository:

```bash
pnpm prowl run --url http://localhost:5173
# Or run the development entry point with the same defaults:
pnpm dev
```

The demo is served at `http://localhost:5173/`; `/provider` is not a demo route. It includes text, email, phone, URL, date and number inputs, native selects, radios, checkboxes, a range, a color picker, notes, and an optional upload. Choosing Business requires a company field; choosing Phone requires a phone number. Successful registrations display a unique reference ID and save the latest customer in browser storage.

Other development commands:

```bash
pnpm typecheck             # Type-check src and demo without emitting files
pnpm test                  # Unit and local subprocess tests
pnpm lint                  # Check JavaScript and TypeScript
pnpm format:check          # Check Prettier formatting
pnpm lint:fix              # Apply ESLint fixes
pnpm format                # Format supported project files
pnpm build                 # Recreate dist from src; exclude demo and tests
pnpm test:context          # Opt-in native-form integration with real Playwright MCP
pnpm test:package          # Pack and test an isolated installation
pnpm clean                 # Delete logs/ and .playwright-mcp, retaining dist/tarballs
```

`pnpm test` needs no live Ollama, browser, or target application. Before handing off code changes, run type checking, tests, lint, and the formatting check. Also run `pnpm test:package` for changes affecting runtime dependencies, packaging, executable entry points, or installed file paths. Repository conventions are in the root `AGENTS.md`, which is available in the checkout.

Application code uses `src/logger.ts`; `{ console: true }` makes useful progress visible even without `--verbose`:

```ts
logger.info("Waiting for model...", { console: true });
logger.debug("Model response", { data: response });
```

## Packaging

After installing the development dependencies:

```bash
npm pack --dry-run         # Inspect the package contents; lifecycle scripts may rebuild dist
npm pack                   # Creates prowl-0.1.0.tgz
npm install --global ./prowl-0.1.0.tgz
prowl --help
```

`prepack` recreates `dist` automatically, removing stale output first. The archive contains compiled JavaScript, package metadata, this README, and the guarded prepare helper. Source, demos, tests, AGENTS.md, Git hooks, and environment files stay in the checkout. `dist/` and tarballs are generated artifacts and are gitignored. The MCP client's version is read from the installed `package.json`.

`pnpm test:package` installs an archive into a temporary npm prefix and runs the installed executable outside the checkout without development dependencies. It checks package contents, stale build removal, help, validation, working-directory configuration and logs, and the version sent during MCP initialization. It leaves the machine's global installation alone and does not require a live Ollama or Playwright service. Dependency installation requires registry access or a populated npm cache.

The package test does not verify a live browser task. For that check, start Ollama and the demo, then run the installed command from outside the checkout with a suitable `--model` and `--url http://localhost:5173`.

## Troubleshooting

| Symptom                                         | Check                                                                                                                                                          |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prowl` is not found                            | Confirm installation succeeded and your npm global executable directory is on `PATH`; on Windows, npm creates a command shim in the global prefix.             |
| Ollama request or connection fails              | Check that Ollama is running, the base URL is reachable, and the configured model tag exists and supports tools. Detailed HTTP response errors are in the log. |
| Playwright does not connect or launch a browser | Check that `npx` is available, package downloads can finish, and the required browser is installed. Consult the Playwright MCP documentation linked above.     |
| `Agent exceeded maximum iterations.`            | Review the log for repeated or blocked actions; refine `--instructions` or increase `--max-iterations` for a task that needs more steps.                       |
| Model request times out                         | Check Ollama's responsiveness and resources, then adjust `OLLAMA_TIMEOUT_MS` in milliseconds if needed.                                                        |
| `Unable to write log file`                      | Use a writable directory with `--log-file`; confirm the parent path is a directory rather than a file.                                                         |
| Demo startup fails                              | Check whether port 5173 is already in use and inspect the reported error.                                                                                      |

## Git hooks and dependency updates

`pnpm install` activates Husky through `prepare` in a development checkout with Husky installed. Hook setup is skipped for installed packages, CI, production environments, and `HUSKY=0`. Reactivate development hooks with `pnpm prepare`.

Before each commit, lint-staged applies ESLint fixes and Prettier to staged files and includes those fixes in the commit. Remaining lint errors block the commit; unstaged changes stay out of it. Prettier uses its default style; ESLint uses recommended JavaScript/TypeScript rules without formatting rules.

The commit-message hook removes standalone AI `Authored-by` / `Co-authored-by` footers and generated-by/with signatures identifying Claude (including Code, Opus, Sonnet and Haiku variants), ChatGPT, Codex, Copilot, Cursor, or Gemini. Human coauthors, unknown identities, prose, and quoted examples are preserved. Recognized identities are defined in `scripts/clean-commit-message.mjs`.

[Dependabot](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference) checks dependencies every Monday using `.github/dependabot.yml`, updating the root manifest and pnpm lockfile. The configuration excludes TypeScript updates at 6.1.0 or above to keep the configured typescript-eslint compatibility boundary. It takes effect on the GitHub repository's default branch. No version-bump or release workflow is configured.
