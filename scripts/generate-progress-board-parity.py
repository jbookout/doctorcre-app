#!/usr/bin/env python3
"""Regenerate synthetic progress-board parity rows from the pinned CARR producer.

The producer (carr-system tools/progress_board.py) decides stage, health,
pulse, blocked reason/next action, stale and the stage timer; this app mirrors
those rules in js/progress-board-model.js. Colours, glyphs and pulse speeds
belong to the app renderer and are not part of this parity.
"""

import json
import os
import subprocess
from datetime import datetime
from pathlib import Path

PIN = "4af24be8b4415290dcf29eecb6091a0d25fc91bd"
AT = "2026-09-28T13:00:00Z"
STAGES = ("queued", "build", "review", "ci", "merged", "live")
HEALTH = ("healthy", "question", "blocked")
ROOT = Path(__file__).resolve().parents[1]
CARR = Path(os.environ.get("CARR_SYSTEM_REPO", "/Users/booko/carr-system"))


def producer_source():
    return subprocess.check_output(
        ["git", "-C", str(CARR), "show", f"{PIN}:tools/progress_board.py"], text=True
    )


def main():
    source = producer_source()
    namespace = {"__name__": "progress_board_parity_producer", "__file__": str(CARR / "tools" / "progress_board.py")}
    exec(compile(source, f"{PIN}:tools/progress_board.py", "exec"), namespace)
    at = datetime.fromisoformat(AT.replace("Z", "+00:00"))
    namespace["now_utc"] = lambda: at

    tasks = []
    for stage in STAGES:
        for health in HEALTH:
            task = {"title": f"Synthetic {stage} {health}", "status": "running",
                    "stage": stage, "health": health, "updated_at": "2026-09-28T12:00:00Z",
                    "stage_entered_at": "2026-09-28T10:46:00Z"}
            if stage == "live":
                task["evidence"] = "Synthetic proof"
            tasks.append((f"{stage}_{health}", task))
    tasks.extend([
        ("queued_still", {"title": "Synthetic queued", "status": "queued"}),
        ("done_still", {"title": "Synthetic done", "status": "done"}),
        ("done_merged", {"title": "Synthetic merged", "status": "done", "pr": 84, "pr_phase": "Merged"}),
        ("done_unmerged", {"title": "Synthetic unmerged", "status": "done", "pr": 85, "pr_phase": "Awaiting review"}),
        ("done_leftover_blocked", {"title": "Leftover", "status": "done", "pr": 84, "pr_phase": "Merged", "health": "blocked"}),
        ("review_status", {"title": "Synthetic review", "status": "review"}),
        ("failed_status", {"title": "Synthetic failure", "status": "failed"}),
        ("closed_unmerged", {"title": "Closed", "status": "failed", "pr": 3, "pr_phase": "Closed unmerged"}),
        ("checks_failing", {"title": "Checks", "status": "blocked", "pr": 3, "pr_phase": "Checks failing", "updated_at": "2026-09-28T12:30:00Z"}),
        ("review_blocked", {"title": "Review", "status": "blocked", "pr": 3, "pr_phase": "Review blocked", "updated_at": "2026-09-28T12:30:00Z"}),
        ("merge_conflict", {"title": "Conflict", "status": "blocked", "pr": 3, "pr_phase": "Merge conflict", "stage": "review", "updated_at": "2026-09-28T12:30:00Z"}),
        ("changes_requested", {"title": "Changes", "status": "blocked", "pr": 3, "pr_phase": "Changes requested", "stage": "review", "updated_at": "2026-09-28T12:30:00Z"}),
        ("explicit_block", {"title": "Explicit", "status": "blocked", "blocked_reason": "Needs a key", "next_action": "Joe adds it", "updated_at": "2026-09-28T12:30:00Z"}),
        ("explicit_reason_only", {"title": "Reason only", "status": "blocked", "pr_phase": "Checks failing", "blocked_reason": "Flaky runner", "updated_at": "2026-09-28T12:30:00Z"}),
        ("legacy_blocked", {"title": "Legacy", "status": "blocked", "updated_at": "2026-09-28T12:30:00Z"}),
        ("running_boundary", {"title": "Synthetic boundary", "status": "running", "updated_at": "2026-09-28T11:00:00Z"}),
        ("running_stuck", {"title": "Synthetic stuck", "status": "running", "updated_at": "2026-09-28T10:59:59Z"}),
        ("running_stale_boundary", {"title": "Six hours", "status": "running", "updated_at": "2026-09-28T07:00:00Z"}),
        ("running_not_stale", {"title": "Almost six", "status": "running", "updated_at": "2026-09-28T07:00:01Z"}),
        ("review_stale", {"title": "Old review", "status": "review", "updated_at": "2026-09-27T12:00:00Z"}),
        ("running_naive_utc", {"title": "Synthetic naive UTC", "status": "running", "updated_at": "2026-09-28T12:00:00"}),
        ("running_missing_time", {"title": "Synthetic missing time", "status": "running"}),
        ("running_invalid_time", {"title": "Synthetic invalid time", "status": "running", "updated_at": "invalid"}),
        ("measured_without_evidence", {"title": "Synthetic measured", "status": "measured"}),
        ("measured_with_evidence", {"title": "Synthetic measured", "status": "measured", "evidence": "Synthetic proof"}),
        ("live_without_evidence", {"title": "Synthetic live", "status": "done", "stage": "live"}),
        ("live_with_evidence", {"title": "Synthetic live", "status": "done", "stage": "live", "evidence": "Synthetic proof"}),
        ("question_overridden_by_stale", {"title": "Synthetic stale question", "status": "running", "health": "question", "updated_at": "2026-09-28T10:59:59Z"}),
        ("timer_from_history", {"title": "History", "status": "running", "updated_at": "2026-09-28T12:59:00Z",
                                "stage_history": [{"stage": "build", "entered_at": "2026-09-28T09:00:00Z"}]}),
        ("timer_legacy_at", {"title": "Legacy history", "status": "review", "updated_at": "2026-09-28T12:59:00Z",
                             "stage_history": [{"stage": "review", "at": "2026-09-28T12:25:00Z"}]}),
    ])

    rows = []
    for task_id, task in tasks:
        stage = namespace["task_stage"](task)
        blocked = namespace["blocked_detail"](task, at)
        rows.append({"id": task_id, "task": task, "stage": stage,
                     "stage_label": namespace["STAGE_LABELS"][stage],
                     "producer_health": namespace["task_health"](task, at),
                     "pulse": namespace["pulse_state"](task, at),
                     "stale": namespace["is_stale"](task, at),
                     "stage_timer": namespace["stage_timer"](task, at),
                     "blocked": list(blocked) if blocked else None})

    output = {"producer_repository": "jbookout/carr-system", "producer_source_commit": PIN,
              "producer_function": "tools/progress_board.py:task_stage/task_health/pulse_state/blocked_detail/is_stale/stage_timer",
              "reference_time": AT, "synthetic": True, "cases": rows}
    path = ROOT / "test/fixtures/progress-board-stages.json"
    path.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(f"Generated {len(rows)} producer rows at {path}")


if __name__ == "__main__":
    main()
