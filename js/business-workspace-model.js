// V5-UX-B01 — what the business Home shows, decided without a DOM.
//
// The command-center payload itself is validated and summarised by
// js/workspace-command-center-model.js, which this slice reuses unchanged. What
// lives here is only what that model does not decide: the ORDER of the Home
// sections, the Team review arithmetic, and the words a section uses when the
// read cannot be verified.
//
// Team review is the viewer's share of the team totals and nothing else. It is
// never a per-partner comparison: the payload carries exactly two scopes, team
// and mine, so a comparison between two named people cannot be computed from it
// and must not be implied by the words around it.
import {
  MY_FLAGGED_DESTINATION, SCOPES, TEAM_ACTIVE_DESTINATION, TEAM_FLAGGED_DESTINATION,
  safeDestination, validWorkspacePayload,
} from "./workspace-command-center-model.js";

/** The Home sections, in the order the page renders them. */
export const HOME_SECTIONS = Object.freeze(["needs_action", "pipeline", "changes", "doc_at_work", "quick_add", "not_in_release", "team_review"]);

export const SECTION_TITLE = Object.freeze({
  needs_action: "Needs action",
  pipeline: "Pipeline",
  changes: "Changes",
  doc_at_work: "Doc at work",
  quick_add: "Quick add",
  not_in_release: "Not in this release",
  team_review: "Team review",
});

/**
 * The three permanent blocks. They are NOT zero counts and they are not read
 * from CARR: `this_week` and `recent_calls` are declared always-empty by the
 * contract, and waiting-on-others has no producer at all. A page that rendered
 * "0" for any of them would be claiming a verified count it never asked for.
 */
export const NOT_IN_RELEASE = Object.freeze([
  "This week: not in this release",
  "Calls: not in this release",
  "Waiting on others: not in this release",
]);

const NEED_LABEL = {
  team_flagged_deals: "Flagged team deals",
  my_flagged_deals: "Your flagged deals",
  needs_joe_work: "System requests for Joe",
};

/** The one sentence a section is allowed to say when its own read is not verified. */
export function unavailableCopy(section) {
  return ({
    needs_action: "Flagged work could not be verified",
    pipeline: "Deal counts could not be verified",
    changes: "Recent changes could not be verified",
    doc_at_work: "Work in progress could not be verified",
    team_review: "Your share could not be verified",
  })[section] || "This read could not be verified";
}

export function needLabel(kind) {
  return NEED_LABEL[kind] || "Flagged work";
}

/**
 * Ordered section descriptors for one payload. A payload the shared model
 * refuses produces the same seven sections with `state: "unavailable"`, because
 * a section that cannot be verified is still a section a person is looking at.
 */
export function homeSections(payload) {
  const valid = validWorkspacePayload(payload);
  return HOME_SECTIONS.map((id) => ({
    id,
    title: SECTION_TITLE[id],
    state: id === "quick_add" || id === "not_in_release" ? "static" : valid ? "read" : "unavailable",
    fromRead: id !== "quick_add" && id !== "not_in_release",
  }));
}

/**
 * The viewer's share of the team totals: two rows, each stating the personal
 * number and the team number it sits inside. `of` is deliberately part of the
 * label — "3 of 11" is a share, and no ordering between partners exists here.
 */
export function teamReviewRows(metrics) {
  if (!Array.isArray(metrics) || metrics.length !== SCOPES.length) return [];
  const [team, mine] = metrics;
  const integer = (value) => Number.isInteger(value) && value >= 0;
  if (![team?.active_deals, team?.flagged_deals, mine?.active_deals, mine?.flagged_deals].every(integer)) return [];
  if (mine.active_deals > team.active_deals || mine.flagged_deals > team.flagged_deals) return [];
  return [
    {
      id: "active",
      label: "Your active deals",
      mine: mine.active_deals,
      team: team.active_deals,
      value: `${mine.active_deals} of ${team.active_deals}`,
      // "mine, active" has no Deal Room URL form, so the row opens the team list it sits inside.
      destination: safeDestination(TEAM_ACTIVE_DESTINATION),
    },
    {
      id: "flagged",
      label: "Your flagged",
      mine: mine.flagged_deals,
      team: team.flagged_deals,
      value: `${mine.flagged_deals} of ${team.flagged_deals}`,
      destination: safeDestination(mine.flagged_deals ? MY_FLAGGED_DESTINATION : TEAM_FLAGGED_DESTINATION),
    },
  ];
}
