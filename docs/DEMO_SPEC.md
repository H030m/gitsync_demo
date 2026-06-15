# SPEC — TeamPulse (demo project)

> Paste this whole file into **Add task → AI breakdown** to generate a fresh,
> coherent task board for a demo. It's written to produce ~8–10 milestone-sized
> tasks with sensible dependencies. (Reset first via **Settings → Danger zone →
> Delete all tasks**.)

## Overview
TeamPulse is a mobile + web app that gives a software team a single place to see
what's happening across their GitHub repo and Discord chat: progress, who did
what, what's blocked, and AI-written daily reports. Backend is Firebase
(Auth, Firestore, Cloud Functions); frontend is Flutter; AI flows call an LLM
with function-calling.

## Goals
- One screen to answer "what happened recently and who did it".
- Turn raw commits + chat into short, useful daily reports.
- Let anyone ask natural-language questions about the project.

## Functional requirements

### 1. Accounts & repo connection
- Sign in with GitHub OAuth.
- Connect a repository; import collaborators as team members.
- Store repos, members, and per-repo settings in Firestore.

### 2. Activity ingestion
- Webhook receives GitHub push / PR / issue events and stores raw docs.
- A Discord bot backfills channel messages into Firestore.
- Background triggers enrich each item (link commits to tasks, embeddings,
  one-line AI summaries).

### 3. Task board
- Kanban board (To do / In progress / Done) with a dependency graph view.
- Create tasks manually, or paste a spec and let the AI break it into subtasks
  with dependencies.
- Auto-assign a task to the best-fit member based on workload and past work.

### 4. Daily report
- A scheduled job summarizes each day's commits, completed tasks, and chat into
  a short report, and rolls it into a durable "project memory".
- Users can ask follow-up questions about any date range.

### 5. Ask & explain
- A repo-wide "ask anything" assistant grounded in commits, tasks, and chat.
- Tap any commit to get an AI explanation of what changed and why.

### 6. Notifications
- Push notification when a task becomes assigned to you, localized to the
  user's app language (English / Traditional Chinese).

## Non-functional
- Light and dark mode throughout.
- Asia/Taipei timezone for all date grouping.
- All AI answers must be grounded in real data — no fabrication.

## Tech stack (use the existing one — do not introduce new tech)
Flutter (Provider, go_router), Firebase (Auth, Firestore, Cloud Functions in
TypeScript), an LLM via function-calling, GitHub REST/GraphQL, a Discord bot.
