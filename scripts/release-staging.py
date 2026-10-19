"""Staging release orchestration; Node adapters retain the shared process policy."""

import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent


class ReleaseFailure(Exception):
    def __init__(self, step, reason, recovery):
        super().__init__(f"release:staging failed at {step}: {reason}. Recovery: {recovery}")


def release(node, args):
    def run(step, command, arguments, recovery, *, capture=False, allow_failure=False):
        try:
            child = subprocess.run(
                [node, str(ROOT / "scripts/release-command.mjs")],
                input=json.dumps({"command": command, "args": arguments}),
                cwd=ROOT, text=True, capture_output=True, check=False,
            )
            if child.returncode:
                raise ValueError("adapter failed")
            result = json.loads(child.stdout)
            status = result["status"]
        except (OSError, ValueError, KeyError):
            raise ReleaseFailure(step, "command adapter could not run", recovery) from None
        if not allow_failure and status != 0:
            reason = result.get("error") or f"command exited with {result.get('signal') or status}"
            raise ReleaseFailure(step, reason, recovery)
        if not capture and status == 0:
            sys.stdout.write(result.get("stdout", ""))
            sys.stderr.write(result.get("stderr", ""))
            sys.stdout.flush()
            sys.stderr.flush()
        return result

    usage = "run npm run release:staging -- --source-sha <exact-HEAD-SHA>, or omit --source-sha for origin/main"
    if args and (len(args) != 2 or args[0] != "--source-sha"
                 or not re.fullmatch(r"[0-9a-f]{40}", args[1])):
        raise ReleaseFailure("arguments", "usage: release:staging [--source-sha <exact-HEAD-SHA>]", usage)
    candidate = args[1] if args else None
    source = run("source-head", "git", ["rev-parse", "HEAD"],
                 "restore a valid Git checkout, then retry", capture=True)["stdout"].strip()
    main = run("source-main", "git", ["rev-parse", "origin/main"],
               "fetch origin/main, then retry from the intended source", capture=True)["stdout"].strip()
    status = run("source-cleanliness", "git", ["status", "--porcelain", "--untracked-files=all"],
                 "inspect git status and restore a clean checkout", capture=True)["stdout"].strip()
    if not re.fullmatch(r"[0-9a-f]{40}", source):
        raise ReleaseFailure("source-head", "HEAD is not a full Git commit", "restore a valid Git checkout")
    if candidate and source != candidate:
        raise ReleaseFailure("source-candidate", "staging candidate differs from the exact source SHA", usage)
    if not candidate and source != main:
        raise ReleaseFailure("source-main", "staging releases must use the exact origin/main commit", usage)
    if status:
        raise ReleaseFailure("source-cleanliness", "staging releases require a clean checkout",
                             "inspect git status and commit or remove the intended changes, then retry")

    run("artifact-verification", "node", ["scripts/build-artifact.mjs", "prepare-deployment"],
        "restore the source-bound prepared artifact, or run npm run release:prepare at origin/main, then retry")
    inspect = "inspect staging deployments and the provider error before retrying; no release was attempted"
    current = run("deployment-status", "provider",
                  ["deployments", "status", "--env", "staging", "--json"],
                  inspect, capture=True, allow_failure=True)
    if current.get("error"):
        raise ReleaseFailure("provider-preflight", current["error"],
                             "run npm ci for locked Wrangler and provision CLOUDFLARE_API_TOKEN for publication")
    tag = f"staging-{source[:12]}"
    message = f"DoctorCRE staging {source}"
    if current["status"] == 0:
        upload = run("version-upload", "provider",
                     ["versions", "upload", "--env", "staging", "--strict",
                      "--tag", tag, "--message", message, "--var", f"GIT_SHA:{source}"],
                     "inspect staging versions for this source SHA before retrying; the upload may have succeeded",
                     capture=True)
        version = run("uploaded-version-identity", "uploaded-version", [upload["stdout"]],
                      "inspect staging versions for this source SHA; do not promote an ambiguous upload",
                      capture=True)["stdout"]
        print(upload["stdout"], end="", flush=True)
        run("version-promotion", "provider",
            ["versions", "deploy", f"{version}@100%", "--env", "staging",
             "--message", message, "--yes"],
            "inspect the active staging version before retrying; use npm run rollback:staging -- <exact-version-id> if needed")
    elif re.search(r"code:\s*10007", current.get("stdout", "") + "\n" + current.get("stderr", "")):
        run("staging-bootstrap", "provider",
            ["deploy", "--env", "staging", "--strict", "--tag", tag,
             "--message", message, "--var", f"GIT_SHA:{source}"],
            "inspect staging deployment state before retrying; the first-use deploy may have succeeded")
    else:
        raise ReleaseFailure("deployment-status", "could not establish the current DoctorCRE staging deployment state", inspect)
    run("deployment-readback", "provider", ["deployments", "status", "--env", "staging", "--json"],
        "inspect the active staging version; publication may have succeeded, so verify before retrying or use npm run rollback:staging -- <exact-version-id>")


if __name__ == "__main__":
    try:
        release(sys.argv[1], sys.argv[2:])
    except ReleaseFailure as error:
        print(error, file=sys.stderr)
        sys.exit(1)
