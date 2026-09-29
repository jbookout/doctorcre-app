#!/usr/bin/env python3
"""Regenerate synthetic progress-board parity rows from the pinned CARR producer."""

import json
import os
import re
import subprocess
from datetime import datetime
from pathlib import Path

PIN = "4ac3a68f532210ac4e951d3f8cc26ae4eac1e8d0"
AT = "2026-09-28T13:00:00Z"
STAGES = ("queued", "build", "review", "ci", "merged", "live")
HEALTH = ("healthy", "question", "blocked")
ROOT = Path(__file__).resolve().parents[1]
CARR = Path(os.environ.get("CARR_SYSTEM_REPO", "/Users/booko/carr-system"))


def producer_source():
    return subprocess.check_output(
        ["git", "-C", str(CARR), "show", f"{PIN}:tools/progress_board.py"], text=True
    )


def color(source, variable):
    match = re.search(rf"--{re.escape(variable)}:(#[0-9a-fA-F]{{6}})", source)
    if not match:
        raise ValueError(f"producer color missing: {variable}")
    return match.group(1).lower()


def pulse_color(source, pulse):
    match = re.search(
        rf"\.pulse-{re.escape(pulse)}\{{--state-accent:var\(--([a-z]+)\)\}}", source
    )
    if not match:
        raise ValueError(f"producer pulse color missing: {pulse}")
    return color(source, match.group(1))


def pulse_period(source, pulse):
    if pulse == "still":
        return None
    match = re.search(rf"\.pulse-{re.escape(pulse)}\{{--pulse-speed:([0-9.]+s)\}}", source)
    if not match:
        raise ValueError(f"producer pulse period missing: {pulse}")
    return match.group(1)


def main():
    source = producer_source()
    namespace = {"__name__": "progress_board_parity_producer"}
    exec(compile(source, f"{PIN}:tools/progress_board.py", "exec"), namespace)
    namespace["now_utc"] = lambda: datetime.fromisoformat(AT.replace("Z", "+00:00"))

    tasks = []
    for stage in STAGES:
        for health in HEALTH:
            task = {"title": f"Synthetic {stage} {health}", "status": "running",
                    "stage": stage, "updated_at": "2026-09-28T12:00:00Z"}
            if stage == "live":
                task["evidence"] = "Synthetic proof"
            if health != "healthy":
                task["health"] = health
            tasks.append((f"{stage}_{health}", task))
    tasks.extend([
        ("queued_still", {"title": "Synthetic queued", "status": "queued"}),
        ("done_still", {"title": "Synthetic done", "status": "done"}),
        ("done_merged", {"title": "Synthetic merged", "status": "done", "pr": 84, "pr_phase": "Merged"}),
        ("review_status", {"title": "Synthetic review", "status": "review"}),
        ("failed_status", {"title": "Synthetic failure", "status": "failed"}),
        ("running_boundary", {"title": "Synthetic boundary", "status": "running", "updated_at": "2026-09-28T11:00:00Z"}),
        ("running_stale", {"title": "Synthetic stale", "status": "running", "updated_at": "2026-09-28T10:59:59Z"}),
        ("running_naive_utc", {"title": "Synthetic naive UTC", "status": "running", "updated_at": "2026-09-28T12:00:00"}),
        ("running_missing_time", {"title": "Synthetic missing time", "status": "running"}),
        ("running_invalid_time", {"title": "Synthetic invalid time", "status": "running", "updated_at": "invalid"}),
        ("measured_without_evidence", {"title": "Synthetic measured", "status": "measured"}),
        ("measured_with_evidence", {"title": "Synthetic measured", "status": "measured", "evidence": "Synthetic proof"}),
        ("live_without_evidence", {"title": "Synthetic live", "status": "done", "stage": "live"}),
        ("live_with_evidence", {"title": "Synthetic live", "status": "done", "stage": "live", "evidence": "Synthetic proof"}),
        ("question_overridden_by_stale", {"title": "Synthetic stale question", "status": "running", "health": "question", "updated_at": "2026-09-28T10:59:59Z"}),
    ])

    rows = []
    for task_id, task in tasks:
        stage = namespace["task_stage"](task)
        health = namespace["task_health"](task)
        pulse = namespace["pulse_state"](task)
        rows.append({"id": task_id, "task": task, "stage": stage,
                     "stage_label": namespace["STAGE_LABELS"][stage],
                     "producer_health": health, "pulse": pulse,
                     "pulse_period": pulse_period(source, pulse),
                     "stage_color": color(source, f"stage-{stage}"),
                     "pulse_color": pulse_color(source, pulse)})

    output = {"producer_repository": "jbookout/carr-system", "producer_source_commit": PIN,
              "producer_function": "tools/progress_board.py:task_stage/task_health/pulse_state",
              "reference_time": AT, "synthetic": True, "cases": rows}
    path = ROOT / "test/fixtures/progress-board-stages.json"
    path.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(f"Generated {len(rows)} producer rows at {path}")


if __name__ == "__main__":
    main()
