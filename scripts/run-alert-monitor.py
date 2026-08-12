#!/usr/bin/env python3
"""Double-fork daemon: verify the production Slack-alert delivery path.

Tails the `ssak-alert-capture` worker (the SLACK_WEBHOOK sink) while polling
the production /api/health?depth=full probe. The alert fires only when a
backend is genuinely down — natural down events (wikipedia 429 windows,
duckduckgo cycles) are sporadic, so this polls until one occurs (bounded).

On a detected down event it waits for the fire-and-forget POST, greps the
capture tail log for the delivered alert, and writes a DONE marker.

Usage: python3 scripts/run-alert-monitor.py [max_minutes]
"""
import os
import subprocess
import sys
import time
import urllib.request

LOG = '/tmp/alert-capture-tail.log'
DONE = '/tmp/alert-monitor.done'
PROBE_URL = 'https://search-engine-api.pages.dev/api/health?depth=full'

for f in (LOG, DONE):
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
    max_minutes = int(sys.argv[1]) if len(sys.argv) > 1 else 90
    daemonize()
    with open(DONE, 'w') as f:
        f.write('started pid=%d probe=%s\n' % (os.getpid(), PROBE_URL))

    tail = subprocess.Popen(
        ['npx', 'wrangler', 'tail', '--config', 'wrangler.slack-capture.jsonc',
         'ssak-alert-capture'],
        stdout=open(LOG, 'w'), stderr=subprocess.STDOUT)

    deadline = time.time() + max_minutes * 60
    poll_interval = 240  # seconds between probes (each burns ~7 subrequests)
    last_down = None

    while time.time() < deadline:
        try:
            with urllib.request.urlopen(PROBE_URL, timeout=90) as r:
                body = r.read().decode('utf-8', 'replace')
            import json
            data = json.loads(body)
            backends = data.get('backends', {})
            down = sorted(k for k, v in backends.items()
                          if isinstance(v, dict) and v.get('status') == 'down')
        except Exception as e:
            down = []
            print('probe error: %s' % e)

        stamp = time.strftime('%H:%M:%SZ', time.gmtime())
        if down:
            with open(DONE, 'a') as f:
                f.write('%s DOWN detected: %s\n' % (stamp, ','.join(down)))
            last_down = ','.join(down)
            # alert is fire-and-forget (waitUntil) — give the POST time to land
            time.sleep(20)
            captured = False
            if os.path.exists(LOG):
                raw = open(LOG).read()
                captured = 'received alert POST' in raw and last_down in raw
            with open(DONE, 'a') as f:
                f.write('%s CAPTURED: %s\n' % ('true' if captured else 'false', last_down))
            if captured:
                break
        else:
            print('%s probe: no down backends' % stamp)

        # shorter sleep if we're near the deadline
        remaining = deadline - time.time()
        time.sleep(min(poll_interval, max(remaining, 1)))

    with open(DONE, 'a') as f:
        f.write('done\n')
    try:
        tail.terminate()
    except Exception:
        pass
    time.sleep(2)
    try:
        tail.kill()
    except Exception:
        pass


if __name__ == '__main__':
    main()
