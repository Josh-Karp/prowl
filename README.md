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

| CLI argument or flag       | Environment fallback  | Default                           |
| -------------------------- | --------------------- | --------------------------------- |
| `[url]`                    | —                     | `http://localhost:5173`           |
| `--runs <count>`           | —                     | 1 submission                      |
| `--instructions <text>`    | —                     | No additional instructions        |
| `--model <name>`           | `OLLAMA_MODEL`        | `gemma4:12b`                      |
| `--base-url <url>`         | `OLLAMA_BASE_URL`     | `http://localhost:11434`          |
| `--max-iterations <count>` | `MAX_ITERATIONS`      | 30 iterations for the entire task |
| `--log-file <path>`        | `LOG_FILE`            | `logs/prowl.log`                  |
| `--context-mode <mode>`    | `PROWL_CONTEXT_MODE`  | `auto` (`auto` or `full`)         |
| `--history-bytes <count>`  | `PROWL_HISTORY_BYTES` | Twice `OLLAMA_NUM_CTX` in bytes   |
| `--verbose`                | —                     | Off                               |

`[url]` is the first argument to `run`; `--runs` and `--instructions` are its options. The other options apply to the whole program and can also be supplied after `run`. Use `prowl --help` for global options and `prowl run --help` for the form options. URLs must use HTTP or HTTPS; runs, maximum iterations, and history bytes must be positive safe integers.

Two additional environment settings control model requests:

| Variable            | Default | Meaning                                           |
| ------------------- | ------- | ------------------------------------------------- |
| `OLLAMA_NUM_CTX`    | 16384   | Positive integer context size in tokens           |
| `OLLAMA_TIMEOUT_MS` | 120000  | Per-request deadline, including the response body |

The timeout must be a positive integer no greater than 2147483647 milliseconds. Shell variables override `.env`; CLI flags override environment fallbacks.

Prowl schedules up to `--runs` sequential registration tasks. Each task starts with a fresh model conversation, including fresh history/checkpoints in automatic context mode. The browser session stays connected, and every task instructs the model to navigate to the original full URL before filling one registration. All tasks share one `--max-iterations` budget, including empty-response recovery requests; the budget does not reset for each run.

Each task must end with a JSON result containing `status` (`confirmed`, `blocked`, or `uncertain`) and a nonblank `summary` of the entered fields and outcome. A `confirmed` result also requires nonblank literal confirmation `evidence`; `reference` is optional. The model is instructed to return only JSON, without Markdown fences or surrounding prose. Prowl advances only on a valid `confirmed` result. A blocked, uncertain, or malformed result stops the invocation without a replacement run. For uploads, provide a local file path through `--instructions`.

Run scheduling is controlled by the application; interpreting visible success remains model-driven. The model retains its browser tools within each task, so this is not a hard limit on submit clicks inside one run. Each task instructs it to submit once and never repeat an uncertain submission.

## Results and logs

Normal console output shows the log path, connection, run and iteration progress, tool names, each run's status and summary, available confirmation evidence and reference IDs, the confirmed/total run count, and concise failures. `--verbose` also prints detailed model and tool data, including raw JSON reports. Help does not create a log file.

The process exits with code 0 only when all requested runs return valid `confirmed` reports. It exits with code 1 for blocked or uncertain outcomes, malformed reports, validation errors, uncaught runtime errors, an exhausted shared iteration budget, or repeated empty model responses. Confirmation evidence is supplied and interpreted by the model, so inspect the reports and visible browser evidence when assessing correctness. Tool-reported errors are returned to the model so it can choose its next action within the current run.

If a model response contains neither tool calls nor a nonblank answer, Prowl asks the model to continue or report a blocker. Thinking alone does not count as an answer. Prowl allows two recovery attempts per consecutive sequence of empty responses; tool calls reset the counter. Recovery requests count toward `--max-iterations`, retain the conversation and browser session, and do not replay earlier tool calls. A third consecutive empty response fails explicitly. If the iteration budget runs out first, Prowl reports the iteration-limit error instead.

Each invocation creates a separate folder for its JSON-lines log. `logs/prowl.log` is the default base filename; the logger adds a UTC timestamp and unique ID to the folder name, producing `logs/prowl-<timestamp>-<id>/prowl.log`. The log contains model responses, tool arguments and results, timings, and error details. Multiple requested submissions share that invocation's folder, and previous runs are retained. The folder and log are created only when the first entry is written.

`Form run started` and `Form run finished` debug entries record the host-assigned run index. `Form runs summary` records requested runs, all finished/uncertain results, and total model iterations used, including partial results if the invocation stops early. Full raw model responses remain in the log; later runs do not receive earlier reports, observations, or reasoning in their model conversation.

Each successfully parsed Ollama chat response also adds an `Ollama completion metadata` debug entry, including responses with empty content or no tool calls. It records the returned `model`, `created_at`, `done`, and `done_reason`; prompt, cached prompt, and generated token counts (`prompt_eval_count`, `prompt_eval_cached_count`, `eval_count`); and server durations (`total_duration`, `load_duration`, `prompt_eval_duration`, `eval_duration`) in **nanoseconds**. Fields unavailable on the server are omitted; responses without metadata produce an empty data object. These server timings are separate from the existing client request timings in milliseconds. Normal console progress stays concise; `--verbose` also displays the metadata. A server completion reason describes the model response ending, not whether all requested form submissions succeeded. See the [Ollama chat API reference](https://docs.ollama.com/api/chat).

Each successfully parsed response also adds a `Context event` debug entry with `schemaVersion: 1` and `kind: "inference"`. It records the effective context window (`numCtx`) and UTF-8 serialized byte sizes for messages (`messagesBytes`), tool definitions (`toolsBytes`), and the complete request body (`requestBytes`). When tools are omitted, `toolsBytes` measures an empty list. Available provider token counts and duration fields are included only when they are finite, nonnegative numbers; missing or invalid metrics are omitted and durations remain in nanoseconds. Byte sizes describe request data, not an exact token count. These metrics are separate from the assistant message and are also exposed through an optional callback in the model adapter.

Paths are relative to your working directory unless absolute. The logger creates the directory automatically. `--log-file ./custom.log` produces `./custom-<timestamp>-<id>/custom.log`; `LOG_FILE` supplies the base filename when the flag is absent. A base filename without an extension uses `.log`. This checkout ignores `logs/`, timestamped run folders, `*.log`, and legacy `*.artifacts/` folders. When using the installed CLI in another project, add the desired log directory to that project's `.gitignore`. Existing logs and artifact folders are retained.

## Development

Local imports use Node's package aliases: `#` for application modules, `#tests/` for test helpers, and `#package.json` for package metadata. Development scripts enable the `development` condition to load TypeScript source directly; the installed CLI resolves application aliases to `dist` without a loader. TypeScript uses the same development condition for type checking and builds.

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
pnpm test:context          # Opt-in real Playwright MCP check (no Ollama)
pnpm clean                 # Delete logs/, .playwright-mcp, and dist; retain tarballs
```

`pnpm test` needs no live Ollama, browser, or target application. Before handing off code changes, run type checking, tests, lint, and the formatting check. Also run `pnpm test:package` for changes affecting runtime dependencies, packaging, executable entry points, or installed file paths. Repository conventions are in the root `AGENTS.md`, which is available in the checkout.

Source modules are grouped by responsibility:

| Location                                       | Responsibility                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `src/actions/runAction.ts`                     | CLI input validation, logging setup, browser connection and cleanup                              |
| `src/forms/`                                   | Sequential registration runs, structured results, form-task prompts                              |
| `src/agent/loop.ts` and `src/agent/prompts.ts` | Model/tool execution, browser-agent guidance and recovery                                        |
| `src/agent/context/`                           | Context options, history, artifacts, observation reduction, native forms and local context tools |
| `src/models/` and `src/mcp/`                   | Ollama requests/tool mapping and Playwright MCP connections                                      |

`tests/*.test.ts` stays flat for the normal suite; `tests/context.integration.ts` and `tests/package.integration.ts` run through their separate scripts. The installed entry point remains `dist/cli.js`; compiled modules follow the source folder layout.

Application code uses `src/logger.ts`; `{ console: true }` makes useful progress visible even without `--verbose`:

```ts
logger.info("Waiting for model...", { console: true });
logger.debug("Model response", { data: response });
logger.info("Demo ready", { console: true, persist: false });
```

`persist` defaults to `true`; `{ console: true, persist: false }` prints to the console without writing that entry to a log file. The demo startup message uses this option, so starting the demo alone does not create a log file.

Automatic context handling is the default. Use `--context-mode full` (or `PROWL_CONTEXT_MODE=full`) to send complete browser observations and conversation messages, including thinking. Full mode adds no local context tools or context-history artifacts.

In automatic mode, observations of at least 8 KiB can be replaced by a scoped native-form snapshot and validated metadata when Playwright MCP supports targeted snapshots. Metadata preserves required, disabled and readonly state, HTML constraints as strings, checkbox/radio values, native option values, help, outside instructions and feedback. Refs must match exactly. Reduction requires savings of at least 2 KiB and 25%. Ambiguous forms, malformed metadata, changing pages, or insufficient savings trigger a fresh full observation, retaining original action receipts. Small observations and explicitly customized snapshots pass through.

Older complete turns are compacted deterministically when serialized messages exceed `--history-bytes` or the previous provider prompt usage reaches 80% of `OLLAMA_NUM_CTX`. The default budget is twice the context window in bytes (32768 with the default window). Compaction targets half the budget and protects the system/task prefix, the two latest turns, the latest browser observation, and the latest tool error. Completed thinking is archived but omitted from automatic-mode model messages. Recovery prompts remain attached to their empty-response turns. No extra model requests are made for compaction.

Checkpoints preserve literal confirmation evidence (including adjacent or nested ID values), cumulative requested-action counts, concise tool receipts, and retrieval instructions. Requested actions never imply successful submissions. The byte budget is a soft limit: protected evidence remains intact when it cannot fit, and a `budget-exception` context event records the excess. Byte counts are not token estimates and exclude tool definitions from the history budget.

The model can call `prowl_full_snapshot` with no arguments for a fresh complete observation. `prowl_browser_history` accepts either a positive integer `turnId`, a positive integer `checkpoint` version, or no arguments to list available turn IDs. It returns exact originals, including original tool results and thinking; historical refs must not be used for current interactions. Both local tools bypass observation reduction. Invalid arguments and unknown archive IDs become tool errors; MCP execution failures still propagate.

Automatic mode stores original complete turns in `history.jsonl` and archived observations in numbered `snapshot-0001.json` files beside the current invocation’s log, relative to the directory from which you run Prowl. Each history record carries its `runIndex`; turn IDs and checkpoint versions restart within each fresh run, and the history tool retrieves only the current run's turns. Snapshot numbering continues across runs through one shared artifact writer. These files are created lazily and refuse to overwrite existing history or snapshots. Full mode still writes normal application logs and inference metrics. Context events record configuration, observation savings, history compaction, and budget exceptions.

To check native metadata against a real headless Playwright MCP browser (no Ollama needed):

```bash
pnpm test:context
# Optionally use an existing Playwright MCP CLI instead of npx:
PROWL_MCP_CLI=/absolute/path/to/playwright-mcp/cli.js pnpm test:context
```

This opt-in check serves a local registration fixture and verifies conditional required fields, upload refs, numeric constraints, and native option values. It needs a Playwright browser and may need registry access for `npx`; routine tests remain independent of browsers and Ollama.

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
