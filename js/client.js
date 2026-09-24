/**
 * Deal Room client interface (WO-1 contract).
 *
 * Both FixtureClient and LiveClient implement this shape. The fixture adapter
 * is in-memory; the live adapter uses authenticated same-origin CARR routes.
 *
 * @typedef {'joe'|'dell'|string} Actor
 * @typedef {'phase'|'owner'|'attention'|'next_date'|'next_step'|'operating_state'} DealField
 *
 * @typedef {Object} PipelineEvent
 * @property {string} id
 * @property {string} recorded_at ISO-8601
 * @property {Actor} actor
 * @property {string} verb
 * @property {string} subject_type
 * @property {string} subject_id
 * @property {string|null} field
 * @property {string|boolean|null} old_value
 * @property {string|boolean|null} new_value
 *
 * @typedef {Object} PresenceLease
 * @property {Actor} actor
 * @property {string} deal_id
 * @property {string} field
 * @property {string} expires_at ISO-8601
 *
 * @typedef {Object} ChangesResponse
 * @property {PipelineEvent[]} events
 * @property {PresenceLease[]} presence
 * @property {string} cursor opaque keyset cursor
 *
 * @typedef {Object} BoardDeal
 * @property {string} id
 * @property {string} name
 * @property {string} type
 * @property {string} phase
 * @property {Actor|null} owner
 * @property {boolean} attention
 * @property {string|null} last_touch
 * @property {string} next_step
 * @property {string|null} next_date
 * @property {string|null} segment
 * @property {string|null} market
 * @property {'active'|'parked'} operating_state whether this Salesforce-linked row is current work
 * @property {'prospect_never_active'|'client_paused'|'other'|null} parking_reason
 * @property {string|null} parking_note
 *
 * @typedef {Object} ThreadEntry
 * @property {string} id
 * @property {'note'|'archived_step'} kind
 * @property {Actor} actor
 * @property {string} text
 * @property {string} recorded_at
 *
 * @typedef {Object} HistoryEntry
 * @property {string} id
 * @property {Actor} actor
 * @property {string} summary
 * @property {string} recorded_at
 *
 * @typedef {Object} DealDetail
 * @property {BoardDeal} deal
 * @property {ThreadEntry[]} thread newest-first
 * @property {{label:string,date:string|null}[]} critical_dates
 * @property {HistoryEntry[]} history newest-first
 *
 * @typedef {Object} ConflictPayload
 * @property {string} conflict_id
 * @property {string} deal
 * @property {string} field
 * @property {{actor:Actor,value:*,event_id:string}} a
 * @property {{actor:Actor,value:*,event_id:string}} b
 *
 * @typedef {Object} WriteResult
 * @property {'ok'|'conflict'} status
 * @property {PipelineEvent} [event]
 * @property {ConflictPayload} [conflict]
 *
 * @typedef {Object} DealRoomClient
 * @property {'fixture'|'live'} mode
 * @property {Actor} selfActor
 * @property {() => Promise<{deals:BoardDeal[], as_of:string, last_call_at:string}>} getBoard
 * @property {(dealId:string) => Promise<DealDetail>} getDeal
 * @property {(cursor:string|null) => Promise<ChangesResponse>} getChanges
 * @property {(args:{deal:string, field:string, idempotency_key:string}) => Promise<{ok:true}>} presenceLease
 * @property {(args:{deal:string, field:string, value:*, base_event_id:string|null, idempotency_key:string}) => Promise<WriteResult>} patchDealField
 * @property {(args:{conflict_id:string, winner:'a'|'b', idempotency_key:string}) => Promise<WriteResult>} resolveConflict
 * @property {(args:{deal:string, text:string, idempotency_key:string}) => Promise<WriteResult>} addDealNote
 * @property {(args:{deal:string, text:string, next_date?:string|null, idempotency_key:string}) => Promise<WriteResult>} setNextStep
 * @property {(args:{name:string, idempotency_key:string}) => Promise<WriteResult>} createDeal
 * @property {() => Promise<{proposals:ConfirmProposal[]}>} [getPendingConfirms]
 * @property {(args:{deal_ids:string[]}) => Promise<{deals:Object[]}>} [getCallContext] exact active agenda records and participants
 * @property {(args:{proposal_id:string, accept:boolean, idempotency_key:string}) => Promise<WriteResult>} [resolveConfirm]
 * @property {(args:{candidate_id:string, accept:boolean, idempotency_key:string}) => Promise<WriteResult>} [resolvePostCallCandidate]
 * @property {() => Promise<void>} [simulatePartnerCall] fixture-only demo of presence + distill
 * @property {(args:{dataset:'clients'|'vendors', id:string}) => Promise<{record:Object}>} [getPartyRecord] the pinned `/api/v1/business/{dataset}/<id>` single-record read (V5-UX-B04); `id` is that record's own uuid, never a participant's party_id
 * @property {(args:{query?:string, limit?:number, include_closed?:boolean}) => Promise<SessionIdentityResponse>} sessionIdentity
 * @property {(args:{session_id:string, cursor?:string, limit?:number}) => Promise<DispatchHistoryResponse>} dispatchHistory
 * @property {(args:{room?:string}) => Promise<RoomQueueResponse>} roomQueue the assignment projection for one room; the room is a constant in js/model-room-model.js and is never the tab's own name
 * @property {(args:{room?:string, after_seq?:number, limit?:number}) => Promise<RoomTurnsResponse>} roomTurns room turns exactly as written; `body` is untrusted prose and is never parsed
 * @property {() => Promise<{ok:boolean, items:Object[]}>} currentWorkRequests the shared Work Request queue; V5-UX-C13a's topic/work-item picker and the "Waiting for Joe" card share this one read
 * @property {() => Promise<{ok:boolean, pending_rule_approvals:Object[], pending_guidance_import_batches:Object[], pending_retrieval_proposals:Object[], counts:Object}>} governanceQueue every pending governance decision (V5-UX-C14's approvals card); read-only, grants no authority
 * @property {(args:{work_request:string}) => Promise<Object>} workRequestCard one Work Request card, live or withdrawn; V5-UX-C13a reads it for a work item's ledger history and the enriched "Waiting for Joe" fields
 * @property {(args:{conversation_id:string, after_sequence?:number, limit?:number}) => Promise<DocConversation>} readDocConversation
 * @property {(args:{cursor?:string, limit?:number, include_archived?:boolean}) => Promise<DocConversationList>} listDocConversations
 * @property {(args:{idempotency_key:string, title:string, visibility?:'private'|'shared'}) => Promise<{ok:true, conversation_id:string}>} createDocConversation
 * @property {(args:{idempotency_key:string, conversation_id:string, base_version:number, title?:string, pinned?:boolean, archived?:boolean}) => Promise<{ok:true, version:number}>} renameDocConversation
 * @property {(args:{idempotency_key:string, conversation_id:string, grantee_slug:string, granted:boolean}) => Promise<{ok:true, already:boolean, granted:boolean}>} shareDocConversation
 * @property {(args:{cursor?:string, limit?:number}) => Promise<DocOutcomeCardsResponse>} docOutcomeCards actor- and tenant-scoped, page-atomic outcome cards (V5-UX-B09); the producer never launches a native task, and `session_entry.auto_launch` is always `false`
 *
 * The projection `read-doc-outcome-cards` returns (schema `doc-outcome-cards.v2`,
 * mcp-server/src/tools.js `docOutcomeCardsProjection`). Every card carries its
 * own `routing_state` (queued/active/waiting/failed/unknown/verified) and marks
 * `next_check`/`result` unavailable rather than fabricating either; opening the
 * exact session is S02 clause 3 and no adapter is wired here, so
 * `session_entry` only ever offers a session ref to resume by hand.
 *
 * @typedef {Object} DocOutcomeCardsResponse
 * @property {true} ok
 * @property {'doc-outcome-cards.v2'} schema_version
 * @property {string} as_of
 * @property {string} correlation_version
 * @property {boolean} more
 * @property {string|null} next_cursor
 * @property {DocOutcomeCard[]} cards
 *
 * @typedef {Object} DocOutcomeCard
 * @property {string} card_id
 * @property {string|null} requested_outcome
 * @property {'recommendation'|'submission'} intent_kind
 * @property {string} work_request_ref
 * @property {string|null} owner
 * @property {string|null} controlled_phase
 * @property {{state:'fresh'|'stale', observed_at:string, source_ref:string}} source_freshness
 * @property {'queued'|'active'|'waiting'|'failed'|'unknown'|'verified'} routing_state
 * @property {{observed_at:string, routing_source:string}} state_evidence
 * @property {{value:string|null, unavailable_reason:string|null}} job_id
 * @property {{value:string|null, unavailable_reason:string|null}} attempt_id
 * @property {{value:string|null, unavailable_reason:string|null}} canonical_session_id
 * @property {{value:string|null, unavailable_reason:string|null}} native_task_id
 * @property {{available:boolean, value:string|null, unavailable_reason:string|null}} next_check
 * @property {{available:boolean, value:string|null, unavailable_reason:string|null}} result
 * @property {{available:boolean, target:string|null, capability:string|null, unavailable_reason:string|null, fallback:{kind:string,value:string}|null, auto_launch:false}} session_entry
 *
 * The projection `read-doc-conversation` returns. The identity and the turns are
 * kept apart because a rename moves the identity and must move nothing else, and
 * `visible_conversation_count` is a FLEET fact: it is computed inside the
 * definer over what the acting actor may see, and both the single read and the
 * list door return it.
 *
 * @typedef {Object} DocConversation
 * @property {{id:string,title:string,visibility:'private'|'shared',pinned_at:string|null,archived_at:string|null,version:number,created_by:string}} identity
 * @property {{sequence:number,role:'human'|'assistant'|'system',body:string,msg_id:string|null,origin_channel:string|null,origin_actor:string|null,at:string}[]} turns
 * @property {number} latest_sequence
 * @property {boolean} more
 * @property {{grantee_actor:string,granted_at:string,granted_by_actor:string}[]} effective_grants
 * @property {number} visible_conversation_count
 *
 * The projection `list-doc-conversations` returns. Its rows carry no turns: a
 * list is identity and recency, and the words of a conversation are read one
 * conversation at a time. `next_cursor` is OPAQUE — it is passed back unread.
 *
 * @typedef {Object} DocConversationList
 * @property {{id:string,title:string,visibility:'private'|'shared',pinned_at:string|null,archived_at:string|null,version:number,created_by:string,latest_sequence:number,latest_turn_at:string|null}[]} conversations
 * @property {boolean} more
 * @property {string|null} next_cursor
 * @property {number} visible_conversation_count
 *
 * The projection `read-session-identity` returns (V5-UX-S02). `total_returned`
 * is the post-permission-filter total BEFORE `limit`, so it is NOT the length of
 * `sessions` and no consumer may render it as one. `permission_filtered` is what
 * separates a filtered empty answer from an empty system.
 *
 * @typedef {Object} SessionIdentityRow
 * @property {string} canonical_session_id
 * @property {'claude'|'codex'|'capability'|'harvested'} surface
 * @property {string} display_name
 * @property {'human'|'derived'} alias_source never 'human' today: no store holds one
 * @property {string|null} parent_session_id
 * @property {boolean} parent_known false means unknown, never "no parent"
 * @property {string|null} native_host_id
 * @property {boolean} native_host_supported
 * @property {'working'|'idle'|'complete_unacknowledged'|'disconnected'|'unknown'} work_state
 * @property {string} work_state_evidence the observation the state rests on
 * @property {string} last_observed_at ISO-8601
 * @property {'continuity_event'|'checkpoint'|'server_session'|'harvest'} observation_source
 * @property {string|null} project_affinity
 * @property {string|null} latest_cwd
 * @property {string|null} latest_model_id
 * @property {number} attempt_count
 * @property {string|null} latest_attempt_ref
 *
 * @typedef {Object} SessionIdentityResponse
 * @property {true} ok
 * @property {boolean} permission_filtered
 * @property {number} total_seen everything the query matched
 * @property {number} total_returned what the actor may see, before `limit`
 * @property {SessionIdentityRow[]} sessions
 *
 * The projection `read-dispatch-history` returns (V5-UX-S02 plus WR-000119).
 * Every stage carries its own evidence. A null received/acknowledged value is
 * unavailable, never false; the per-dispatch reason distinguishes a silent
 * linked desk from pre-spine body-matched history.
 *
 * @typedef {Object} DispatchEvent
 * @property {string} event_id
 * @property {string} at ISO-8601
 * @property {'sent'|'received'|'acknowledged'|'acted'} stage
 * @property {string} stage_evidence
 * @property {string|null} rationale
 * @property {string|null} from_seat
 * @property {string|null} to_seat
 * @property {string|null} sponsor
 * @property {string|null} room_id
 * @property {string} session_id
 * @property {string|null} parent_session_id
 * @property {string|null} attempt_ref
 * @property {string|null} superseded_by
 * @property {string|null} work_request_ref
 * @property {'proved'|'body_match'|null} link_source
 * @property {string|null} dispatch_ref
 * @property {'not_acknowledged'|'no_dispatch_spine'|null} stage_unavailable_reason
 *
 * @typedef {Object} DispatchHistoryResponse
 * @property {true} ok
 * @property {string} session_id
 * @property {string|null} parent_session_id
 * @property {boolean} permission_filtered
 * @property {number} total_seen
 * @property {number} total_returned
 * @property {boolean} more
 * @property {string|null} next_cursor
 * @property {string|null} received newest proved received timestamp, else null
 * @property {string|null} acknowledged newest proved acknowledged timestamp, else null
 * @property {string|null} stage_unavailable_reason
 * @property {DispatchEvent[]} events newest first
 *
 * @typedef {Object} QueueCard V5-UX-C12. Every field is one the producer already validated.
 * @property {string} title
 * @property {string} target
 * @property {string|Object} effective_model a string OR an object; the producer checks both, so a view needs a branch
 * @property {string} status
 * @property {string} priority
 * @property {string} cap
 * @property {string} updated_at
 * @property {number|null} source_seq
 *
 * @typedef {Object} QueueEvent
 * @property {1} v
 * @property {'carr-build'} board
 * @property {number} event_id
 * @property {string} event
 * @property {string} task_id
 * @property {QueueCard} card
 * @property {string} summary
 * @property {string} projected_at
 *
 * @typedef {Object} RoomQueueResponse
 * @property {true} ok
 * @property {string} room the room the projection was read FROM, which is the server's answer and not the argument
 * @property {QueueEvent[]} events already sorted by card.updated_at descending, archived removed
 * @property {string|null} projected_at null means nothing has EVER been projected here, which is not staleness
 * @property {boolean} live a 120-second window around projected_at, not an opinion
 *
 * @typedef {Object} RoomTurn
 * @property {string|number} seq a bigint, serialised as a decimal string by the driver
 * @property {string} room_id
 * @property {string} at
 * @property {string} sponsor
 * @property {string} seat
 * @property {string} kind
 * @property {string} body untrusted prose, never parsed, even when it is valid JSON
 * @property {string} msg_id
 * @property {string} origin_channel
 * @property {string} origin_actor
 *
 * @typedef {Object} RoomTurnsResponse
 * @property {true} ok
 * @property {string} room
 * @property {RoomTurn[]} turns oldest first, exactly as written
 * @property {string|number} latest_seq the caller's poll cursor; a quiet room returns the `after` it was given
 * @property {boolean} more true means this is a window, never a total
 *
 * @typedef {Object} ConfirmProposal
 * @property {string} id
 * @property {string} label HTML-safe plain text description
 * @property {string} deal_id
 * @property {string} verb
 * @property {Object} args
 */

// The eight deal phases, one UI value per `deal_phase` slug.
//
// "Site selection" was added in V5-UX-B03: the phase existed in the record layer
// and had no board column, so both it and `research` were shown as "Research"
// and writing that label back relocated a site-selection deal (defect 5e355b84).
// The two long-standing labels are deliberately unchanged — the Deal Room table
// has shown "On Deck" and "Diligence" since it shipped — and the Kanban prints
// each phase's own name over these values instead.
export const PHASES = [
  'On Deck',
  'Research',
  'Site selection',
  'Negotiation',
  'Legal',
  'Diligence',
  'Closing',
  'Closed',
];

// The display word for each wire phase. The wire words above are what the
// record layer, the fixture validation and the change feed all speak, so they
// never move; these are the words a human reads. Six are identical; two are
// not, and those two are the reason this map exists.
export const PHASE_LABEL = {
  'On Deck': 'Pending',
  Diligence: 'Due diligence',
};

/** The display word for a phase wire value; the value itself when unmapped. */
export function phaseLabel(value) {
  return PHASE_LABEL[value] ?? value;
}

export const PHICON = {
  'On Deck': '🔥',
  Research: '🔍',
  'Site selection': '📍',
  Negotiation: '🤝',
  Legal: '⚖️',
  Diligence: '📋',
  Closing: '🔑',
  Closed: '✅',
};

export const ACTOR_LABEL = { joe: 'Joe', dell: 'Dell' };

/**
 * @param {'fixture'|'live'} mode
 * @param {Object} [opts]
 * @returns {Promise<import('./client.js').DealRoomClient>}
 */
export async function createClient(mode = 'fixture', opts = {}) {
  if (mode === 'live') {
    const { createLiveClient } = await import('./live-client.js');
    return createLiveClient(opts);
  }
  const { createFixtureClient } = await import('./fixture-client.js');
  return createFixtureClient(opts);
}
