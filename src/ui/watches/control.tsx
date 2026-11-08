import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createWatchClient, type WatchClient } from "./client.ts";
import { defaultPolicy, type Policy, type Subject, type Watch } from "./model.ts";
import { PolicyEditor } from "./policy-editor.tsx";

type Command = {
  verb: string;
  args: Subject & { idempotency_key: string; subscription_id?: string; base_version?: number; policy?: Policy };
};
type Phase = "loading" | "ready" | "saving" | "unknown" | "unavailable" | "retired";
function WatchControl({ subject, client }: { subject: Subject; client: WatchClient }) {
  const [watch, setWatch] = useState<Watch | null | undefined>();
  const [phase, setPhase] = useState<Phase>("loading");
  const [policy, setPolicy] = useState<Policy>(() => defaultPolicy(subject));
  const [days, setDays] = useState("30, 90");
  const [message, setMessage] = useState("");
  const pending = useRef<Command | null>(null);
  const edited = useRef(false);
  const lifetime = useRef({ retired: false, sequence: 0, controller: new AbortController() });
  const retire = useCallback(() => {
    lifetime.current.retired = true;
    lifetime.current.sequence++;
    lifetime.current.controller.abort();
    pending.current = null;
    setWatch(undefined);
    setPhase("retired");
    setMessage("Sign in again to inspect this watch.");
  }, []);
  const read = useCallback(
    async (conflict = false) => {
      const life = lifetime.current;
      if (life.retired) return;
      const sequence = ++life.sequence;
      setPhase("loading");
      const outcome = await client("read-subject-watch-v2", subject, life.controller.signal);
      if (life.retired || sequence !== life.sequence) return;
      if (outcome.kind === "denied") {
        retire();
        return;
      }
      if (outcome.kind !== "confirmed") {
        setPhase("unavailable");
        setMessage("Watch state unavailable. Previous confirmation may be out of date.");
        return;
      }
      setWatch(outcome.watch);
      setPhase("ready");
      if (!edited.current && outcome.watch) {
        setPolicy(outcome.watch.policy);
        setDays((outcome.watch.policy.lease_threshold_days ?? [30, 90]).join(", "));
      }
      setMessage(
        conflict
          ? "This watch changed. Current server state is shown. Your draft is kept. Review it before saving again."
          : "",
      );
    },
    [client, subject, retire],
  );
  useEffect(() => {
    void read();
    window.addEventListener("doctorcre-session-invalidated", retire);
    return () => {
      window.removeEventListener("doctorcre-session-invalidated", retire);
      lifetime.current.retired = true;
      lifetime.current.controller.abort();
    };
  }, [read, retire]);
  const submit = async (verb?: string) => {
    const life = lifetime.current;
    if (life.retired || phase === "saving" || phase === "loading") return;
    if (!pending.current) {
      if (!verb || phase !== "ready") return;
      const args: Command["args"] = { ...subject, idempotency_key: crypto.randomUUID() };
      if (verb !== "watch-subject-v2") {
        if (!watch) return;
        args.subscription_id = watch.id;
        args.base_version = watch.lifecycle_version;
      }
      if (verb === "watch-subject-v2" || verb === "replace-subject-watch-policy-v2") {
        const thresholds = days.split(",").map((value) => value.trim());
        const numbers = thresholds.map(Number);
        if (
          !policy.change_kinds.length ||
          (policy.change_kinds.includes("lease_threshold_crossed") &&
            (thresholds.some((value) => !/^\d+$/.test(value)) ||
              numbers.length > 20 ||
              new Set(numbers).size !== numbers.length ||
              numbers.some((value) => value < 0 || value > 3650)))
        ) {
          setMessage("Choose a change category and up to 20 unique threshold days from 0 to 3650.");
          return;
        }
        args.policy = {
          change_kinds: [...policy.change_kinds],
          include_self_changes: policy.include_self_changes,
          ...(policy.change_kinds.includes("lease_threshold_crossed") ? { lease_threshold_days: numbers } : {}),
        };
      }
      pending.current = { verb, args };
    }
    const command = pending.current;
    setPhase("saving");
    setMessage("Waiting for CARR to confirm.");
    const outcome = await client(command.verb, command.args, life.controller.signal);
    if (life.retired) return;
    if (outcome.kind === "denied") {
      retire();
      return;
    }
    if (outcome.kind === "unknown") {
      setPhase("unknown");
      setMessage("Outcome unknown. Keep this tab open. Retry sends the identical request and key.");
      return;
    }
    pending.current = null;
    if (outcome.kind === "conflict") {
      await read(true);
      return;
    }
    if (command.args.policy) {
      edited.current = false;
      setPolicy(command.args.policy);
    }
    setWatch(outcome.watch);
    await read();
  };
  const busy = phase !== "ready";
  const confirmed =
    watch === undefined
      ? "Watch state not confirmed"
      : watch === null || watch.state === "removed"
        ? "Not watching"
        : watch.state === "paused"
          ? "Watch paused"
          : "Watching";
  return (
    <details>
      <summary>
        {subject.subject_type === "deal" ? "Deal" : "Lease"} watch settings · {confirmed}
      </summary>
      <section
        aria-label={`${subject.subject_type === "deal" ? "Deal" : "Lease"} watch`}
        style={{ maxWidth: "100%", minWidth: 0, padding: "12px", overflowWrap: "anywhere" }}
      >
        <h3>{confirmed}</h3>
        {watch && phase !== "retired" && (
          <section aria-label="Confirmed watch policy">
            <p>
              Last confirmed version {watch.lifecycle_version}.{" "}
              {watch.policy.include_self_changes ? "Includes" : "Excludes"} my changes.
            </p>
            <p>
              {watch.policy.change_kinds
                .map(
                  (kind) =>
                    ({
                      reply_arrived: "Replies arriving",
                      lease_threshold_crossed: "Lease thresholds",
                      listing_status_changed: "Listing status changes",
                    })[kind],
                )
                .join(", ")}
              {watch.policy.lease_threshold_days ? ` · ${watch.policy.lease_threshold_days.join(", ")} days` : ""}
            </p>
          </section>
        )}
        <p role="status">{message || (phase === "loading" ? "Reading current watch state…" : "")}</p>
        {phase !== "retired" && (
          <>
            <PolicyEditor
              policy={policy}
              days={days}
              onDays={(value) => {
                edited.current = true;
                setDays(value);
              }}
              onChange={(value) => {
                edited.current = true;
                setPolicy(value);
              }}
              disabled={phase === "saving" || phase === "unknown" || phase === "loading"}
            />
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "8px" }}>
              {watch && watch.state !== "removed" ? (
                <>
                  <button
                    disabled={busy}
                    type="button"
                    onClick={() =>
                      void submit(watch.state === "paused" ? "resume-subject-watch-v2" : "pause-subject-watch-v2")
                    }
                  >
                    {watch.state === "paused" ? "Resume watch" : "Pause watch"}
                  </button>
                  <button type="button" disabled={busy} onClick={() => void submit("replace-subject-watch-policy-v2")}>
                    Save watch policy
                  </button>
                  <button type="button" disabled={busy} onClick={() => void submit("unwatch-subject-v2")}>
                    Remove watch
                  </button>
                </>
              ) : (
                <button type="button" disabled={busy} onClick={() => void submit("watch-subject-v2")}>
                  Start watch
                </button>
              )}
              {phase === "unknown" ? (
                <button type="button" onClick={() => void submit()}>
                  Retry same watch request
                </button>
              ) : (
                <button type="button" disabled={phase === "loading" || phase === "saving"} onClick={() => void read()}>
                  Refresh watch
                </button>
              )}
            </div>
          </>
        )}
      </section>
    </details>
  );
}
export function mountWatchControl(
  host: HTMLElement,
  { subject, client = createWatchClient() }: { subject: Subject; client?: WatchClient },
) {
  const root = createRoot(host);
  root.render(<WatchControl subject={subject} client={client} />);
  return {
    dispose() {
      root.unmount();
    },
  };
}
