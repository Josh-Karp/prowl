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
npm install --global /path/to/prowl-0.1.1.tgz
prowl --help
prowl run --help
```

The filename follows the version in `package.json`; `prowl-0.1.1.tgz` is the current example. Registry publishing remains disabled through `private: true`, so `npm install --global prowl` is not this project's installation method.

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
prowl run http://localhost:5173
```

This URL is the bundled demo's root page; start the demo using the [development steps](#development). For another application, supply its full form URL. Quote URLs containing query parameters so your shell preserves them.

To request multiple submissions or provide additional instructions:

```bash
prowl run 'http://localhost:5173' \
  --runs 2 \
  --instructions 'Use varied synthetic data and choose Business for one customer' \
  --max-iterations 30
```

| CLI argument or flag       | Environment fallback | Default                           |
| -------------------------- | -------------------- | --------------------------------- |
| `[url]`                    | —                    | `http://localhost:5173`           |
| `--runs <count>`           | —                    | 1 submission                      |
| `--instructions <text>`    | —                    | No additional instructions        |
| `--model <name>`           | `OLLAMA_MODEL`       | `gemma4:12b`                      |
| `--base-url <url>`         | `OLLAMA_BASE_URL`    | `http://localhost:11434`          |
| `--max-iterations <count>` | `MAX_ITERATIONS`     | 30 iterations for the entire task |
| `--log-file <path>`        | `LOG_FILE`           | `logs/prowl.log`                  |
| `--verbose`                | —                    | Off                               |

`[url]` is the first argument to `run`; `--runs` and `--instructions` are its options. The other options apply to the whole program and can also be supplied after `run`. Use `prowl --help` for global options and `prowl run --help` for the form options. URLs must use HTTP or HTTPS; runs and maximum iterations must be positive safe integers.

Two additional environment settings control model requests:

| Variable            | Default | Meaning                                           |
| ------------------- | ------- | ------------------------------------------------- |
| `OLLAMA_NUM_CTX`    | 16384   | Positive integer context size in tokens           |
| `OLLAMA_TIMEOUT_MS` | 120000  | Per-request deadline, including the response body |

The timeout must be a positive integer no greater than 2147483647 milliseconds. Shell variables override `.env`; CLI flags override environment fallbacks.

All requested submissions share one agent conversation and one iteration budget. Multi-run behavior and confirmation checks are instructions to the model. For uploads, provide a local file path through `--instructions`. The model is instructed to report missing information or an uncertain submission rather than inventing results or repeating that submission.

## Results and logs

Normal console output shows the log path, connection and iteration progress, tool names, the final model report, and concise failures. `--verbose` also prints detailed model and tool data. Help does not create a log file.

The process exits with code 0 when the model returns a nonblank final response without further tool calls, and code 1 for validation errors, uncaught runtime errors, an exhausted iteration budget, or repeated empty model responses. A model can finish by reporting a blocker, so exit code 0 is not an assertion that the form passed. Read the final report and visible confirmation details to interpret the outcome. Tool-reported errors are returned to the model so it can choose its next action.

If a model response contains neither tool calls nor a nonblank answer, Prowl asks the model to continue or report a blocker. Thinking alone does not count as an answer. Prowl allows two recovery attempts per consecutive sequence of empty responses; tool calls reset the counter. Recovery requests count toward `--max-iterations`, retain the conversation and browser session, and do not replay earlier tool calls. A third consecutive empty response fails explicitly. If the iteration budget runs out first, Prowl reports the iteration-limit error instead.

Each invocation creates a separate JSON-lines log containing model responses, tool arguments and results, timings, and error details. `logs/prowl.log` is the default base filename; the logger adds a UTC timestamp and unique ID, producing `logs/prowl-<timestamp>-<id>.log`. Multiple requested submissions share that invocation's file, and previous logs are retained. Files are created only when the first entry is written.

Each successfully parsed Ollama chat response also adds an `Ollama completion metadata` debug entry, including responses with empty content or no tool calls. It records the returned `model`, `created_at`, `done`, and `done_reason`; prompt, cached prompt, and generated token counts (`prompt_eval_count`, `prompt_eval_cached_count`, `eval_count`); and server durations (`total_duration`, `load_duration`, `prompt_eval_duration`, `eval_duration`) in **nanoseconds**. Fields unavailable on the server are omitted; responses without metadata produce an empty data object. These server timings are separate from the existing client request timings in milliseconds. Normal console progress stays concise; `--verbose` also displays the metadata. A server completion reason describes the model response ending, not whether all requested form submissions succeeded. See the [Ollama chat API reference](https://docs.ollama.com/api/chat).

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
pnpm prowl run http://localhost:5173
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
pnpm test:package          # Pack and test an isolated installation
pnpm clean                 # Delete logs/, .playwright-mcp, and dist; retain tarballs
```

`pnpm test` needs no live Ollama, browser, or target application. Before handing off code changes, run type checking, tests, lint, and the formatting check. Also run `pnpm test:package` for changes affecting runtime dependencies, packaging, executable entry points, or installed file paths. Repository conventions are in the root `AGENTS.md`, which is available in the checkout.

Application code uses `src/logger.ts`; `{ console: true }` makes useful progress visible even without `--verbose`:

```ts
logger.info("Waiting for model...", { console: true });
logger.debug("Model response", { data: response });
logger.info("Demo ready", { console: true, persist: false });
```

`persist` defaults to `true`; `{ console: true, persist: false }` prints to the console without writing that entry to a log file. The demo startup message uses this option, so starting the demo alone does not create a log file.

## Packaging

After installing the development dependencies:

```bash
npm pack --dry-run         # Inspect the package contents; lifecycle scripts may rebuild dist
npm pack                   # Creates prowl-0.1.1.tgz
npm install --global ./prowl-0.1.1.tgz
prowl --help
```

`prepack` recreates `dist` automatically, removing stale output first. The archive contains compiled JavaScript, package metadata, this README, and the guarded prepare helper. Source, demos, tests, AGENTS.md, Git hooks, and environment files stay in the checkout. `dist/` and tarballs are generated artifacts and are gitignored. The MCP client's version is read from the installed `package.json`.

`pnpm test:package` installs an archive into a temporary npm prefix and runs the installed executable outside the checkout without development dependencies. It checks package contents, stale build removal, help, validation, working-directory configuration and logs, and the version sent during MCP initialization. It leaves the machine's global installation alone and does not require a live Ollama or Playwright service. Dependency installation requires registry access or a populated npm cache.

The package test does not verify a live browser task. For that check, start Ollama and the demo, then run the installed command from outside the checkout with a suitable `--model` and the form URL: `prowl run http://localhost:5173 --model <name>`.

## Troubleshooting

| Symptom                                                                          | Check                                                                                                                                                                             |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prowl` is not found                                                             | Confirm installation succeeded and your npm global executable directory is on `PATH`; on Windows, npm creates a command shim in the global prefix.                                |
| Ollama request or connection fails                                               | Check that Ollama is running, the base URL is reachable, and the configured model tag exists and supports tools. Detailed HTTP response errors are in the log.                    |
| Playwright does not connect or launch a browser                                  | Check that `npx` is available, package downloads can finish, and the required browser is installed. Consult the Playwright MCP documentation linked above.                        |
| `Agent exceeded maximum iterations.`                                             | Review the log for repeated or blocked actions; refine `--instructions` or increase `--max-iterations` for a task that needs more steps.                                          |
| `Model returned an empty response without tool calls after 2 recovery attempts.` | Review the logged model responses and recovery warnings. The model returned no action or final report after both follow-ups; check that the configured model supports tool calls. |
| Model request times out                                                          | Check Ollama's responsiveness and resources, then adjust `OLLAMA_TIMEOUT_MS` in milliseconds if needed.                                                                           |
| `Unable to write log file`                                                       | Use a writable directory with `--log-file`; confirm the parent path is a directory rather than a file.                                                                            |
| Demo startup fails                                                               | Check whether port 5173 is already in use and inspect the reported error.                                                                                                         |

## Git hooks and dependency updates

`pnpm install` activates Husky through `prepare` in a development checkout with Husky installed. Hook setup is skipped for installed packages, CI, production environments, and `HUSKY=0`. Reactivate development hooks with `pnpm prepare`.

Before each commit, lint-staged applies ESLint fixes and Prettier to staged files and includes those fixes in the commit. Remaining lint errors block the commit; unstaged changes stay out of it. Prettier uses its default style; ESLint uses recommended JavaScript/TypeScript rules without formatting rules.

The commit-message hook removes standalone AI `Authored-by` / `Co-authored-by` footers and generated-by/with signatures identifying Claude (including Code, Opus, Sonnet and Haiku variants), ChatGPT, Codex, Copilot, Cursor, or Gemini. Human coauthors, unknown identities, prose, and quoted examples are preserved. Recognized identities are defined in `scripts/clean-commit-message.mjs`.

[Dependabot](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference) checks dependencies every Monday using `.github/dependabot.yml`, updating the root manifest and pnpm lockfile. The configuration excludes TypeScript updates at 6.1.0 or above to keep the configured typescript-eslint compatibility boundary. It takes effect on the GitHub repository's default branch. No version-bump or release workflow is configured.
