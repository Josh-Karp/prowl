import "#runtime.js";
import "dotenv/config";
import { runAction } from "#actions/runAction.js";
import { reportError } from "#logger.js";

await runAction({}).catch((error) => {
  reportError(error);
  process.exitCode = 1;
});
