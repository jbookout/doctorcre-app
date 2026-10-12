import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compareBudget, renderReport } from './performance-budget.mjs';

const marker = '<!-- doctorcre-performance-budget -->';
const pageSize = 100, maxPages = 50;
export async function upsertComment(api, body) {
  const existing = (await api.comments()).find(comment => comment.body?.startsWith(marker)
    && ['github-actions[bot]', 'jbookout'].includes(comment.user?.login));
  if (existing) return api.update(existing.id, body);
  return api.create(body);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Runs from trusted main in workflow_run. The downloaded artifact is data only.
  try {
    const [reportPath, number, expectedSha] = process.argv.slice(2);
    const repo = process.env.GITHUB_REPOSITORY || 'jbookout/doctorcre-app';
    if (repo !== 'jbookout/doctorcre-app' || !/^\d+$/.test(number ?? '') || !/^[a-f0-9]{40}$/.test(expectedSha ?? '')) throw Error('invalid PR binding');
    const gh = (path, { method = 'GET', body } = {}) => JSON.parse(execFileSync('gh', ['api', '-X', method, path,
      ...(body === undefined ? [] : ['--input', '-'])], { input: body === undefined ? '' : JSON.stringify(body),
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
    const pr = gh(`repos/${repo}/pulls/${number}`);
    if (pr.state !== 'open' || pr.head?.sha !== expectedSha) { console.log('Superseded report; no comment changed'); process.exit(0); }
    const input = readFileSync(reportPath, 'utf8');
    if (input.length > 1000000) throw Error('oversized report');
    const report = JSON.parse(input);
    if (report.prHeadCommit !== expectedSha || !/^[a-f0-9]{40}$/.test(report.sourceCommit) || !/^[a-f0-9]{64}$/.test(report.buildDigest)) throw Error('report source binding mismatch');
    const result = compareBudget(report.evaluatedBudget, report);
    if (!Number.isSafeInteger(report.bundle.gzipBytes) || report.bundle.gzipBytes <= 0) throw Error('invalid gzip size');
    const body = renderReport(result) + `\nPR head: \`${expectedSha}\` · measured build source: \`${report.sourceCommit}\` · build: \`${report.buildDigest}\`\n\nTotal shipped JS: **${report.bundle.jsBytes} bytes** (${report.bundle.gzipBytes} bytes, sum of per-file gzip). Screen JS counts unique scripts loaded through the measured interaction.\n`;
    await upsertComment({
      comments: async () => {
        const rows = [];
        for (let page = 1; page <= maxPages; page++) {
          const batch = gh(`repos/${repo}/issues/${number}/comments?per_page=${pageSize}&page=${page}`);
          if (!Array.isArray(batch)) throw Error('malformed comment page');
          rows.push(...batch);
          if (batch.length < pageSize) return rows;
        }
        throw Error('too many comments to find the report');
      },
      create: body => gh(`repos/${repo}/issues/${number}/comments`, { method: 'POST', body: { body } }),
      update: (id, body) => gh(`repos/${repo}/issues/comments/${id}`, { method: 'PATCH', body: { body } }),
    }, body);
    console.log(`Performance comment updated for PR ${number}`);
  } catch (error) {
    console.error(`performance-comment: refused: ${error.message}`);
    process.exitCode = 1;
  }
}
