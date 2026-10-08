import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);

if (
  process.env.HUSKY !== "0" &&
  !process.env.CI &&
  process.env.NODE_ENV !== "production" &&
  existsSync(new URL(".git", root)) &&
  existsSync(new URL("node_modules/husky", root))
) {
  process.chdir(fileURLToPath(root));
  const { default: husky } = await import("husky");
  const error = husky();
  if (error) throw new Error(error);
}
