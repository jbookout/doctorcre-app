// Codex Desktop's local thread link is navigation only. It does not create a
// session or send a model turn. A canonical CARR row must bind the exact native
// task before this app offers the link. Browser navigation has no reliable
// response, so a returned tab reconciles against a fresh identity read.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const rights = Object.freeze({ open: true, message: false, takeover: false });

function target(canonicalSessionId, nativeTaskId, allowed, hostAvailable, reason) {
  const copyId = typeof canonicalSessionId === 'string' && canonicalSessionId ? canonicalSessionId : null;
  if (!allowed || !hostAvailable || !UUID.test(nativeTaskId ?? '')) {
    return { open: false, href: null, copyId, reason: !hostAvailable ? 'host_unavailable' : reason,
      rights: { open: false, message: false, takeover: false }, autoLaunch: false };
  }
  return { open: true, href: `codex://threads/${nativeTaskId}`, copyId,
    canonicalSessionId, nativeTaskId, reason: null, rights, autoLaunch: false };
}

/** The session read derives actor visibility on CARR's server. */
export function sessionOpenTarget(row, { hostAvailable = false } = {}) {
  const canonical = row?.canonical_session_id;
  const native = row?.native_host_id;
  return target(canonical, native,
    row?.surface === 'codex' && row?.native_host_supported === true && canonical === native,
    hostAvailable, 'native_target_unverified');
}

/** Outcome cards need the producer's explicit canonical-to-native binding. */
export function outcomeOpenTarget(card, { hostAvailable = false } = {}) {
  const canonical = card?.canonical_session_id?.value;
  const native = card?.native_task_id?.value;
  const entry = card?.session_entry;
  return target(canonical, native, Boolean(canonical && entry?.available === true
    && entry.capability === 'codex_desktop_open_v1' && entry.target === native
    && entry.auto_launch === false), hostAvailable, 'native_target_unverified');
}

/** A lost browser handoff stays unknown; this never navigates or retries. */
export function reconcileOpenAttempt(previous, identityPayload, options = {}) {
  if (!previous?.open) return { state: 'not_openable', href: null, autoRetry: false };
  const row = identityPayload?.ok === true && Array.isArray(identityPayload.sessions)
    ? identityPayload.sessions.find(item => item.canonical_session_id === previous.canonicalSessionId)
    : null;
  const fresh = sessionOpenTarget(row, options);
  if (!fresh.open || fresh.href !== previous.href) {
    return { state: 'target_changed', href: null, autoRetry: false };
  }
  return { state: 'same_target_unconfirmed', href: fresh.href, autoRetry: false };
}

export function reconcileOutcomeOpenAttempt(previous, card, options = {}) {
  if (!previous?.open) return { state: 'not_openable', href: null, autoRetry: false };
  const fresh = outcomeOpenTarget(card, options);
  if (!fresh.open || fresh.href !== previous.href
      || fresh.canonicalSessionId !== previous.canonicalSessionId) {
    return { state: 'target_changed', href: null, autoRetry: false };
  }
  return { state: 'same_target_unconfirmed', href: fresh.href, autoRetry: false };
}
