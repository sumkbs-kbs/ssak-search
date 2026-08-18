#!/usr/bin/env python3
"""Double-fork daemon: tail the production cron scheduler + the latest
production Pages deployment for one cron tick, then write a DONE marker and
persist the parsed down_backends to the cron-bridge state file
(/tmp/ssak-cron-health.json) via scripts/parse-cron-health.py.

verify-do-binding.sh reads that state file when its own tail capture exhausts
(S104-③-⑦-③ cron bridge) — a capture miss no longer blinds backend
availability because the scheduled probe's last answer is preserved.

Usage: python3 scripts/run-prod-cron-tail.py
"""
import json
import os
import subprocess
import sys
import time

LOG_SCHED = '/tmp/prod-sched-tail.log'
LOG_PAGES = '/tmp/prod-pages-tail.log'
DONE = '/tmp/prod-cron-tail.done'
STATE = '/tmp/ssak-cron-health.json'
ROOT = os.path.dirname(os.path.abspath(__file__))
PARSER = os.path.join(ROOT, 'parse-cron-health.py')


def resolve_prod_deployment_id():
    """Latest production Pages deployment ID (Environment == \"Production\").
    Best-effort: returns None when the list cannot be resolved (no auth /
    no deployment yet) — the caller then tails the scheduler alone."""
    try:
        out = subprocess.run(
            ['npx', 'wrangler', 'pages', 'deployment', 'list',
             '--project-name', 'search-engine-api', '--json'],
            capture_output=True, text=True, timeout=60)
        d = json.loads(out.stdout or '[]')
        if not isinstance(d, list):
            return None
        match = next((x for x in d if x.get('Environment') == 'Production'), None)
        return (match or {}).get('Id') or None
    except Exception:
        return None


def daemonize():
    if os.fork() > 0:
        sys.exit(0)
    os.setsid()
    if os.fork() > 0:
        sys.exit(0)
    os.chdir(ROOT)
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
    # anything but the production environment via a different code path).
    # The ID is resolved at run time: the old hardcoded ID went stale as
    # deployments advanced, so the tail attached to an old deployment that no
    # longer receives the probe's [health] lines.
    deploy_id = resolve_prod_deployment_id()
    if deploy_id:
        procs.append(subprocess.Popen(
            ['npx', 'wrangler', 'pages', 'deployment', 'tail',
             '--project-name', 'search-engine-api', deploy_id],
            stdout=open(LOG_PAGES, 'w'), stderr=subprocess.STDOUT))
    else:
        with open(DONE, 'a') as f:
            f.write('pages-tail skipped (no production deployment resolved)\n')

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

    # Cron bridge: persist the last parsed down_backends for
    # verify-do-binding.sh to read on capture exhaustion.
    try:
        subprocess.run(
            ['python3', PARSER, '--state', STATE, LOG_SCHED, LOG_PAGES],
            capture_output=True, text=True, timeout=30)
        with open(DONE, 'a') as f:
            f.write('state-written\n')
    except Exception:
        with open(DONE, 'a') as f:
            f.write('state-write-failed\n')

    with open(DONE, 'a') as f:
        f.write('done\n')


if __name__ == '__main__':
    main()
