import "dotenv/config";
import { run } from "#actions/runAction.js";
import { reportError } from "#logger.js";

await run({}).catch((error) => {
  reportError(error);
  process.exitCode = 1;
});
