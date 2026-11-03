export function requireEmailActionReceipt(method, request, receipt, activityId) {
  if (!receipt || receipt.ok !== true || receipt.proposal_id !== request.proposal_id || receipt.version !== request.base_version + 1 || receipt.note !== request.note)
    throw Error('Unconfirmed action receipt');
  if (method === 'snoozeEmailProposal') {
    if (receipt.status !== 'pending' || receipt.disposition !== 'deferred' || typeof receipt.deferred_until !== 'string' || Date.parse(receipt.deferred_until) !== Date.parse(request.deferred_until || ''))
      throw Error('Unconfirmed deferral receipt');
    return { kind: 'deferred', until: receipt.deferred_until };
  } else if (receipt.status !== 'confirmed' || receipt.disposition !== (request.disposition || 'handled') || (method === 'confirmEmailFiling' && (receipt.deal !== request.deal || typeof receipt.activity_id !== 'string' || (activityId !== undefined && receipt.activity_id !== activityId)))) {
    throw Error('Unconfirmed filing receipt');
  }
  return { kind: 'confirmed' };
}
