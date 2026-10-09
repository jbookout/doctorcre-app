#!/usr/bin/env python3
import json
import os
import signal
import subprocess
import sys
import time

state_path = os.environ["SYNTHETIC_PROCESS_STATE"]
child_code = "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(300)"
child = subprocess.Popen([sys.executable, "-c", child_code])
signal.signal(signal.SIGTERM, signal.SIG_IGN)
with open(state_path + ".tmp", "w", encoding="utf-8") as handle:
    json.dump({"dispatcher": os.getpid(), "grandchild": child.pid, "argv": sys.argv[1:]}, handle)
os.replace(state_path + ".tmp", state_path)
while True:
    time.sleep(1)
