// V5-UX-B07 — what the Doc conversations page shows, decided without a DOM.
//
// The producer is `mcp-server/src/doc-conversation.js` over migrations 0520 and
// 0523, and every rule below is a reading of what those five verbs can actually
// do. Six shapes govern the file, and each one exists because the alternative
// would let the page say something the record layer cannot back.
//
//   1. THE LIST COMES FROM THE RECORD LAYER. `list-doc-conversations` returns
//      the conversations the signed-in actor may see, pinned first then most
//      recently updated, paged by an opaque cursor. That order is the store's
//      and it is NEVER re-sorted here: re-ordering would be this page inventing
//      a precedence the record layer did not state.
//   2. NOTHING NAMES AN ACTOR. The list verb declares exactly three optional
//      fields — `cursor`, `limit`, `include_archived` — with
//      `additionalProperties:false`, and derives the acting actor itself. An
//      actor field sent from here would be a schema error, and that is the
//      point: the app cannot ask to see somebody else's conversations.
//   3. "Absent" and "not yours" are ONE answer. The read function returns
//      `doc_conversation_not_found` for a conversation that does not exist, for
//      one that is not shared with the caller, and for an id that is not a uuid.
//      A friendlier sentence here would ship the disclosure the record layer is
//      built to withhold, so the page says it cannot tell the two apart.
//   4. Rename, pin and archive all ride ONE verb on a compare-and-swap. The
//      `base_version` comes from the payload of the read that is on screen and
//      from nowhere else: nothing here defaults, increments or invents one, and
//      a `version_conflict`'s `current_version` is evidence that something moved,
//      never a licence to overwrite whatever moved it.
//   5. Sharing takes NO base version. `share-doc-conversation` declares four
//      fields and refuses any other, so sending one would be a schema error.
//   6. NOTHING HERE WRITES A TURN. `add-doc-conversation-turn` is authorityOnly
//      and the app holds no authority binding, so this page shows a sentence
//      where a composer would be rather than a box that could not send.
import { formatClock } from "./visual-system.js";
import { REFUSAL_SENTENCE } from "./status-model.js";

export { REFUSAL_SENTENCE };

/* --------------------------------------------------------------- the sentences */

/** Where a composer would be. Not a disabled input: there is no door behind one. */
export const COMPOSER_ABSENT =
  "You cannot write into this conversation from here yet. The only door that appends a turn is reserved for an authority session, so this page shows the history and does not offer a box that could not send.";
export const DOC_REPLY_PENDING =
  "Doc's replies arrive in the next slice. Nothing on this page is waiting on an answer.";

/** What the list IS, said before anybody mistakes it for a feed. */
export const LIST_SCOPE =
  "This list is read from the record layer: the conversations you created and the ones shared with you, pinned first and then most recently updated. It is not a roster kept on this device.";
export const LIST_EMPTY =
  "You have no conversation yet. Create one below.";

/** The standing caveat the share control carries, in the slice's own words. */
export const SHARING_CAVEAT =
  "Turning sharing off ends future access. It cannot unsee what a partner already read.";

/** §10 item 3: the title history exists, and no door reads it back. */
export const TITLE_HISTORY_UNREADABLE =
  "The record layer keeps every previous title of this conversation, but no door reads them back yet, so this page shows only the name it has now.";

/** The candid mobile-exposure statement rule f0f9156e asks a page to make. */
export const EXPOSURE_STATEMENT =
  "This page shows the words of your conversations with Doc, so on a shared or unlocked phone a passer-by reads them at a glance — and the list above names every conversation you can see. The record layer's membership check is the only gate and this app adds none. Nothing is kept on this device and nothing here is cached offline: close the page and it is gone until the record layer answers again.";

/** The refusals this page raises before anything is sent. */
export const VERSION_REFUSAL =
  "This page has not read this conversation's version yet. Nothing was sent.";
export const NO_CHANGE_REFUSAL =
  "A rename has to change the title, the pin or the archive state. Nothing was sent.";
export const ID_REFUSAL =
  "A conversation is identified by the id the record layer minted. Nothing was sent.";
export const TITLE_REFUSAL =
  "A conversation needs a title of 1 to 200 characters. Nothing was sent.";

/** The two partner slugs this workspace has. The page invents no third. */
export const PARTNER_SLUGS = Object.freeze(["joe", "dell"]);

/** The page of conversations this page asks the list door for. */
export const LIST_PAGE_SIZE = 25;

/**
 * The verb's OWN uuid shape (`doc-conversation.js:30`), copied exactly. The
 * looser shape used elsewhere in this app would let a nil uuid through, and the
 * record layer would answer that with the same not-found the page must not
 * conflate with a refusal it caused itself.
 */
export const CONVERSATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isText = (value) => typeof value === "string" && value.length > 0;

/* ------------------------------------------------------------------- the route */

/**
 * The conversation this page was opened on, read from the query string alone.
 *
 * Three answers, and the two failures are different on purpose: a bare page is
 * a person who arrived with no link and should be given the list, while a
 * malformed one is a person holding something that looks like an id and is not.
 */
export function idFromSearch(search) {
  const params = new URLSearchParams(typeof search === "string" ? search : "");
  const raw = params.get("id");
  if (raw === null || raw.trim() === "") return { state: "missing", id: null, given: null };
  const id = raw.trim();
  if (!CONVERSATION_ID.test(id)) return { state: "malformed", id: null, given: id };
  return { state: "ok", id, given: id };
}

/* ----------------------------------------------------------------- the payload */

/** `read-doc-conversation`'s own shape: the identity, the turns, the grants. */
export function validDocConversationPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  const identity = payload.identity;
  if (!identity || typeof identity !== "object") return false;
  if (!CONVERSATION_ID.test(String(identity.id)) || !isText(identity.title)) return false;
  if (!Number.isInteger(identity.version) || identity.version < 1) return false;
  if (!Array.isArray(payload.turns) || !Array.isArray(payload.effective_grants)) return false;
  return Number.isInteger(payload.visible_conversation_count);
}

/* ------------------------------------------------------------------ the header */

/**
 * The identity strip. Private versus shared is this slice's central
 * distinction, so each state carries its own WORD and its own GLYPH as well as
 * its own accent — colour is never the only carrier of the difference between
 * "only you" and "your partner can read this".
 */
export function identityHeader(payload) {
  if (!validDocConversationPayload(payload)) return null;
  const identity = payload.identity;
  const grantees = accessRows(payload).map((row) => row.grantee);
  const shared = identity.visibility === "shared";
  return {
    id: identity.id,
    title: identity.title,
    visibility: shared ? "shared" : "private",
    glyph: shared ? "🔓" : "🔒",
    word: shared
      ? `Shared — ${grantees.length ? grantees.join(", ") : "no one right now"}`
      : "Private — only you",
    version: identity.version,
    createdBy: isText(identity.created_by) ? identity.created_by : "unattributed",
    pinned: isText(identity.pinned_at),
    pinnedClock: formatClock(identity.pinned_at) || null,
    archived: isText(identity.archived_at),
    archivedClock: formatClock(identity.archived_at) || null,
  };
}

/**
 * The authoritative count line, printed from `list-doc-conversations`' own
 * `visible_conversation_count`. The page never counts the rows it happens to
 * be holding: the scalar is computed inside the definer over everything the
 * ACTING actor may see, and a first page of 25 is not that number.
 */
export function visibleCountLine(listPayload) {
  if (!validDocConversationListPayload(listPayload)) return "unknown";
  const visible = listPayload.visible_conversation_count;
  if (!Number.isInteger(visible)) return "unknown";
  return `You can see ${visible} ${visible === 1 ? "conversation" : "conversations"}.`;
}

/* ------------------------------------------------------------------- the turns */

/**
 * One row per turn, in the SERVER'S order. `sequence` is the record layer's own
 * ordering and is never re-sorted here: a page that re-ordered a transcript
 * would be inventing a conversation that did not happen.
 */
export function turnRows(payload) {
  if (!validDocConversationPayload(payload)) return [];
  return payload.turns
    .filter((row) => row && typeof row === "object" && Number.isInteger(row.sequence))
    .map((row) => ({
      sequence: row.sequence,
      role: isText(row.role) ? row.role : "unattributed",
      body: isText(row.body) ? row.body : "",
      msgId: isText(row.msg_id) ? row.msg_id : null,
      channel: isText(row.origin_channel) ? row.origin_channel : null,
      actor: isText(row.origin_actor) ? row.origin_actor : null,
      clock: formatClock(row.at) || "unknown",
    }));
}

/**
 * Whether a "Show more" control exists at all, and what it would ask for. The
 * control appears ONLY when the server said `more: true`; a page that offered
 * it otherwise would be inviting a read the record layer already answered.
 *
 * `after_sequence` IS INCLUSIVE. `ops.doc_conversation_facts` selects
 * `where sequence >= v_after` (0520:198) after clamping the argument at zero
 * (0520:182), so naming the last sequence already rendered asks the store to
 * send that turn AGAIN — and this page appends what comes back, which would
 * render a message that was said once twice. The offset is therefore
 * `last + 1`: the client speaks the producer's own predicate.
 *
 * The alternative — keep `last` and drop the overlapping turn on merge — was
 * rejected. It leaves the page asking for a turn it already holds, pays for it
 * over the wire, and hides a wrong request behind a correction layer that every
 * future caller of this model would have to remember to apply.
 */
export function pagingState(payload) {
  if (!validDocConversationPayload(payload)) return { more: false, after: null };
  const rows = turnRows(payload);
  if (payload.more !== true || rows.length === 0) return { more: false, after: null };
  return { more: true, after: rows[rows.length - 1].sequence + 1 };
}

/* ------------------------------------------------------------------ the access */

/** The effective access list: the unrevoked grants the read returned, as rows. */
export function accessRows(payload) {
  if (!validDocConversationPayload(payload)) return [];
  return payload.effective_grants
    .filter((row) => row && typeof row === "object" && isText(row.grantee_actor))
    .map((row) => ({
      grantee: row.grantee_actor,
      clock: formatClock(row.granted_at) || "unknown",
      grantedBy: isText(row.granted_by_actor) ? row.granted_by_actor : "unattributed",
    }));
}

/**
 * One share control per partner slug. The creator is never offered a grant to
 * themselves — `share-doc-conversation` answers that with
 * `doc_conversation_grantee_is_creator` — and no free-text actor field exists,
 * because the verb resolves the slug itself and refuses anything else.
 */
export function shareCandidates(payload, slugs = PARTNER_SLUGS) {
  if (!validDocConversationPayload(payload)) return [];
  const creator = String(payload.identity.created_by || "");
  const granted = new Set(accessRows(payload).map((row) => row.grantee));
  return (Array.isArray(slugs) ? slugs : [])
    .filter((slug) => isText(slug) && slug !== creator)
    .map((slug) => ({ slug, granted: granted.has(slug) }));
}

/* -------------------------------------------------------------------- the list */

/** `list-doc-conversations`' own shape: the rows, the paging, the scalar. */
export function validDocConversationListPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  return Array.isArray(payload.conversations);
}

/**
 * What this page sends to `list-doc-conversations`, and it is the WHOLE request.
 *
 * The verb declares exactly three optional properties and `additionalProperties:
 * false`, so a fourth key — an actor above all — is a schema error rather than a
 * refusal the page could explain. `cursor` is opaque: it is the `next_cursor`
 * the previous page returned, passed back unread and never constructed here.
 */
export function listArgs({ cursor = null, includeArchived = false } = {}) {
  const args = { limit: LIST_PAGE_SIZE };
  if (isText(cursor)) args.cursor = cursor;
  if (includeArchived === true) args.include_archived = true;
  return args;
}

/**
 * The rows, IN THE ORDER THE VERB RETURNED THEM. Pinned first then most
 * recently updated is the store's ordering (its own `order by`), and nothing
 * here sorts, groups or re-buckets it. A page that re-ordered this list would
 * be asserting a precedence the record layer never stated, and the two would
 * disagree the moment the store's rule changed.
 */
export function listRows(payload) {
  if (!validDocConversationListPayload(payload)) return [];
  return payload.conversations
    .filter((row) => row && typeof row === "object" && CONVERSATION_ID.test(String(row.id)))
    .map((row) => ({
      id: row.id,
      title: isText(row.title) ? row.title : "untitled",
      visibility: row.visibility === "shared" ? "shared" : "private",
      pinned: isText(row.pinned_at),
      archived: isText(row.archived_at),
      version: Number.isInteger(row.version) ? row.version : null,
      latestSequence: Number.isInteger(row.latest_sequence) ? row.latest_sequence : null,
      latestClock: formatClock(row.latest_turn_at) || null,
    }));
}

/**
 * Whether a "Show more" control exists, and the cursor it would carry.
 *
 * The control appears ONLY when the verb said `more: true` AND handed back a
 * cursor. There is no offset and no page number to fall back on: the cursor is
 * the only thing that names where the next page starts, so a `more` with no
 * cursor is not a page this client can ask for.
 */
export function listPagingState(payload) {
  if (!validDocConversationListPayload(payload)) return { more: false, cursor: null };
  if (payload.more !== true || !isText(payload.next_cursor)) return { more: false, cursor: null };
  return { more: true, cursor: payload.next_cursor };
}

/* -------------------------------------------------------------- the UX20 states */

/** The eight states, each with the sentence the page renders. */
export const CONVERSATION_STATES = Object.freeze({
  loading: "Reading this conversation…",
  ready: "",
  empty: "This conversation has no turns yet.",
  not_found: "No conversation with that link is visible to you. It may not exist, or it may not be shared with you — the record layer answers those the same way on purpose, so this page cannot tell you which.",
  malformed: "That link does not carry a conversation id.",
  stale: "This is the last picture that landed. A newer read has not answered yet.",
  unavailable: "The conversation did not answer. It may have been served; nothing was retried for you.",
  refused: "The record layer refused this read. It was decided before the verb ran, and nothing was read.",
});

/**
 * The refusal a failed read is turned into, from the STATUS and the CODE alone.
 * The server's prose never travels.
 *
 *  - `doc_conversation_not_found` is the record layer's ONE answer for absent
 *    and for not-permitted. The page renders it as exactly that ambiguity.
 *  - 401/403 is a DECISION taken before the verb ran. Nothing was read.
 *  - any other HTTP status is the path failing around a request that may well
 *    have been served.
 */
export function classifyReadFailure(error) {
  const code = error?.payload?.error || null;
  const status = Number(error?.status ?? 0) || null;
  if (code === "doc_conversation_not_found") {
    return { state: "not_found", sentence: CONVERSATION_STATES.not_found };
  }
  if (status === 401 || status === 403) return { state: "refused", sentence: CONVERSATION_STATES.refused };
  if (status) return { state: "unavailable", sentence: CONVERSATION_STATES.unavailable };
  return { state: "unavailable", sentence: REFUSAL_SENTENCE };
}

/**
 * Which of the eight states this page is in. Order is the whole design: a
 * refusal outranks an empty transcript, because an empty transcript drawn over
 * a refusal reads as "nothing was said" when the truth is "we were not told".
 */
export function conversationState(read = {}, route = { state: "ok" }) {
  if (route?.state === "malformed") return { state: "malformed", sentence: CONVERSATION_STATES.malformed };
  if (read.state === "refused") return { state: "refused", sentence: CONVERSATION_STATES.refused };
  if (read.state === "not_found") return { state: "not_found", sentence: CONVERSATION_STATES.not_found };
  if (read.state === "unavailable") return { state: "unavailable", sentence: read.sentence || CONVERSATION_STATES.unavailable };
  const has = read.state === "read" && validDocConversationPayload(read.payload);
  if (read.refreshing === true && has) return { state: "stale", sentence: CONVERSATION_STATES.stale };
  if (!has) return { state: "loading", sentence: CONVERSATION_STATES.loading };
  if (read.payload.turns.length === 0 && read.payload.latest_sequence === -1) {
    return { state: "empty", sentence: CONVERSATION_STATES.empty };
  }
  return { state: "ready", sentence: null };
}

/* ---------------------------------------------------------------- the four keys */

/**
 * One operation per intent PER SUBJECT, so two controls never share a key and a
 * retry of one never replays another.
 */
export const createOperationKey = () => "conversations:create";
export const renameOperationKey = (id) => `conversations:rename:${id}`;
export const pinOperationKey = (id) => `conversations:pin:${id}`;
export const archiveOperationKey = (id) => `conversations:archive:${id}`;
export const shareOperationKey = (id, slug) => `conversations:share:${id}:${slug}`;

/* ------------------------------------------------------------- the three writes */

const validTitle = (value) => {
  const title = String(value ?? "").trim();
  return title.length >= 1 && title.length <= 200 ? title : null;
};

/**
 * `create-doc-conversation`. The kernel mints the key, and the key BECOMES the
 * conversation id, so nothing here adds, defaults or trims one into shape — a
 * second key would be a second conversation.
 */
export function createArgs({ title, visibility = "private" } = {}) {
  const clean = validTitle(title);
  if (!clean) return { ok: false, message: TITLE_REFUSAL };
  return { ok: true, args: { title: clean, visibility: visibility === "shared" ? "shared" : "private" } };
}

/**
 * `rename-doc-conversation`, which rename, pin and archive all ride.
 *
 * The version comes from the payload of the read that is on screen and from
 * nowhere else. Nothing defaults, increments or invents one, and a conflict's
 * `current_version` is never used as the next `base_version`: it is evidence
 * that something moved, not a licence to overwrite whatever moved it.
 */
export function renameArgs(payload, { title, pinned, archived } = {}) {
  if (!validDocConversationPayload(payload)) return { ok: false, message: VERSION_REFUSAL };
  const { id, version } = payload.identity;
  if (!Number.isInteger(version) || version < 1) return { ok: false, message: VERSION_REFUSAL };
  const args = { conversation_id: id, base_version: version };
  if (title !== undefined) {
    const clean = validTitle(title);
    if (!clean) return { ok: false, message: TITLE_REFUSAL };
    args.title = clean;
  }
  if (pinned !== undefined) args.pinned = pinned === true;
  if (archived !== undefined) args.archived = archived === true;
  if (args.title === undefined && args.pinned === undefined && args.archived === undefined) {
    return { ok: false, message: NO_CHANGE_REFUSAL };
  }
  return { ok: true, args };
}

/**
 * `share-doc-conversation`. It takes NO base version — sharing does not bump
 * the conversation's version, and `additionalProperties:false` would turn one
 * into a schema error — and all four of its fields are required.
 */
export function shareArgs(id, slug, granted) {
  const conversation = String(id || "").trim();
  if (!CONVERSATION_ID.test(conversation)) return { ok: false, message: ID_REFUSAL };
  const grantee = String(slug || "").trim();
  if (!isText(grantee)) return { ok: false, message: ID_REFUSAL };
  return { ok: true, args: { conversation_id: conversation, grantee_slug: grantee, granted: granted === true } };
}
