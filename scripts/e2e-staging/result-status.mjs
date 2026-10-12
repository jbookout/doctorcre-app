// Failure evidence wins over an unproved action, including after checkpoint merge.
export const hasFailure = result => result?.failure != null || result?.exhausted === true || result?.prior_failures?.length > 0 ||
  Array.isArray(result?.controls) && result.controls.some(hasFailure);
export const validSkip = result => result?.status === 'SKIPPED' && !hasFailure(result) && result.in_progress !== true &&
  typeof result.reason === 'string' && result.reason.trim().length > 0 &&
  result.execution?.press_attempted === false && result.execution.handler_executions === 0;

export function normalizeSkip(result, failedStatus, priorResult) {
  const failure = hasFailure(result) ? result : hasFailure(priorResult) ? priorResult : null;
  const normalized = result?.status === 'SKIPPED' && failure
    ? { ...result, ...Object.fromEntries(['failure', 'exhausted', 'prior_failures'].filter(key => failure[key] !== undefined).map(key => [key, failure[key]])), status: failedStatus } : result;
  return Array.isArray(result?.controls)
    ? { ...normalized, controls: result.controls.map(row => normalizeSkip(row, 'ERROR', priorResult?.controls?.find(old => old.key === row?.key))) } : normalized;
}
