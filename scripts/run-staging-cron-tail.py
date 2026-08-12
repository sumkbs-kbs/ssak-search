#!/usr/bin/env python3
"""Double-fork daemon: tail the staging cron scheduler + staging Pages
deployment for one cron tick, then write a DONE marker.

Usage: python3 scripts/run-staging-cron-tail.py
"""
import os
import subprocess
import sys
import time

LOG_SCHED = '/tmp/stg-sched-tail.log'
LOG_PAGES = '/tmp/stg-pages-tail.log'
DONE = '/tmp/stg-cron-tail.done'

for f in (LOG_SCHED, LOG_PAGES, DONE):
    if os.path.exists(f):
        os.remove(f)


def daemonize():
    if os.fork() > 0:
        sys.exit(0)
    os.setsid()
    if os.fork() > 0:
        sys.exit(0)
    os.chdir('/Users/mr.k/Downloads/webapp')
    sys.stdout.flush()
    sys.stderr.flush()
    devnull = os.open(os.devnull, os.O_WRONLY)
    os.dup2(devnull, 0)
    os.dup2(devnull, 1)
    os.dup2(devnull, 2)


def main():
    daemonize()
    with open(DONE, 'w') as f:
        f.write('started pid=%d\n' % os.getpid())

    procs = []
    # Scheduler worker tail — must pass --config (local Pages config detection
    # rejects Workers-specific commands without it)
    procs.append(subprocess.Popen(
        ['npx', 'wrangler', 'tail', '--config', 'wrangler.cron.staging.jsonc',
         'ssak-probe-scheduler-staging'],
        stdout=open(LOG_SCHED, 'w'), stderr=subprocess.STDOUT))
    # Staging Pages deployment tail (ID-based — URL matching rejects staging env)
    procs.append(subprocess.Popen(
        ['npx', 'wrangler', 'pages', 'deployment', 'tail',
         '--project-name', 'search-engine-api',
         '8530df3a-4b54-49ca-9846-d1d97ebd1b9e'],
        stdout=open(LOG_PAGES, 'w'), stderr=subprocess.STDOUT))

    # ~13.3 min: cover the next full 15-min cron cycle (e.g. 23:45 tick)
    time.sleep(800)

    for p in procs:
        try:
            p.terminate()
        except Exception:
            pass
    time.sleep(2)
    for p in procs:
        try:
            p.kill()
        except Exception:
            pass

    with open(DONE, 'a') as f:
        f.write('done\n')


if __name__ == '__main__':
    main()
