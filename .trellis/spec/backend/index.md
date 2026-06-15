# Backend Development Guidelines

> Best practices for backend development in this project.
>
> **Backend = Firebase Cloud Functions (Node.js 22 + TypeScript) under `functions/`** +
> Cloud Firestore. The Flutter app (`lib/`) is the [frontend](../frontend/index.md).
> Authoritative design docs: [`docs/ARCHITECTURE.md`](../../../docs/ARCHITECTURE.md),
> [`docs/COURSE_METHODS.md`](../../../docs/COURSE_METHODS.md),
> [`docs/AI_AGENT_RULES.md`](../../../docs/AI_AGENT_RULES.md). These specs distill those for sub-agents.

---

## Overview

This directory contains guidelines for backend development, derived from the real `functions/src/`
codebase and the `docs/` design docs.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | `functions/src/` layout, handler/trigger/flow split | ✅ Filled |
| [Database Guidelines](./database-guidelines.md) | Firestore paths, rules, concurrency (idempotency/transactions), vector search, type-strict queries (Rule H) | ✅ Filled |
| [Error Handling](./error-handling.md) | `HttpsError`, webhook verify, locks, Rule D | ✅ Filled |
| [Quality Guidelines](./quality-guidelines.md) | v2-only, region, forbidden patterns, never-deploy | ✅ Filled |
| [Logging Guidelines](./logging-guidelines.md) | `firebase-functions` structured logger | ✅ Filled |
| [Testing Guidelines](./testing-guidelines.md) | jest + ts-jest, boundary mocking for `onCall`, lint config | ✅ Filled |

---

## How to Fill These Guidelines

For each guideline file:

1. Document your project's **actual conventions** (not ideals)
2. Include **code examples** from your codebase
3. List **forbidden patterns** and why
4. Add **common mistakes** your team has made

The goal is to help AI assistants and new team members understand how YOUR project works.

---

**Language**: All documentation should be written in **English**.
