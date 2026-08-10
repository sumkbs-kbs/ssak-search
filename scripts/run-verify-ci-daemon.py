#!/usr/bin/env python3
"""Detached daemon for scripts/verify-commits-ci.sh (per-commit CI gates).

Double-forks so the verification survives the parent terminal session being
cleaned up. PID of the grandchild is written to /tmp/verify-ci.pid; all
output goes to /tmp/verify-ci.log (truncated each run — a fresh verification
starts clean).

Usage:
  python3 scripts/run-verify-ci-daemon.py                    # default range
  python3 scripts/run-verify-ci-daemon.py --skip-build       # pass-through args
  python3 scripts/run-verify-ci-daemon.py 97a042f..fab8bf5   # explicit range
"""
import os
import sys

LOG = '/tmp/verify-ci.log'
PID = '/tmp/verify-ci.pid'


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
    logfd = os.open(LOG, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    os.dup2(logfd, 1)
    os.dup2(logfd, 2)
    with open(PID, 'w') as f:
        f.write(str(os.getpid()))
    # Run the verifier with any extra CLI args passed through.
    os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
    cmd = ['bash', 'scripts/verify-commits-ci.sh', *sys.argv[1:]]
    os.execvp(cmd[0], cmd)


if __name__ == '__main__':
    main()
