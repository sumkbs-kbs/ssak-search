#!/usr/bin/env python3
"""Detached daemon for eval:median:save with cache (S80/S80-①).

Double-forks so the eval survives the parent terminal session being cleaned
up. The first fork's child becomes session leader; the second fork detaches
completely. PID of the grandchild is written to /tmp/eval-median.pid, and all
output goes to /tmp/eval-median.log (appended, so a prior session's log is
preserved).

Default runs `npx tsx eval/index.ts --runs 2 --cache --json --save` — the S74
schedule mode (median-of-2 + cache-once). Pass args to override:
  python3 scripts/run-eval-daemon.py --runs 3 --json --save
(median-of-3, no cache — the full-NDCG measurement mode).
"""
import os
import sys

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
    # Run the eval. Default S74 schedule mode (2 runs + cache-once); pass CLI
    # args to override (e.g. --runs 3 --json --save for median-of-3). The
    # grandchild is reparented to init, so terminal teardown cannot kill it.
    args = sys.argv[1:] if len(sys.argv) > 1 else ['--runs', '2', '--cache', '--json', '--save']
    os.execvp('npx', ['npx', 'tsx', 'eval/index.ts', *args])


if __name__ == '__main__':
    main()
