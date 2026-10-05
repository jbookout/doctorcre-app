import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compareBudget, renderReport } from './performance-budget.mjs';

const marker = '<!-- doctorcre-performance-budget -->';
export async function upsertComment(api, body) {
  const existing = (await api.comments()).find(comment => comment.body?.startsWith(marker)
    && ['github-actions[bot]', 'jbookout'].includes(comment.user?.login));
  if (existing) return api.update(existing.id, body);
  return api.create(body);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Runs from trusted main in workflow_run. The downloaded artifact is data only.
  const [reportPath, number, expectedSha] = process.argv.slice(2);
  const repo = process.env.GITHUB_REPOSITORY || 'jbookout/doctorcre-app';
  if (!/^jbookout\/doctorcre-app$/.test(repo) || !/^\d+$/.test(number) || !/^[a-f0-9]{40}$/.test(expectedSha)) throw Error('invalid PR binding');
  const api = (query, variables) => {
    const result = JSON.parse(execFileSync('gh', ['api', 'graphql', '--input', '-'], {
      input: JSON.stringify({ query, variables }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
    if (result.errors) throw Error('GitHub GraphQL request failed');
    return result.data;
  };
  const query = 'query($number:Int!,$cursor:String){repository(owner:"jbookout",name:"doctorcre-app"){pullRequest(number:$number){id state headRefOid comments(first:100,after:$cursor){nodes{id body author{login}} pageInfo{hasNextPage endCursor}}}}}';
  const pr = api(query, { number: Number(number) }).repository.pullRequest;
  if (pr.state !== 'OPEN' || pr.headRefOid !== expectedSha) { console.log('Superseded report; no comment changed'); process.exit(0); }
  const input = readFileSync(reportPath, 'utf8');
  if (input.length > 1000000) throw Error('oversized report');
  const report = JSON.parse(input);
  if (report.prHeadCommit !== expectedSha || !/^[a-f0-9]{40}$/.test(report.sourceCommit) || !/^[a-f0-9]{64}$/.test(report.buildDigest)) throw Error('report source binding mismatch');
  const budget = report.evaluatedBudget;
  const result = compareBudget(budget, report);
  if (!Number.isSafeInteger(report.bundle.gzipBytes) || report.bundle.gzipBytes <= 0) throw Error('invalid gzip size');
  const body = renderReport(result) + `\nPR head: \`${expectedSha}\` · measured build source: \`${report.sourceCommit}\` · build: \`${report.buildDigest}\`\n\nTotal shipped JS: **${report.bundle.jsBytes} bytes** (${report.bundle.gzipBytes} bytes, sum of per-file gzip). Screen JS counts unique scripts loaded through the measured interaction.\n`;
  const comments = async () => {
    const rows = [];
    let connection = pr.comments;
    while (true) {
      rows.push(...connection.nodes.map(comment => ({ ...comment, user: comment.author })));
      if (!connection.pageInfo.hasNextPage) return rows;
      connection = api(query, { number: Number(number), cursor: connection.pageInfo.endCursor }).repository.pullRequest.comments;
    }
  };
  await upsertComment({ comments,
    create: body => api('mutation($id:ID!,$body:String!){addComment(input:{subjectId:$id,body:$body}){commentEdge{node{id}}}}', { id: pr.id, body }),
    update: (id, body) => api('mutation($id:ID!,$body:String!){updateIssueComment(input:{id:$id,body:$body}){issueComment{id}}}', { id, body }),
  }, body);
  console.log(`Performance comment updated for PR ${number}`);
}
