#!/usr/bin/env python3
"""Deeper inspection of flagged sites."""

print('===== images.ts: full execute + bing filter usage =====')
lines = open('src/routes/images.ts').read().split('\n')
for i, l in enumerate(lines):
    if any(k in l for k in ['SIZE_MAP', 'COLOR_MAP', 'TYPE_MAP', 'searchAllFreeImageSources', 'params.append', 'function searchBing']):
        print(f'{i+1}: {l}')

print('\n===== images.ts: searchAllFreeImageSources bing params =====')
src = open('src/routes/images.ts').read()
import re as _re
m = _re.search(r'function searchBingImages.*?(?=\nfunction |\n//|\Z)', src, _re.S)
if m:
    body = m.group(0)[:1800]
    for i, l in enumerate(body.split('\n')):
        print(l)

print('\n===== pipeline.ts: updateUrlMetadata full =====')
lines = open('src/lib/index/pipeline.ts').read().split('\n')
for i in range(378, 410):
    print(f'{i+1}: {lines[i]}')

print('\n===== search-tools.ts: assemblePrompt citation usage =====')
lines = open('src/lib/agentic/search-tools.ts').read().split('\n')
for i, l in enumerate(lines):
    if 'citationStyle' in l or 'bracket' in l or "'inline'" in l:
        print(f'{i+1}: {l}')

print('\n===== rich-snippets.ts: RichSnippet type =====')
lines = open('src/lib/rich-snippets.ts').read().split('\n')
for i, l in enumerate(lines[:80]):
    if 'type RichSnippet' in l or 'interface RichSnippet' in l:
        for j in range(i, min(i + 15, 80)):
            print(f'{j+1}: {lines[j]}')
        break
