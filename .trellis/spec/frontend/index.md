# Frontend Development Guidelines

> Best practices for frontend development in this project.
>
> **Frontend = the Flutter app under `lib/`** (MVVM, `provider`, `go_router`). The template's
> React-flavored slots are repurposed for Flutter below. The [backend](../backend/index.md) is
> Cloud Functions. Authoritative design docs: [`docs/ARCHITECTURE.md`](../../../docs/ARCHITECTURE.md),
> [`docs/COURSE_METHODS.md`](../../../docs/COURSE_METHODS.md),
> [`docs/AI_AGENT_RULES.md`](../../../docs/AI_AGENT_RULES.md).

---

## Overview

This directory contains guidelines for frontend (Flutter) development, derived from the real
`lib/` codebase and the `docs/` design docs.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | `lib/` MVVM 5-layer layout, Fake/Live split | ✅ Filled |
| [Component Guidelines](./component-guidelines.md) | Widgets/Views, theme, navigation, async+mounted | ✅ Filled |
| [Hook Guidelines](./hook-guidelines.md) | Repurposed → Models + Repositories (Flutter has no hooks) | ✅ Filled |
| [State Management](./state-management.md) | `provider` + `ChangeNotifier` ViewModels | ✅ Filled |
| [Quality Guidelines](./quality-guidelines.md) | `flutter analyze`, forbidden deps, never-commit | ✅ Filled |
| [Type Safety](./type-safety.md) | Dart null-safety, enum+wire, hand-written maps | ✅ Filled |

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
