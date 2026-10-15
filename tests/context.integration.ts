// Opt-in real-browser integration; excluded from the routine *.test.ts suite.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserContext } from "#agent/context/observations.js";
import { connectMCPServer } from "#mcp/client.js";
import { configureLogger } from "#logger.js";

test(
  "real MCP preserves native registration controls and conditional required fields",
  { timeout: 90000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "prowl-context-browser-"));
    configureLogger({ filePath: join(dir, "integration.log") });
    const demo = await readFile(
      new URL("../demo/index.html", import.meta.url),
      "utf8",
    );
    const clutter =
      "<aside><article>" +
      "Office locations and visitor guide details. ".repeat(1500) +
      "</article></aside>";
    const server = createServer((_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(demo.replace("</body>", clutter + "</body>"));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const args = process.env.PROWL_MCP_CLI
      ? [process.env.PROWL_MCP_CLI]
      : ["@playwright/mcp@latest"];
    t.after(async () => {
      server.close();
      configureLogger();
      await rm(dir, { recursive: true, force: true });
    });
    const { client } = await connectMCPServer(
      process.env.PROWL_MCP_CLI ? process.execPath : "npx",
      [...args, "--headless", "--isolated", "--output-dir", dir],
    );
    t.after(async () => {
      await client.close();
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await client.callTool({
      name: "browser_navigate",
      arguments: { url: `http://127.0.0.1:${address.port}/` },
    });
    const { tools } = await client.listTools();
    const context = new BrowserContext(client, tools);
    const observe = async () => {
      const full = await client.callTool({
        name: "browser_snapshot",
        arguments: {},
      });
      const result = await context.reduce("browser_snapshot", {}, full);
      assert.ok(
        Buffer.byteLength(JSON.stringify(result)) <
          Buffer.byteLength(JSON.stringify(full)) * 0.75,
        "registration must reduce with uniquely mapped upload ref",
      );
      const text = (result.content as Array<{ text: string }>)[0].text;
      return JSON.parse(text.split("### Native form metadata\n")[1]) as {
        fields: Array<{
          id: string;
          htmlType: string;
          role: string;
          required: boolean;
          ref: string;
          constraints: Record<string, string>;
          options?: Array<{ label: string; value: string }>;
        }>;
      };
    };
    const initial = await observe();
    assert.equal(
      initial.fields.find((field) => field.id === "document")?.role,
      "button",
    );
    assert.equal(
      initial.fields.find((field) => field.id === "phone")?.required,
      false,
    );
    assert.equal(
      initial.fields.some((field) => field.id === "company"),
      false,
    );
    assert.equal(
      initial.fields.find((field) => field.id === "household-size")?.constraints
        .min,
      "1",
    );
    assert.equal(
      initial.fields
        .find((field) => field.id === "customer-type")
        ?.options?.find((option) => option.label === "Business")?.value,
      "business",
    );
    await client.callTool({
      name: "browser_select_option",
      arguments: { target: "#customer-type", values: ["business"] },
    });
    await client.callTool({
      name: "browser_click",
      arguments: { target: 'input[type="radio"][value="phone"]' },
    });
    const conditional = await observe();
    assert.equal(
      conditional.fields.find((field) => field.id === "company")?.required,
      true,
    );
    assert.equal(
      conditional.fields.find((field) => field.id === "phone")?.required,
      true,
    );
    assert.ok(conditional.fields.every((field) => !!field.ref));
  },
);
