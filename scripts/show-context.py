#!/usr/bin/env python3
"""Print source context around audit-flagged lines."""
import sys

SITES = [
    ('src/lib/agentic/planner.ts', 355, 375),
    ('src/lib/agentic/search-tools.ts', 490, 505),
    ('src/lib/answer.ts', 195, 215),
    ('src/lib/canary/canary-orchestrator.ts', 240, 260),
    ('src/lib/html-rewriter.ts', 283, 300),
    ('src/lib/index/pipeline.ts', 375, 390),
    ('src/lib/index/pipeline.ts', 633, 650),
    ('src/lib/index/pipeline.ts', 833, 850),
    ('src/lib/index/scheduler.ts', 40, 80),
    ('src/lib/index/scheduler.ts', 115, 200),
    ('src/lib/jina-search.ts', 140, 160),
    ('src/lib/knowledge-panel.ts', 18, 40),
    ('src/lib/rich-snippets.ts', 310, 330),
    ('src/lib/yahoo-finance-search.ts', 505, 525),
    ('src/routes/chat.ts', 75, 95),
    ('src/routes/images.ts', 45, 75),
    ('src/routes/monitor.ts', 150, 165),
]

for path, start, end in SITES:
    print(f'\n===== {path}:{start}-{end} =====')
    lines = open(path).read().split('\n')
    for i in range(start - 1, min(end, len(lines))):
        print(f'{i+1}: {lines[i]}')
