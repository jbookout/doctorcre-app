"""Keep a child in the worker group until its owner records its identity."""
import json
import os
import select
import sys

ack_fd = int(sys.argv[1])
command = json.loads(sys.argv[3])
try:
    ready, _, _ = select.select([ack_fd], [], [], int(sys.argv[2]) / 1000)
    acknowledged = bool(ready) and os.read(ack_fd, 1) == b"1"
finally:
    os.close(ack_fd)
if not acknowledged:
    sys.exit(125)
os.setsid()
os.execvpe(command[0], command, os.environ)
