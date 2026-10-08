"""Read one retained Save trace; emit its actual request/receipt/readback."""
import datetime
import math
import hashlib
import json
import pathlib
import sys
import zipfile
from urllib.parse import urlsplit

def require(value):
    if not value:
        raise ValueError("recorded action evidence refused")

png = pathlib.Path(sys.argv[1])
trace = png.with_suffix(".zip")
png_bytes = png.read_bytes()
require(png_bytes.startswith(b"\x89PNG\r\n\x1a\n"))
trace_bytes = trace.read_bytes()
with zipfile.ZipFile(trace) as archive:
    require(archive.testzip() is None)
    entries = []
    for line in archive.read("trace.network").splitlines():
        row = json.loads(line)
        snapshot = row.get("snapshot", row)
        request = snapshot.get("request", {})
        reference = request.get("postData", {}).get("_file")
        if request.get("method") != "POST" or reference not in archive.namelist():
            continue
        raw = archive.read(reference)
        require(b"[redacted]" not in raw)
        body = json.loads(raw)
        name = body.get("params", {}).get("name")
        if name not in ("set-next-step", "get-deal-room"):
            continue
        url = urlsplit(request["url"])
        require(url.scheme + "://" + url.netloc == sys.argv[2] and url.path == "/mcp")
        response = snapshot.get("response", {})
        result_ref = response.get("content", {}).get("_file")
        require(response.get("status") == 200 and result_ref in archive.namelist())
        rpc = json.loads(archive.read(result_ref))
        require(not rpc.get("error") and not rpc.get("result", {}).get("isError"))
        contents = rpc["result"]["content"]
        require(len(contents) == 1 and contents[0]["type"] == "text")
        started = datetime.datetime.fromisoformat(snapshot.get("startedDateTime", "").replace("Z", "+00:00"))
        require(started.tzinfo is not None)
        monotonic = snapshot.get("_monotonicTime")
        duration = snapshot.get("time")
        require(isinstance(monotonic, (int, float)) and not isinstance(monotonic, bool) and
                math.isfinite(monotonic) and monotonic >= 0 and
                isinstance(duration, (int, float)) and not isinstance(duration, bool) and
                math.isfinite(duration) and duration >= 0)
        entries.append({"verb": name, "arguments": body["params"]["arguments"],
                        "result": json.loads(contents[0]["text"]),
                        "start": monotonic, "end": monotonic + duration})
    writes = [entry for entry in entries if entry["verb"] == "set-next-step"]
    require(len(writes) == 1)
    write = writes[0]
    args, receipt = write["arguments"], write["result"]
    require(set(args) == {"deal", "text", "next_date", "idempotency_key"})
    require(receipt.get("ok") is True and receipt.get("deal_id") == args["deal"])
    require(isinstance(receipt.get("next_step_id"), str) and receipt["next_step_id"].strip())
    created = datetime.datetime.fromisoformat(receipt.get("created_at", "").replace("Z", "+00:00"))
    require(created.tzinfo is not None)
    require(isinstance(args["text"], str) and args["text"].strip() == args["text"] and args["text"])
    require(args["next_date"] is None or isinstance(args["next_date"], str))
    require(isinstance(args["idempotency_key"], str) and args["idempotency_key"])
    after = [entry for entry in entries
             if entry["verb"] == "get-deal-room" and entry["arguments"].get("deal") == args["deal"]
             and entry["start"] >= write["end"]]
    after.sort(key=lambda entry: entry["start"])
    require(after)
    result = {"png_sha256": hashlib.sha256(png_bytes).hexdigest(),
              "trace_sha256": hashlib.sha256(trace_bytes).hexdigest(),
              "arguments": args, "receipt": receipt, "readback": after[-1]["result"]}
    # stdout is consumed internally by the planner, never a public receipt.
    print(json.dumps(result, separators=(",", ":")))
