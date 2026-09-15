# Contributing

Thanks for looking. This project has one unusual house rule, and everything else
follows from it.

## The house rule: claims are measured, not asserted

Every performance or quality claim in this repository is marked as either
**measured** (a command ran, and its output is in the repo) or **assumed** (read
from code, inferred, remembered). There is nothing in between. `PLAN.md` and the
documents under `docs/` follow this convention throughout.

If you add a claim about frame rates, sharpness, capture efficiency, encoder
throughput, or how some other tool behaves, it needs a number and a way to
reproduce it. "Faster" and "smoother" are not claims, they are adjectives. A
claim about software you did not measure does not belong here at all — not even
a favourable one.

The same applies to tests. A green test proves nothing unless the instrument it
uses can be shown to move: check that the assertion fails when the behaviour it
guards is broken.

## Getting set up

Node 22 or later, and pnpm.

```bash
pnpm install
pnpm browsers:install   # downloads Chromium
pnpm demo:hello         # smoke test: opens a headless page, exits 0
```

## Before you open a pull request

```bash
pnpm typecheck
pnpm lint
pnpm format
pnpm test
```

A pre-commit hook runs the type check and lints staged files. Do not bypass it
with `--no-verify`; if it fails, fix the cause.

The `tools/smoothness/` directory is a standalone Python tool with its own
dependency manifest, deliberately not part of the shipped package:

```bash
uv run --project tools/smoothness ruff check tools/smoothness
uv run --project tools/smoothness pytest tools/smoothness
```

## Code style

TypeScript as ESM, two-space indentation, Prettier is the source of truth for
formatting. Name files by responsibility, `camelCase` for functions and
variables, `PascalCase` for types. Keep browser automation behind focused
wrappers so the recording, rendering, and upload stages stay independently
testable.

Comments explain _why_, not _what_. Several comments in `src/` are long because
they record a measurement or a rejected approach — that is intentional, and the
reason those decisions are still legible months later.

## Commits and pull requests

Conventional Commits, imperative, one commit per reason: `feat(record): swipe on
touch devices`, `docs: add device concept`. The subject line stays under fifty
characters; the body explains why the change was necessary.

A pull request should describe observable behaviour, list the commands you ran,
and attach evidence for anything visual — an `ffprobe` dump for capture work, a
still or a clip for render work.

## Things that must never be committed

Credentials, saved browser sessions, cookies, browser profiles, private
hostnames, absolute local paths, and recordings of anything other than the test
fixtures in this repository. The `auth/` directory is reserved for local
material that is ignored by git.

## Reused code

`THIRD-PARTY.md` records the code adopted from other projects, what was changed
on adoption, and what was deliberately not adopted. If you adopt more, add it
there in the same shape — origin, commit, licence, and the differences.
