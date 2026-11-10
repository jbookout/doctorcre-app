import type { Policy } from "./model.ts";
export function PolicyEditor({
  policy,
  days,
  onDays,
  months,
  onMonths,
  onChange,
  disabled,
}: {
  policy: Policy;
  days: string;
  onDays: (value: string) => void;
  months: string;
  onMonths: (value: string) => void;
  onChange: (value: Policy) => void;
  disabled: boolean;
}) {
  return (
    <fieldset className="watch-editor" disabled={disabled}>
      <legend>Watch settings</legend>
      {(["reply_arrived", "lease_threshold_crossed"] as const).map((kind) => (
        <label key={kind} className="watch-option">
          <input
            type="checkbox"
            checked={policy.change_kinds.includes(kind)}
            onChange={(event) =>
              onChange({
                ...policy,
                change_kinds: event.target.checked
                  ? [...policy.change_kinds, kind]
                  : policy.change_kinds.filter((value) => value !== kind),
              })
            }
          />
          {kind === "reply_arrived" ? "Replies to this record" : "Lease date reminders"}
        </label>
      ))}
      <label className="watch-option">
        <input
          type="checkbox"
          checked={policy.include_self_changes}
          onChange={(event) => onChange({ ...policy, include_self_changes: event.target.checked })}
        />
        Include changes I make
      </label>
      <p className="watch-detail">Replies covers new replies. Lease reminders covers approaching lease dates.</p>
      {policy.change_kinds.includes("lease_threshold_crossed") && (
        <>
          <label className="watch-days">
            Days before the lease date (comma-separated)
            <input
              aria-label="Lease threshold days"
              value={days}
              onChange={(event) => onDays(event.target.value)}
              style={{ maxWidth: "100%", boxSizing: "border-box" }}
            />
          </label>
          <label className="watch-days">
            Calendar months before the lease date (comma-separated)
            <input
              aria-label="Lease threshold calendar months"
              value={months}
              onChange={(event) => onMonths(event.target.value)}
              style={{ maxWidth: "100%", boxSizing: "border-box" }}
            />
          </label>
          <p className="watch-detail">
            Leave either list empty to remove it. Lease reminders need days, calendar months, or both.
          </p>
        </>
      )}
    </fieldset>
  );
}
