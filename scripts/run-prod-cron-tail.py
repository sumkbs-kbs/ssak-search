#!/usr/bin/env python3
"""Double-fork daemon: tail the production cron scheduler + the latest
production Pages deployment for one cron tick, then write a DONE marker.

Usage: python3 scripts/run-prod-cron-tail.py
"""
import os
import subprocess
import sys
import time

LOG_SCHED = '/tmp/prod-sched-tail.log'
LOG_PAGES = '/tmp/prod-pages-tail.log'
DONE = '/tmp/prod-cron-tail.done'
PROD_DEPLOY_ID = 'a3d7f1f5-c7b6-42bb-aba5-eb9ad4c96252'  # latest production @ 314df38

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
    # Production scheduler worker tail (must pass --config — local Pages config
    # detection rejects Workers-specific commands without it)
    procs.append(subprocess.Popen(
        ['npx', 'wrangler', 'tail', '--config', 'wrangler.cron.jsonc',
         'ssak-probe-scheduler'],
        stdout=open(LOG_SCHED, 'w'), stderr=subprocess.STDOUT))
    # Latest production Pages deployment tail (ID-based — URL matching rejects
    # anything but the production environment via a different code path)
    procs.append(subprocess.Popen(
        ['npx', 'wrangler', 'pages', 'deployment', 'tail',
         '--project-name', 'search-engine-api', PROD_DEPLOY_ID],
        stdout=open(LOG_PAGES, 'w'), stderr=subprocess.STDOUT))

    # ~14 min: cover the next full 15-min cron cycle
    time.sleep(840)

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
