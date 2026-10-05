import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function hasDescription(body) {
  const text = String(body || "").replace(/<!--[\s\S]*?-->/g, "");
  return text.split("\n").map(line => line.trim())
    .some(line => line && !line.startsWith("#") && /[\p{L}\p{N}]/u.test(line));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    if (!hasDescription(event?.pull_request?.body)) {
      console.error("Pull request needs a description under 'What changed' or 'How verified'.");
      process.exitCode = 1;
    } else console.log("Pull request description present");
  } catch {
    console.error("Cannot read pull request body from the GitHub event.");
    process.exitCode = 1;
  }
}
