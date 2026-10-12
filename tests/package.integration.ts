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
    "installed command handles validation and working-directory configuration",
    () => {
      writeFileSync(
        join(workingDirectory, ".env"),
        "LOG_FILE=logs/local.log\nMAX_ITERATIONS=0\n",
      );
      const result = run(
        executable,
        ["run", "--max-iterations", "0"],
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
