"""Publish a SHA-bound review-gate commit status using trusted GitHub event data."""
import re
import json
import os
import subprocess
import time
from pathlib import Path

# GitHub skips every push workflow for these title markers, so a merged PR would never deploy.
SKIP_CI = re.compile(r"\[(skip ci|ci skip|no ci|skip actions|actions skip)\]", re.I)


def card_allowed(pr):
    return (pr.get("user", {}).get("type") == "Bot" or
            any(re.fullmatch(r"Card: WR[0-9]+\.S[0-9]+\.J[0-9]+", line)
                for line in (pr.get("body") or "").splitlines()))


def approved(pr, comments):
    auto_merge = pr.get("auto_merge") or {}
    if any(SKIP_CI.search(value or "") for value in
           (pr.get("title"), auto_merge.get("commit_title"), auto_merge.get("commit_message"))):
        return False
    sha_line = f'Reviewed-SHA: {pr["head"]["sha"]}'
    verdicts = [lines[0] for lines in ((c.get("body") or "").splitlines() for c in comments)
                if len(lines) >= 3 and lines[0] in ("VERDICT: APPROVE", "VERDICT: CHANGES")
                and lines[1] == sha_line and lines[2].startswith("Reviewer: ")
                and lines[2][10:].strip()]
    return verdicts[-1:] == ["VERDICT: APPROVE"]


def api(path, payload=None):
    time.sleep(2)
    args = ["gh", "api", path]
    if payload is None:
        args += ["--paginate", "--slurp"]
    else:
        args += ["--method", "POST", "--input", "-"]
    result = subprocess.run(args, input=json.dumps(payload) if payload else None,
                            text=True, capture_output=True, check=True)
    data = json.loads(result.stdout)
    return data if payload else (sum(data, []) if data and isinstance(data[0], list) else data[0])


def run(event, repo):
    root = f"repos/{repo}"
    def status(sha, state, description="No skip marker; current-head approval required"):
        api(f"{root}/statuses/{sha}", {"context": "review-gate", "state": state,
            "description": description})
    if "merge_group" in event:
        status(event["merge_group"]["head_sha"], "success")
        return
    number = event.get("number") or (event.get("pull_request") or event["issue"])["number"]
    pr = api(f"{root}/pulls/{number}")
    if pr["base"]["ref"] != "main":
        return
    sha = pr["head"]["sha"]
    status(sha, "pending")
    comments = api(f"{root}/issues/{number}/comments?per_page=100")
    reviews = api(f"{root}/pulls/{number}/reviews?per_page=100")
    comments = sorted(comments + [r for r in reviews if r.get("state") not in ("DISMISSED", "PENDING")], key=lambda item: item.get("submitted_at") or item.get("created_at") or "")
    card_ok = card_allowed(pr)
    passed = card_ok and approved(pr, comments)
    latest = api(f"{root}/pulls/{number}")
    if latest["head"]["sha"] == sha and latest.get("body") == pr.get("body"):
        description = ("No skip marker; current-head approval required" if card_ok else
                       "Missing Card line; format: Card: WR557.S3.J1")
        status(sha, "success" if passed else "failure", description)


if __name__ == "__main__":
    run(json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text()), os.environ["GITHUB_REPOSITORY"])
