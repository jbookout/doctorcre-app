# Triage Labels

Map the skills' canonical roles to CARR Work Request states and classifications.
Work Requests do not carry GitHub labels.

| Label in mattpocock/skills | In CARR Work Requests | Meaning |
| -------------------------- | -------------------- | ------- |
| `needs-triage` | state `captured` | Maintainer needs to evaluate the request |
| `needs-info` | state `needs_joe` | Waiting on the human's scope answer |
| `ready-for-agent` | triaged, classification `operational` | Operational work; readiness still follows the live lifecycle |
| `ready-for-human` | triaged, classification `needs_judgment` or `safety_review` | Requires human judgment or safety review |
| `wontfix` | `decline-work-request`, state `declined` | Will not be actioned |

When a skill says to apply a label, propose this mapping and its reason.
`review-and-triage` is human-only. `answer-work-request-for-joe` requires direct
human authority to return `needs_joe` to triaged. A classification alone does
not authorize dispatch or mark a request ready.
