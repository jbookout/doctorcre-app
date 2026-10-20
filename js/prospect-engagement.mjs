const refusals = new Set([
  'offline', 'account_changed', 'human_confirmation_required',
  'unauthorized', 'not_authenticated', 'forbidden',
  'invalid_engagement_status', 'engagement_reason_required', 'version_conflict',
  'not_found', 'client_merged_away', 'not_a_prospect', 'prospect_party_protected',
  'prospect_lead_protected', 'missing_required', 'value_not_in_declared_vocabulary',
]);

export function confirmedEngagementRefusal(error) {
  return [401, 403].includes(error.status) || refusals.has(error.payload?.error);
}
