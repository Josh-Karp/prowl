import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

test("packed CLI works without the checkout or development dependencies", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "prowl-package-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = {
    ...process.env,
    NODE_PATH: undefined,
    NODE_OPTIONS: undefined,
    NODE_ENV: undefined,
    CI: undefined,
    HUSKY: undefined,
    LOG_FILE: undefined,
    MAX_ITERATIONS: undefined,
  };
  function run(command: string, args: string[], cwd: string) {
    return spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      env,
      shell: process.platform === "win32" && command.endsWith(".cmd"),
    });
  }
  function success(command: string, args: string[], cwd: string) {
    const result = run(command, args, cwd);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result;
  }

  // Packing must discard output left by a previous build.
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist/obsolete.js"), "throw new Error('stale');\n");
  const packed = success(
    npm,
    ["pack", "--json", "--pack-destination", directory],
    root,
  );
  const [archive] = JSON.parse(packed.stdout) as Array<{
    filename: string;
    files: Array<{ path: string }>;
  }>;
  assert.ok(
    archive.files.some((file) => file.path === "dist/cli.js"),
    "archive has no compiled CLI",
  );

  await t.test(
    "archive includes runtime files and excludes development artifacts",
    () => {
      const files = archive.files.map((file) => file.path);
      for (const required of [
        "dist/cli.js",
        "dist/actions/runAction.js",
        "dist/actions/options.js",
        "dist/forms/runs.js",
        "dist/forms/prompts.js",
        "dist/agent/prompts.js",
        "dist/models/ollama.js",
        "dist/agent/context/artifacts.js",
        "dist/agent/context/observations.js",
        "dist/agent/context/nativeForm.js",
        "dist/agent/context/history.js",
        "dist/agent/context/options.js",
        "dist/agent/context/tools.js",
        "dist/mcp/client.js",
        "scripts/prepare.mjs",
        "package.json",
        "README.md",
      ]) {
        assert.ok(files.includes(required), `missing ${required}`);
      }
      for (const file of files) {
        assert.ok(
          file.startsWith("dist/") ||
            ["scripts/prepare.mjs", "package.json", "README.md"].includes(file),
          `unexpected packaged file: ${file}`,
        );
        assert.ok(!file.endsWith(".ts"), `TypeScript source included: ${file}`);
      }
      assert.ok(!files.includes("dist/obsolete.js"));
      for (const oldPath of [
        "dist/agent/runs.js",
        "dist/agent/tools.js",
        "dist/agent/toolMapping.js",
        "dist/agent/context-options.js",
        "dist/agent/artifacts.js",
        "dist/agent/history.js",
        "dist/agent/context.js",
        "dist/agent/nativeForm.js",
      ]) {
        assert.ok(
          !files.includes(oldPath),
          `obsolete module included: ${oldPath}`,
        );
      }
      assert.equal(existsSync(join(root, "dist/obsolete.js")), false);
    },
  );

  const prefix = join(directory, "installation");
  success(
    npm,
    [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--omit=dev",
      "--ignore-scripts=false",
      "--no-audit",
      "--no-fund",
      join(directory, archive.filename),
    ],
    directory,
  );
  const installation = join(
    prefix,
    ...(process.platform === "win32" ? [] : ["lib"]),
    "node_modules/prowl",
  );
  const executable =
    process.platform === "win32"
      ? join(prefix, "prowl.cmd")
      : join(prefix, "bin/prowl");
  const workingDirectory = join(directory, "user project");
  mkdirSync(workingDirectory);

  await t.test("installed command exposes help without creating logs", () => {
    for (const dependency of ["tsx", "typescript", "husky"]) {
      assert.equal(
        existsSync(join(installation, "node_modules", dependency)),
        false,
      );
    }
    for (const args of [["--help"], ["run", "--help"]]) {
      const help = success(executable, args, workingDirectory);
      assert.match(help.stdout, /Usage: prowl/);
      assert.equal(help.stderr, "");
    }
    assert.deepEqual(readdirSync(workingDirectory), []);
  });

  await t.test(
    "compiled context modules load with direct Zod available",
    () => {
      const contextUrl = pathToFileURL(
        join(installation, "dist/agent/context/observations.js"),
      ).href;
      const historyUrl = pathToFileURL(
        join(installation, "dist/agent/context/history.js"),
      ).href;
      const manifestUrl = pathToFileURL(
        join(installation, "package.json"),
      ).href;
      const probe = `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      import { BrowserContext } from ${JSON.stringify(contextUrl)};
      import { ConversationHistory } from ${JSON.stringify(historyUrl)};
      const require = createRequire(${JSON.stringify(manifestUrl)});
      assert.equal(require('#package.json').dependencies.zod, '4.6.5');
      assert.equal(require('zod').z.string().safeParse('available').success, true);
      assert.equal(typeof BrowserContext, 'function');
      const history = new ConversationHistory([], { budget: 1000, numCtx: 1000 });
      history.appendTurn([{ role: 'assistant', content: 'Exact original', thinking: 'retained' }]);
      assert.equal(history.prepare()[0].thinking, undefined);
      assert.equal(history.retrieve({ turnId: 1 }).messages[0].thinking, 'retained');
    `;
      success(
        process.execPath,
        ["--input-type=module", "-e", probe],
        workingDirectory,
      );
    },
  );

  await t.test(
    "installed form runner uses fresh conversations and a shared iteration count",
    () => {
      const runnerUrl = pathToFileURL(
        join(installation, "dist/forms/runs.js"),
      ).href;
      const loggerUrl = pathToFileURL(
        join(installation, "dist/logger.js"),
      ).href;
      const probe = `
        import assert from 'node:assert/strict';
        import { runBatch } from ${JSON.stringify(runnerUrl)};
        import { configureLogger } from ${JSON.stringify(loggerUrl)};
        configureLogger({ filePath: ${JSON.stringify(join(directory, "installed-run.log"))} });
        const requests = [];
        globalThis.fetch = async (_url, options) => {
          const request = JSON.parse(options.body);
          requests.push(request);
          assert.equal(request.messages.length, 2);
          assert.match(request.messages[1].content, new RegExp('Run ' + requests.length + ' of 2'));
          return new Response(JSON.stringify({ message: { role: 'assistant', content: JSON.stringify({
            status: 'confirmed', summary: 'Registered', evidence: 'Visible registration confirmation'
          }) } }));
        };
        const summary = await runBatch({ listTools: async () => ({ tools: [] }) }, {
          url: 'http://fixture/?query=preserved', runs: 2, maxIterations: 2,
          context: { mode: 'full', historyBytes: 32768, numCtx: 16384 }
        });
        assert.equal(requests.length, 2);
        assert.equal(summary.iterationsUsed, 2);
        assert.deepEqual(summary.results.map(result => result.status), ['confirmed', 'confirmed']);
      `;
      success(
        process.execPath,
        ["--input-type=module", "-e", probe],
        workingDirectory,
      );
    },
  );

  await t.test(
    "installed command handles validation and working-directory configuration",
    () => {
      writeFileSync(
        join(workingDirectory, ".env"),
        "LOG_FILE=logs/local.log\nMAX_ITERATIONS=0\n",
      );
      const result = run(
        executable,
        ["run", "https://example.com/form", "--max-iterations", "0"],
        workingDirectory,
      );
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.equal(
        result.stderr,
        "[error] maxIterations must be a positive integer.\n",
      );
      const logs = readdirSync(join(workingDirectory, "logs"));
      assert.equal(logs.length, 1);
      assert.match(logs[0], /^local-\d{4}-\d{2}-\d{2}T/);
      assert.deepEqual(readdirSync(join(workingDirectory, "logs", logs[0])), [
        "local.log",
      ]);
      const record = JSON.parse(
        readFileSync(
          join(workingDirectory, "logs", logs[0], "local.log"),
          "utf8",
        ),
      );
      assert.equal(record.level, "error");
      assert.match(record.data.stack, /maxIterations/);
    },
  );

  await t.test(
    "installed prepare helper skips Husky without development dependencies",
    () => {
      const result = success(
        process.execPath,
        [join(installation, "scripts/prepare.mjs")],
        workingDirectory,
      );
      assert.equal(result.stdout + result.stderr, "");
      assert.equal(existsSync(join(installation, ".husky")), false);
      assert.equal(existsSync(join(workingDirectory, ".husky")), false);
    },
  );

  await t.test(
    "compiled MCP initialization follows installed package version changes",
    () => {
      const manifestPath = join(installation, "package.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const server = `
      const readline = require('node:readline');
      readline.createInterface({ input: process.stdin }).on('line', line => {
        const message = JSON.parse(line);
        if (message.method === 'initialize') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: message.id,
            result: {
              protocolVersion: message.params.protocolVersion,
              capabilities: {},
              serverInfo: {
                name: 'version-check', version: message.params.clientInfo.version
              }
            }
          }) + '\\n');
        }
      });
    `;
      const moduleUrl = pathToFileURL(
        join(installation, "dist/mcp/client.js"),
      ).href;
      const probe = `
      import { connectMCPServer } from ${JSON.stringify(moduleUrl)};
      const { client } = await connectMCPServer(process.execPath, ['-e', ${JSON.stringify(server)}]);
      try {
        console.log(client.getServerVersion().version);
      } finally {
        await client.close();
      }
    `;
      for (const version of [manifest.version, "9.9.9"]) {
        writeFileSync(manifestPath, JSON.stringify({ ...manifest, version }));
        const result = success(
          process.execPath,
          ["--input-type=module", "-e", probe],
          workingDirectory,
        );
        assert.equal(result.stdout.trim(), version);
      }
    },
  );
});
