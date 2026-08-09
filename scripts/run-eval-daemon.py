#!/usr/bin/env python3
"""Detached daemon for eval:median:save (S39).

Double-forks so the eval survives the parent terminal session being cleaned
up. The first fork's child becomes session leader; the second fork detaches
completely. PID of the grandchild is written to /tmp/eval-median.pid, and all
output goes to /tmp/eval-median.log (appended, so a prior session's log is
preserved).

Usage:
  python3 scripts/run-eval-daemon.py
"""
import os
import sys
import time

LOG = '/tmp/eval-median.log'
PID = '/tmp/eval-median.pid'


def main() -> None:
    # First fork
    pid = os.fork()
    if pid > 0:
        sys.exit(0)
    os.setsid()
    # Second fork
    pid = os.fork()
    if pid > 0:
        sys.exit(0)
    # Grandchild: redirect stdio to the log
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    logfd = os.open(LOG, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    os.dup2(logfd, 1)
    os.dup2(logfd, 2)
    with open(PID, 'w') as f:
        f.write(str(os.getpid()))
    # Run the eval (npm run eval:median:save). The grandchild is reparented
    # to init, so terminal teardown cannot kill it.
    os.execvp('npx', ['npx', 'tsx', 'eval/index.ts', '--runs', '3', '--json', '--save'])


if __name__ == '__main__':
    main()
