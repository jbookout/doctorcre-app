import { readFile } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';

const report = JSON.parse(await readFile(process.argv[2], 'utf8'));
const { expected, unexpected, flaky, skipped } = report.stats;
const inline = value => stripVTControlCharacters(String(value)).split('\n')[0].replace(/[&<>|`]/g, char => `&#${char.charCodeAt(0)};`);
const entries = [];
function visit(suite) {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests) {
      if (!['unexpected', 'flaky'].includes(test.status)) continue;
      const error = test.results.find(result => result.error)?.error;
      entries.push({ status: test.status, text: `${inline(spec.file)}:${spec.line} [${inline(test.projectName)}] ${inline(spec.title)}${error ? ` — ${inline(error.message || error.value)}` : ''}` });
    }
  }
  for (const child of suite.suites ?? []) visit(child);
}
for (const suite of report.suites) visit(suite);
console.log(`# Signed-in staging tests\n\n${expected} passed, ${unexpected} failed, ${flaky} flaky, ${skipped} skipped.\n`);
for (const [status, title] of [['flaky', 'Flaky tests'], ['unexpected', 'Failed tests (first error)']]) {
  console.log(`## ${title}\n`);
  const matches = entries.filter(entry => entry.status === status);
  console.log(matches.length ? matches.map(entry => `- ${entry.text}`).join('\n') : 'None.');
  console.log();
}
for (const error of report.errors ?? []) console.log(`- Runner error: ${inline(error.message || error.value)}`);
