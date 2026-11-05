// Aggregate exports for self-contained Node test bundles. Browser entries are
// selected separately in scripts/ui-bundle.mjs.
export { hostNode } from "./host-node";
export { mountAnswerBlocks, disposeAnswerBlocks } from './answer-blocks';
export { mountWorkspace } from "./workspace-shell";
export { mountZoomableWorkspace } from "./workspace-zoom";

export { mountFactReview } from "./fact-review";

export { mountMarketTerms } from "./market-terms";

export { homeListLimit } from './home-list-limit';
export { createContactReasonsView } from './contact-reasons';
export { briefQueueIdentity, briefQueueLabels, briefQueueTitle, createBriefQueueView } from './brief-queues';

export { mountActionLink } from './action-link';

export { mountMissingNextStep } from "./home/missing-next-step";

export * as homeTaskDone from './home/task-done';

export { mountDealUpdateReviews } from './home/deal-update-reviews';

export { mountCallReview, mountCallReviewDialog } from './call-review';

export { mountDealRoomBoard } from './deal-room-board';

export { mountDealRoomAgenda } from './deal-room-agenda';

export { mountLeadGuidance } from "./lead-guidance";
export { mountTerritoryEvidence } from './territory-evidence';

export { mountIdealClientProfile } from './ideal-client-profile';
export { mountDealTours } from './deal-tours';
export { mountDealDocuments } from './deal-documents';

export { mountDealTourProposals, createTourProposalClient } from './deal-tour-proposals';
export { createTourProposalFixture } from './tour-proposal-fixture';
