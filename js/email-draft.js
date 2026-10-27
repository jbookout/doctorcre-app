const addresses = value => Array.isArray(value) && value.length === 1
  && typeof value[0] === 'string' && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value[0]);

export const validEmailDraftReceipt = (value, request) => value?.ok === true && value.status === 'approved_to_send'
  && value.proposal_id === request.proposal_id && value.version === request.base_version + 1
  && value.subject === request.subject && value.body === request.body
  && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)
  && addresses(value.to) && addresses(value.cc);
