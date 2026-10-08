import { readFileSync, writeFileSync } from "node:fs";

const aiIdentity =
  /^(?:Claude(?: Code| (?:Opus|Sonnet|Haiku)(?:[ -]\d+(?:\.\d+)*)?)?|ChatGPT|(?:OpenAI )?Codex|(?:GitHub )?Copilot|Cursor|Gemini)$/i;
const signature =
  /^\s*(?:🤖\s*)?(?:(?:co[- ]?)?authored[- ]by\s*:?\s+|generated\s+(?:with|by)\s+)(.+?)\s*$/i;

try {
  const path = process.argv[2];
  if (!path) throw new Error("Expected a commit-message file path.");
  const original = readFileSync(path, "utf8");
  let fence;
  const cleaned = original
    .split(/(?<=\n)/)
    .filter((line) => {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length)
          fence = undefined;
        return true;
      }
      if (fence || /^(?: {4}|\t)/.test(line)) return true;
      const attribution = line.match(signature)?.[1];
      if (!attribution) return true;
      const identity = attribution
        .replace(/\s*<[^>]*>\s*$/, "")
        .replace(/^\[([^\]]+)\]\([^)]*\)$/, "$1")
        .replace(/\.$/, "")
        .trim();
      return !aiIdentity.test(identity);
    })
    .join("");
  if (cleaned !== original) writeFileSync(path, cleaned, "utf8");
} catch (error) {
  process.stderr.write(`Could not clean commit message: ${error.message}\n`);
  process.exitCode = 1;
}
