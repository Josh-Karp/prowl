import "dotenv/config";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { logger, reportError } from "../src/logger.js";

async function startDemo() {
  const html = await readFile(new URL("./index.html", import.meta.url));

  const server = createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end("Method not allowed");
      return;
    }

    if (request.url !== "/") {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : html);
  });

  server.on("error", (error) => {
    reportError(
      new Error(`Could not start the demo: ${error.message}`, { cause: error }),
    );
    process.exitCode = 1;
  });

  server.listen(5173, "localhost", () => {
    try {
      logger.info("Customer registration demo: http://localhost:5173", {
        console: true,
      });
    } catch (error) {
      reportError(error);
      process.exitCode = 1;
      server.close();
    }
  });
}

await startDemo().catch((error) => {
  reportError(error);
  process.exitCode = 1;
});
