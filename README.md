# ts-template

TypeScript template for building tool and service projects with modern tooling, strict type-checking, and automated releases.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 22
- [pnpm](https://pnpm.io/)

## Setup

```bash
pnpm install
```

This installs dependencies and configures git hooks automatically via the `prepare` script.

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm build` | Build with tsup (ESM + declarations) |
| `pnpm lint` | Check code with Biome |
| `pnpm lint:fix` | Auto-fix lint/format issues |
| `pnpm types` | Type-check with tsc --noEmit |
| `pnpm test` | Run tests with Vitest |
| `pnpm test:watch` | Run tests in watch mode |
| `pnpm unused` | Detect unused code with Knip |
| `pnpm update` | Interactive dependency updates with Taze |

## Development Workflow

This template includes Claude Code skills that guide you through a structured workflow — from idea to implementation. See **[HOWTO.md](HOWTO.md)** for a full guide on using the skills.

Quick overview:

1. `/grill-me` — Pressure-test your idea
2. `/write-a-prd` — Define requirements as a GitHub issue
3. `/prd-to-plan` — Break the PRD into vertical slices
4. `/prd-to-issues` — Create GitHub issues from the plan
5. `/tdd` — Implement using test-driven development
6. `/environment-variables` — Add validated env vars

### Committing

When you're done implementing (e.g. after a `/tdd` cycle), just ask Claude Code to commit:

```
commit this
```

Claude Code will stage the relevant files, write a conventional commit message based on the changes, and run the pre-commit hook (lint + tests) automatically. If the hook fails, it will fix the issues and retry.

You can also use the built-in shortcut:

```
/commit
```

### Manual workflow

1. Write tests co-located with source files (`*.test.ts`)
2. Use TDD: write a failing test, make it pass, refactor
3. Commit using [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, etc.)
4. Pre-commit hooks automatically run linting and tests
5. Push to `main` triggers CI checks and semantic-release

## Environment Variables

Environment configuration uses `@t3-oss/env-core` with Zod validation:

- `.env` — Development defaults (committed)
- `.env.local` — Secrets and overrides (gitignored)

Define schemas in `src/lib/env.ts`.

## CI/CD

GitHub Actions runs on push to `main`:

1. Lint, type-check, test, and unused code detection
2. If all checks pass, semantic-release creates a GitHub Release with tag

## Contributing

1. Create a feature branch
2. Make changes following the existing patterns
3. Ensure `pnpm lint && pnpm types && pnpm test && pnpm unused` all pass
4. Open a PR against `main`
