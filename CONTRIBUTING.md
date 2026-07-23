# Contributing

Thanks for your interest in improving this project! This document lays out
the bar for changes that will merge quickly.

## Pull Request Checklist

Before opening a PR, please make sure **all** of the following pass:

```bash
npm run typecheck     # strict TypeScript, no errors
npm test              # all unit tests pass
npm run build         # vite build is green
```

CI runs the same three commands on every PR; pre-existing failures elsewhere
do not count as blockers but new regressions do.

## Branches & Commits

- Branch name: `feat/<slug>`, `fix/<slug>`, `docs/<slug>`, or `chore/<slug>`.
- Keep one logical change per PR. A PR that mixes a parser fix with a UI
  tweak will be asked to split.
- Commit messages: imperative mood (`Add SSRF guard for 169.254.x`), ≤72
  chars in the subject line. Reference issues at the bottom (`Closes #123`).
- Do not squash on submit. We rebase-merge at PR time.

## Code Style

- TypeScript `strict: true`. No `as any`, no `@ts-ignore`, no
  `@ts-expect-error`. If a type is genuinely unknown, model it as `unknown`
  and narrow before use.
- Do not silence `try/catch`. If you must swallow an error, log it with
  `console.warn` and a one-line explanation of why re-throwing is wrong.
- No new direct dependencies without justification. The current dep set
  (`hono`) is intentionally minimal; rolling your own 30-line helper beats
  pulling a package.
- Functions ≥80 lines are usually wrong. If you find yourself writing one,
  look for an extraction point.

## Tests

- Bug fixes ship with a regression test that fails before the fix and passes
  afterward.
- New public exports ship with at least one happy-path and one failure-path
  test.
- Place tests under `tests/unit/` (or `tests/api/` for HTTP-level checks).
  Keep them free of network calls — nothing in `tests/unit/` should reach
  the internet.

## Security-fix Path

If your change fixes a security issue, **do not open a public PR**. See
[SECURITY.md](./SECURITY.md) for the private disclosure process.

## Reporting Issues

For non-security issues, file a public issue with:

1. A minimal reproduction (script or curl pair)
2. What you expected
3. What you got
4. Worker version (run `npm run build && npx wrangler --version`)

Issues without a reproduction will be closed as `needs-info`.
