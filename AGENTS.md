# Repository Guidelines

## Project Structure

Featurecast is a TypeScript package for recording Playwright feature demos. Keep library code in `src/`, executable examples in `demo/`, and automated tests in `tests/`. Planning and acceptance criteria live in `PLAN.md` and `MILESTONES.md`; device presets and capture decisions belong in `docs/DEVICES.md`. The measuring corpus — the dense page every benchmark and acceptance run films — lives in `fixtures/bench/` and is served over loopback by `src/fixture-server.ts`; it is the application under the camera, not part of the package, and it is the one place in the repository where code runs in a browser page rather than in Node. Standalone check tools that are not part of the shipped package live in `tools/<name>/` with their own dependency manifest; `tools/smoothness/` measures motion smoothness on the finished video and is Python on purpose (see its README). Do not put credentials or saved browser sessions under version control; `auth/` is reserved for ignored local material.

## Build, Test, and Development Commands

Use pnpm with Node 22 or later.

- `pnpm install` installs dependencies.
- `pnpm browsers:install` downloads Chromium after a clean install.
- `pnpm demo:hello` launches a headless Playwright page and exits; it is the M0 smoke test.
- `pnpm test` runs the Vitest suite.
- `pnpm typecheck` checks TypeScript without emitting files.
- `pnpm lint` runs ESLint, and `pnpm format` verifies Prettier formatting.

Future capture and render commands must be documented with their artifact paths and acceptance evidence.

## Coding Style and Tests

Write TypeScript as ESM, with two-space indentation and Prettier as the source of formatting truth. Name files by responsibility, use `camelCase` for functions and variables, and `PascalCase` for types. Keep browser automation behind focused wrappers so recording, rendering, and upload stages remain independently testable.

Add or update a Vitest test before changing behavior. Use descriptive names such as `records deterministic pointer samples`. For capture work, test metadata and encoder arguments in unit tests, then retain sanitized `ffprobe` evidence for milestone acceptance.

## Commits and Pull Requests

Use concise scoped imperatives, following the existing style: `docs: add device concept` or `feat: record screencast frames`. Each pull request should identify its Forgejo milestone or issue, describe observable behavior, list commands run, and attach sanitized screenshots or video evidence for media changes. Never include private URLs, host details, credentials, local paths, or production recordings.
