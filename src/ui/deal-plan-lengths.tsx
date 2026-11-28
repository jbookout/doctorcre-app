import { useEffect, useState } from "react";
import { PHASES } from "./deal-plan-model.ts";

type Length = {
  phase: keyof typeof PHASES | null;
  todo: string;
  label: string;
  days: number;
  base_version: number;
  measured_days: number | null;
  measured_count: number;
};
export const savePlanChange = (request: typeof fetch, path: string, body: object) =>
  request(`/api/engine/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotency_key: crypto.randomUUID(), ...body }),
  });

export function TypicalLengths({
  kind,
  request,
  reload,
  close,
  canSave,
}: {
  kind: string;
  request: typeof fetch;
  reload: () => Promise<unknown>;
  close: () => void;
  canSave: boolean;
}) {
  const [items, setItems] = useState<Length[]>([]);
  const [status, setStatus] = useState("Loading typical lengths…");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void request(`/api/engine/typical-lengths?deal_kind=${encodeURIComponent(kind)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const body: { items: Length[] } = await response.json();
        setItems(body.items);
        setStatus(body.items.length ? "" : "No typical lengths for this deal kind.");
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus("Typical lengths unavailable.");
      });
    return () => controller.abort();
  }, [kind, request]);

  async function setDays(item: Length, days: number) {
    if (saving || !Number.isInteger(days) || days < 1 || days === item.days) return;
    setSaving(true);
    try {
      const response = await savePlanChange(request, "typical-lengths", {
        deal_kind: kind,
        todo: item.todo,
        days,
        base_version: item.base_version,
      });
      if (!response.ok) {
        setStatus(
          response.status === 409
            ? "This length changed. Reopen Typical lengths to see it."
            : "Could not save the length.",
        );
        return;
      }
      const saved: { days: number; base_version: number } = await response.json();
      setItems((current) => current.map((other) => (other.todo === item.todo ? { ...other, ...saved } : other)));
      setStatus(`${item.label} saved.`);
      await reload();
    } catch {
      setStatus("Could not confirm the save. Reopen Typical lengths before trying again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="deal-plan-details deal-plan-lengths" aria-label="Typical lengths">
      <button type="button" className="btn btn-quiet" aria-label="Close typical lengths" onClick={close}>
        ×
      </button>
      <h3>Typical lengths</h3>
      <p role="status">{status}</p>
      {items.map((item, index) => (
        <div className="deal-plan-length" key={item.todo}>
          {item.phase && item.phase !== items[index - 1]?.phase && <h4>{PHASES[item.phase]}</h4>}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void setDays(item, Number(new FormData(event.currentTarget).get("days")));
            }}
          >
            <label>
              {item.label}
              <input
                aria-label={`${item.label} days`}
                name="days"
                type="number"
                min="1"
                max="2147483647"
                step="1"
                required
                key={item.base_version}
                defaultValue={item.days}
                disabled={!canSave || saving}
              />
            </label>
            {canSave && (
              <button type="submit" disabled={saving}>
                Save
              </button>
            )}
            {item.measured_days !== null && (
              <span>
                {item.measured_days} days across {item.measured_count} deals
                {canSave && (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void setDays(item, item.measured_days ?? item.days)}
                  >
                    Use measured
                  </button>
                )}
              </span>
            )}
          </form>
        </div>
      ))}
    </section>
  );
}
