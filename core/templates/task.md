---
id: T001
title: Short imperative title
phase: 1-mvp
kind: feat            # feat | fix | refactor | chore | docs | test | setup (build, runners, scaffolding: no failing test first; green, lint, typecheck and tests must pass)
tier: standard        # grunt | standard | frontier
risk: low             # low | high (auth, money, deletion, schema, secrets, public API)
checks: [C1]
requirement: PRD#section
blockedBy: []
allowedPaths: [src/feature/**, tests/feature/**]
testCommand: ""       # focused test command; empty = project test command
---

## Goal
One line: what this slice delivers to the user.

## Context
Paths only: docs/02-design/ARCHITECTURE.md#section, src/feature/
