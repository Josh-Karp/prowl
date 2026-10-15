import { logger } from "#logger.js";

if (Number(process.versions.node.split(".")[0]) < 24) {
  logger.error(
    `Prowl requires Node.js 24 or higher; current version is ${process.versions.node}.`,
    { console: true, persist: false },
  );
  process.exit(1);
}
