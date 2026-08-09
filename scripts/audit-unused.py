#!/usr/bin/env python3
"""List remaining @typescript-eslint/no-unused-vars warnings with file:line."""
import json
import subprocess

res = subprocess.run(
    ['npx', 'eslint', 'src/', 'tests/', '--format', 'json'],
    capture_output=True,
    text=True,
    cwd='/Users/mr.k/Downloads/webapp',
)
data = json.loads(res.stdout)

rows = []
for f in data:
    path = f.get('filePath', '').replace('/Users/mr.k/Downloads/webapp/', '')
    for m in f.get('messages', []):
        if m.get('ruleId') == '@typescript-eslint/no-unused-vars':
            rows.append((path, m['line'], m.get('message', '')[:110]))

for path, line, msg in sorted(rows):
    print(f'{path}:{line}  {msg}')
print(f'\nTOTAL: {len(rows)}')
