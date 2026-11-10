import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ClientLint } from "./client-lint-rules.mjs";

const lint = new ClientLint();
const stdin = process.argv[2] === "--stdin";
const paths = stdin
  ? [process.argv[3] || "js/probe.js"]
  : execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
      .split("\0")
      .filter(
        (path) =>
          /^(?:js|src|reports|tours|public-shell)\/|^[^/]+\.html$/.test(path) &&
          /\.(?:[cm]?[jt]s|[jt]sx|html)$/.test(path),
      );
for (const filePath of paths) {
  if (await lint.isPathIgnored(filePath)) continue;
  const reports = await lint.lintText(readFileSync(stdin ? 0 : filePath, "utf8"), { filePath });
  if (stdin) process.stdout.write(JSON.stringify(reports));
  else
    for (const report of reports)
      for (const error of report.messages) {
        process.stderr.write(`${filePath}:${error.line}:${error.column} ${error.ruleId} ${error.message}\n`);
      }
  if (reports.some((report) => report.errorCount)) process.exitCode = 1;
}
