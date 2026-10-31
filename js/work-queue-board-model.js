// The system board's model: the record-layer work queue (verb work-queue) as stage columns.
// The server derives stage, PR links and staleness; the page only validates, groups and labels.
import { MIN_POLL_MS } from './visibility-poll.mjs';

export const QUEUE_STAGES = [
  { id: 'queued', label: 'Queued', color: 'var(--fg-quiet)', meaning: 'Dispatched; no PR yet' },
  { id: 'running', label: 'Running', color: 'var(--data-2)', meaning: 'Started; no PR yet' },
  { id: 'build', label: 'Building', color: 'var(--data-2)', meaning: 'Draft PR open' },
  { id: 'review', label: 'Review', color: 'var(--data-3)', meaning: 'PR open for review and CI' },
  { id: 'merged', label: 'Merged', color: 'var(--data-1)', meaning: 'PR merged' },
  { id: 'live', label: 'Live', color: 'var(--data-1)', meaning: 'Merged PRs in production' },
  { id: 'closed', label: 'Closed', color: 'var(--status-danger)', meaning: 'PR closed without merging' },
];
export const QUEUE_REFRESH_MS = MIN_POLL_MS;
// Five quiet minutes stop the reads, so the record layer's database can suspend.
export const QUEUE_IDLE_MS = 5 * 60_000;

const JOB_ID = /^WR\d+\.S\d+\.J\d+$/;
const STAGE_IDS = new Set(QUEUE_STAGES.map(stage => stage.id));
const REPOSITORIES = ['DoctorCRE/carr-system', 'jbookout/doctorcre-app', 'jbookout/software-factory'];
const text = value => typeof value === 'string' && value.trim() !== '';

export function queueBoard(read) {
  const valid = read?.ok === true && Array.isArray(read.jobs) && Array.isArray(read.github)
    && read.jobs.every(job => JOB_ID.test(job?.card_id) && STAGE_IDS.has(job.stage) && text(job.work_request)
      && typeof job.stale === 'boolean' && Array.isArray(job.prs));
  if (!valid) throw new Error('The work queue read is incomplete, so it cannot be shown.');
  const complete = REPOSITORIES.every(repo => read.github.some(source => source.repo === repo && source.state === 'ok' && source.truncated === false));
  const jobs = read.jobs.map(job => ({ ...job, stage: job.stage === 'live' ? 'merged'
    : complete && job.pr_evidence_complete === true && job.stage === 'merged' && job.prs.length > 0
      && job.prs.every(pr => pr.state === 'merged' && pr.production_live === true) ? 'live' : job.stage }));
  const stages = QUEUE_STAGES.map(stage => {
    const groups = [];
    for (const job of jobs.filter(job => job.stage === stage.id)) {
      let group = groups.find(item => item.work_request === job.work_request);
      if (!group) groups.push(group = { work_request: job.work_request, title: job.work_request_title || '', jobs: [] });
      group.jobs.push(job);
    }
    return { ...stage, count: groups.reduce((sum, group) => sum + group.jobs.length, 0), groups };
  });
  const notices = read.github.flatMap(source => source.state !== 'ok'
    ? [`GitHub could not be read for ${source.repo}; its PR stages may be behind.`]
    : source.truncated ? [`Only the 100 most recently updated ${source.repo} PRs were read.`] : []);
  return { jobs, stages, stale: read.jobs.filter(job => job.stale).length,
    staleAfterHours: read.stale_after_hours, notices };
}

// "WR557.S4.J1.app#12" plus a link, for every PR the server matched by its Card line.
export function prLinks(job) {
  return job.prs.filter(pr => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(pr.url))
    .map(pr => ({ href: pr.url, label: pr.card_id, state: pr.state === 'open' && pr.draft ? 'draft' : pr.state }));
}
