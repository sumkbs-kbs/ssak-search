#!/usr/bin/env python3
"""Parse wrangler-tail capture logs for `[health] deep health probe complete`
lines and persist the last probe's `down_backends` to a state file — the
cron-bridge state writer for verify-do-binding.sh.

The 15-min scheduled deep probe (ssak-probe-scheduler) emits one `[health]`
structured-logger line per tick; run-prod-cron-tail.py captures it to a log
file. This parser reuses the same envelope handling as verify-do-binding.sh's
`parse_tail` (wrangler `--format json` string/array messages, pretty
multi-line events, and bare structured-logger lines) and writes the LAST
probe's `down_backends` to a JSON state file that verify-do-binding.sh reads
when its own tail capture exhausts (S104-③-⑦-③ cron bridge).

State file schema (written with --state):
    {"found": bool, "down_backends": str, "updated": ISO8601,
     "updated_epoch": float, "source": "cron-tail", "files": [paths]}

Usage:
    python3 scripts/parse-cron-health.py [--state PATH] LOGFILE...
    python3 scripts/parse-cron-health.py --self-test   # offline fixtures
"""

import argparse
import datetime
import json
import sys

TARGET = "deep health probe complete"


def extract_down(msg):
    """down_backends from a message that is itself a JSON string."""
    s = msg.strip()
    if s.startswith("{"):
        try:
            o = json.loads(s)
            if isinstance(o, dict) and "down_backends" in o:
                return str(o.get("down_backends") or "")
        except Exception:
            pass
    return None


def process_obj(obj, records):
    """Record down_backends for every [health] line in a JSON event."""
    if not isinstance(obj, dict):
        return
    entries = []
    logs = obj.get("logs")
    if isinstance(logs, list):
        for e in logs:
            if not isinstance(e, dict):
                continue
            m = e.get("message")
            if isinstance(m, str):
                entries.append(m)
            elif isinstance(m, list):
                entries.extend(p for p in m if isinstance(p, str))
    else:
        m = obj.get("message")
        if isinstance(m, str):
            entries.append(m)
        elif isinstance(m, list):
            entries.extend(p for p in m if isinstance(p, str))
    for msg in entries:
        if TARGET in msg:
            d = extract_down(msg)
            if d is not None:
                records.append(d)
    # Bare structured-logger line: down_backends at the TOP level (not nested
    # inside the message) — our logger output shape when not wrapped by
    # wrangler's envelope (verify-do-binding.sh parse_tail handles the same).
    m = obj.get("message")
    if isinstance(m, str) and TARGET in m and "down_backends" in obj:
        records.append(str(obj.get("down_backends") or ""))


def parse_file(path):
    """Return the ordered list of down_backends values found in one log file."""
    records = []
    try:
        with open(path, "r", errors="replace") as f:
            data = f.read()
    except OSError:
        return records
    dec = json.JSONDecoder()
    idx, n = 0, len(data)
    while idx < n:
        while idx < n and data[idx] in " \t\r\n":
            idx += 1
        if idx >= n:
            break
        try:
            obj, end = dec.raw_decode(data, idx)
            process_obj(obj, records)
            idx = end
        except Exception:
            # skip one line (banner / log-path note / non-JSON text)
            nl = data.find("\n", idx)
            idx = n if nl < 0 else nl + 1
    return records


def write_state(path, down, files):
    now = datetime.datetime.now(datetime.timezone.utc)
    st = {
        "found": down is not None,
        "down_backends": down or "",
        "updated": now.isoformat(),
        "updated_epoch": now.timestamp(),
        "source": "cron-tail",
        "files": files,
    }
    with open(path, "w") as f:
        json.dump(st, f, indent=2)


def main(argv):
    if argv and argv[0] == "--self-test":
        return self_test()
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("logs", nargs="+", help="wrangler tail capture log files")
    ap.add_argument("--state", default=None, help="state JSON path to write")
    args = ap.parse_args(argv)

    records = []
    for p in args.logs:
        records.extend(parse_file(p))

    if not records:
        if args.state:
            write_state(args.state, None, args.logs)
        print(json.dumps({"found": False, "down_backends": "", "files": args.logs}))
        return 0

    down = records[-1]  # last probe = most recent tick
    if args.state:
        write_state(args.state, down, args.logs)
    print(json.dumps({"found": True, "down_backends": down, "files": args.logs}))
    return 0


# ── Offline self-test (mirrors verify-do-binding.sh --self-test fixtures) ──
FIXTURES = {
    "string_message.log": '{"outcome":"ok","scriptName":"search-engine-api","logs":[{"level":"info","message":"{\\"timestamp\\":\\"t\\",\\"level\\":\\"info\\",\\"message\\":\\"[health] deep health probe complete\\",\\"status\\":\\"partial_outage\\",\\"down_backends\\":\\"wikipedia,bing\\",\\"latency_ms\\":1234}"}]}\n',
    "array_message.log": '{"outcome":"ok","scriptName":"pages-worker--16422884-production","logs":[{"level":"info","message":["{\\"timestamp\\":\\"t\\",\\"level\\":\\"info\\",\\"message\\":\\"[health] deep health probe complete\\",\\"status\\":\\"partial_outage\\",\\"down_backends\\":\\"naver\\",\\"latency_ms\\":4321}"]}]}\n',
    "bare_line.log": '{"timestamp":"t","level":"info","message":"[health] deep health probe complete","status":"ok","down_backends":"none","latency_ms":987}\n',
    "pretty_multi.log": (
        '{\n  "outcome": "ok",\n  "scriptName": "search-engine-api",\n'
        '  "logs": [\n    {\n      "level": "info",\n'
        '      "message": "{\\"timestamp\\":\\"t\\",\\"level\\":\\"info\\",\\"message\\":\\"[health] deep health probe complete\\",\\"status\\":\\"ok\\",\\"down_backends\\":\\"none\\",\\"latency_ms\\":987}"\n'
        "    }\n  ]\n}\n"
    ),
    "no_health.log": '{"outcome":"ok","scriptName":"search-engine-api","logs":[{"level":"info","message":"some other line"}]}\n',
}


def self_test():
    import os
    import tempfile

    failures = 0
    with tempfile.TemporaryDirectory() as tmp:
        # single-file cases
        cases = [
            ("string_message.log", "wikipedia,bing"),
            ("array_message.log", "naver"),
            ("bare_line.log", "none"),
            ("pretty_multi.log", "none"),
            ("no_health.log", None),
        ]
        for name, expected in cases:
            path = os.path.join(tmp, name)
            with open(path, "w") as f:
                f.write(FIXTURES[name])
            records = parse_file(path)
            got = records[-1] if records else None
            if got != expected:
                print(" ❌ self-test FAIL: %s → %r (expected %r)" % (name, got, expected))
                failures += 1
            else:
                print(" ✅ self-test PASS: %s → %r" % (name, got))

        # multi-file: LAST health line wins across files (scheduler tick newer
        # than the pages tail)
        p1 = os.path.join(tmp, "string_message.log")
        p2 = os.path.join(tmp, "bare_line.log")
        records = parse_file(p1) + parse_file(p2)
        if records[-1] != "none":
            print(" ❌ self-test FAIL: multi-file last-wins → %r (expected none)" % records[-1])
            failures += 1
        else:
            print(" ✅ self-test PASS: multi-file last-wins → %r" % records[-1])

        # state write
        state = os.path.join(tmp, "state.json")
        with open(p1, "w") as f:
            f.write(FIXTURES["string_message.log"])
        if main([p1, "--state", state]) == 0:
            with open(state) as f:
                st = json.load(f)
            if st.get("found") is not True or st.get("down_backends") != "wikipedia,bing" \
                    or "updated_epoch" not in st or st.get("source") != "cron-tail":
                print(" ❌ self-test FAIL: state file schema → %r" % st)
                failures += 1
            else:
                print(" ✅ self-test PASS: state file schema ok")
        else:
            failures += 1

        # empty / missing file → found:false, state written
        empty = os.path.join(tmp, "empty.log")
        with open(empty, "w") as f:
            f.write("")
        if main([empty, "--state", state]) == 0:
            with open(state) as f:
                st = json.load(f)
            if st.get("found") is not False:
                print(" ❌ self-test FAIL: empty state → %r" % st)
                failures += 1
            else:
                print(" ✅ self-test PASS: empty log → found:false")
        else:
            failures += 1

    if failures:
        print(" ❌ %d self-test case(s) failed" % failures)
        return 1
    print(" ✅ parse-cron-health self-test: all PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
