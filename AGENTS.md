# AGENTS.md

## Project Overview

TypeScript template for building tool/service projects. Uses ESM-only modules with strict TypeScript, Biome for linting/formatting, Vitest for testing, and semantic-release for automated releases.

## Project Structure

```
src/
├── index.ts              # Main entry point, re-exports from lib modules
└── lib/
    ├── config.ts         # CONDUCTOR.md parser (gray-matter + Zod)
    ├── config.test.ts    # Config parsing tests
    ├── template.ts       # {{ variable }} template renderer
    ├── template.test.ts  # Template rendering tests
    ├── example.ts        # Example module
    └── example.test.ts
```

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

## Testing Conventions

- Tests are **co-located** next to source files: `foo.ts` → `foo.test.ts`
- Use **TDD** with vertical slices (red → green → refactor, one test at a time)
- Test **behavior through public interfaces**, not implementation details
- Run tests: `pnpm test`

## Commit Format

Conventional Commits enforced via commitlint:

```
<type>(<scope>): <description>

Types: feat, fix, refactor, test, docs, chore, ci, perf
```

Pre-commit hook runs `pnpm lint && pnpm test` automatically.

## Development Workflow

1. **write-a-prd** — Define requirements through structured interview
2. **prd-to-plan** — Break PRD into phased vertical slices
3. **prd-to-issues** — Create GitHub issues from the plan
4. **tdd** — Implement each slice using test-driven development

## Formatting Rules

- Biome with `ultracite/core` preset
- Line width: 100
- Indentation: tabs
- Unused imports: warned
- Run `pnpm lint:fix` after every file creation/edit — don't batch at end

## Known Gotchas

### Zod 4: Nested object defaults don't cascade
`z.object({ foo: z.string().default("bar") }).default({})` — the `{}` is used as-is, inner defaults are NOT applied.
**Fix:** Use `z.preprocess((v) => v ?? {}, schema)` instead of `.default({})` for nested object schemas. See `withDefault()` helper in `src/lib/config.ts`.

### Biome: Import ordering is enforced
After adding/reordering exports in `src/index.ts`, `type` exports sort before value exports from the same module.

### TDD: Batch obvious edge-case tests
If the tracer bullet implementation clearly handles edge cases (e.g., regex already covers missing keys, empty strings), write all edge-case tests in one slice instead of individual RED-GREEN cycles that all pass immediately. Reserve individual slices for behaviors that need new code.
