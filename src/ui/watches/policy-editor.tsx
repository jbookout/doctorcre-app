import type { Policy } from "./model.ts";
export function PolicyEditor({
  policy,
  days,
  onDays,
  onChange,
  disabled,
}: {
  policy: Policy;
  days: string;
  onDays: (value: string) => void;
  onChange: (value: Policy) => void;
  disabled: boolean;
}) {
  return (
    <fieldset disabled={disabled}>
      <legend>Watch policy draft</legend>
      {(["reply_arrived", "lease_threshold_crossed"] as const).map((kind) => (
        <label key={kind} style={{ display: "block" }}>
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
          {kind === "reply_arrived" ? "Replies arriving" : "Lease thresholds"}
        </label>
      ))}
      <label style={{ display: "block" }}>
        <input
          type="checkbox"
          checked={policy.include_self_changes}
          onChange={(event) => onChange({ ...policy, include_self_changes: event.target.checked })}
        />
        Include my changes
      </label>
      {policy.change_kinds.includes("lease_threshold_crossed") && (
        <label>
          Days before lease threshold
          <input
            aria-label="Lease threshold days"
            value={days}
            onChange={(event) => onDays(event.target.value)}
            style={{ maxWidth: "100%", boxSizing: "border-box" }}
          />
        </label>
      )}
    </fieldset>
  );
}
