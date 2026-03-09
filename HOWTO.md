# How to Use Claude Code Skills

This template ships with Claude Code skills in `.claude/skills/` that guide you through a structured development workflow — from idea to implementation.

## Available Skills

| Skill | Command | Purpose |
|-------|---------|---------|
| Grill Me | `/grill-me` | Pressure-test an idea or design before committing |
| Write a PRD | `/write-a-prd` | Create a Product Requirements Document through structured interview |
| PRD to Plan | `/prd-to-plan` | Break a PRD into phased vertical slices |
| PRD to Issues | `/prd-to-issues` | Create GitHub issues from a PRD |
| TDD | `/tdd` | Implement features using test-driven development |
| Environment Variables | `/environment-variables` | Add and validate environment variables |

## Recommended Workflow

### 1. Explore and validate your idea

Start with `/grill-me` when you have a rough idea but haven't fully thought it through. Claude will interview you relentlessly — walking down each branch of the design tree, resolving dependencies between decisions one-by-one. This is useful for:

- Vetting an architecture decision
- Exploring trade-offs before committing
- Stress-testing a design with someone who will push back

You don't need to use this every time. If you already have a clear picture of what you want to build, skip straight to writing the PRD.

### 2. Define requirements

```
/write-a-prd
```

Describe what you want to build. Claude will:

1. Ask for a detailed problem description
2. Explore the codebase to understand current state
3. Interview you about every aspect of the plan (similar to grill-me, but within the PRD context)
4. Sketch out major modules, looking for deep modules that encapsulate complexity behind simple interfaces
5. Write a structured PRD and submit it as a GitHub issue

The PRD includes: problem statement, solution, user stories, implementation decisions, testing decisions, and scope boundaries.

### 3. Create an implementation plan

```
/prd-to-plan
```

Takes the PRD and breaks it into phased **vertical slices** (tracer bullets). Each phase cuts through all layers end-to-end — schema, API, logic, tests — rather than building one horizontal layer at a time. The output is a markdown file saved to `./plans/`.

### 4. Create GitHub issues

```
/prd-to-issues
```

Give it the PRD issue number. Claude breaks the plan into independently-grabbable GitHub issues, each classified as:

- **AFK** — Can be implemented without human input
- **HITL** — Requires human decisions (architecture choices, design reviews)

Issues are created with dependency links so you know what to work on first.

### 5. Implement with TDD

```
/tdd
```

Pick an issue and implement it. The TDD skill enforces vertical slices in your test workflow too:

```
RED   → Write ONE failing test
GREEN → Write minimal code to pass
REFACTOR → Clean up, then repeat
```

Never write all tests first. Each test responds to what you learned from implementing the previous one.

### 6. Add environment variables

```
/environment-variables
```

When you need a new env var at any point, this skill walks you through:

1. Adding the Zod schema to `src/lib/env.ts`
2. Placing the value in `.env` (defaults) or `.env.local` (secrets)
3. Adding validation tests

## Example: Building a Weather CLI

```
# 1. Got a rough idea? Stress-test it first
/grill-me
> "I want to build a CLI that fetches weather data and caches it locally"
> Claude challenges your caching strategy, API choices, error handling...

# 2. Ready to formalize? Write the PRD
/write-a-prd
> Claude interviews you, creates GitHub issue #1

# 3. Break it into phases
/prd-to-plan
> Creates ./plans/weather-cli.md with vertical slices

# 4. Create trackable issues
/prd-to-issues
> "The PRD is issue #1"
> Creates issues #2 (fetch endpoint), #3 (cache layer), #4 (CLI interface)...

# 5. Implement each issue
/tdd
> "Let's implement issue #2"
> Red-green-refactor cycle

# 6. Need an API key?
/environment-variables
> Adds WEATHER_API_KEY to env schema and .env.local
```

Each skill is conversational — Claude will ask questions and iterate with you before taking action.
