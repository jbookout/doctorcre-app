// Labels follow the agreed chart. Auxiliary fields record pre-event observations.
export const regions = ["attention","kind","subject","evidence","activity","calls"];
const LABELS = {
	"SelectAttention": "select attention",
	"ClearAttention": "clear attention",
	"LeadChange": "lead change",
	"AuthorizationRetirement": "authorization retirement",
	"Disposal": "disposal",
	"SelectKind": "select kind",
	"ClearKind": "clear kind",
	"AuthorizedReopen": "authorized reopen",
	"SameLeadRefresh": "same lead refresh",
	"LateReadArrival": "late read arrival",
	"ZeroMatch": "zero match",
	"SameLeadRepaint": "same lead repaint"
};


export const readerActions = ["SelectAttention", "ClearAttention", "SelectKind", "ClearKind", "LeadChange", "Disposal", "AuthorizedReopen"];
export const state = (v) => regions.map((r) => v[r]).join(" | ");
export const step = (action) => LABELS[action] ?? action;
