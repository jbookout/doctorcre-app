import type { ExactCard } from "./exact-action-card.ts";

const describeChange = (row: Record<string, unknown>) => {
  if (typeof row.description === "string") return row.description;
  const payload = row.payload;
  if (typeof payload === "object" && payload !== null) {
    for (const key of ["action", "summary", "text", "body", "subject", "next_date"]) {
      if (key in payload) {
        const value: unknown = Reflect.get(payload, key);
        if (typeof value === "string") return value;
      }
    }
  }
  return typeof row.kind === "string" ? row.kind.replaceAll("_", " ") : "Review item";
};
export function ExactActionCardView({ card }: { card: ExactCard }) {
  return (
    <article data-exact-card-id={card.id} data-exact-card-kind={card.kind} data-source-version={card.source_version}>
      <h2>
        {card.kind === "post_call_review"
          ? "Post-call review"
          : card.kind === "feedback_event"
            ? "Client tour feedback"
            : "Reply draft"}
      </h2>
      <p role="status">
        {card.state === "retired"
          ? "This source is no longer available."
          : card.state === "stale"
            ? "This card changed. Open its current version before acting."
            : card.state === "resolved"
              ? "Resolved"
              : "Awaiting your review"}
      </p>
      <p>Reference: {card.id}</p>
      {card.kind === "reply_draft" && card.state === "stale" && (
        <>
          <h3>{card.subject}</h3>
          <div className="action-link-message">{card.body}</div>
        </>
      )}
      {card.kind === "post_call_review" && card.detail && (
        <>
          <p>
            Call started <time dateTime={card.detail.started_at}>{card.detail.started_at}</time>
          </p>
          <ul>
            {[...card.detail.candidates, ...card.detail.changes].map((row) => (
              <li key={typeof row.id === "string" ? row.id : JSON.stringify(row)}>
                <span>{describeChange(row)}</span>
                {typeof row.assignee === "string" && <p>Assigned to {row.assignee}</p>}
                {typeof row.due_on === "string" && (
                  <p>
                    Due <time dateTime={row.due_on}>{row.due_on}</time>
                  </p>
                )}
                {typeof row.subject === "string" && <p>Subject: {row.subject}</p>}
                {typeof row.evidence_quote === "string" && <blockquote>{row.evidence_quote}</blockquote>}
              </li>
            ))}
          </ul>
          {card.state === "pending_review" && (
            <p>Marking this call reviewed takes it off Home. It does not approve these proposed changes.</p>
          )}
        </>
      )}
      {card.kind === "feedback_event" && card.detail && (
        <>
          <p>Property: {card.detail.property_id}</p>
          {card.detail.action === "comment" ? (
            <div className="action-link-message">{card.detail.comment}</div>
          ) : (
            <p>{card.detail.shortlisted ? "Added to shortlist" : "Removed from shortlist"}</p>
          )}
          <time dateTime={card.detail.created_at}>{card.detail.created_at}</time>
        </>
      )}
    </article>
  );
}
