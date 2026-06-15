# Clickable GitHub issue/PR links in task detail

## Goal
In TaskDetailsPage the linked GitHub issue/PR currently render as non-tappable
chips (deferred from 06-06-rich-task-cards-ai-handoff because there was no
`url_launcher` dep and no repo URL in the task-detail subtree). Make them open
the real GitHub issue/PR in the browser.

## What I already know (repo inspection 2026-06-06)
* `Repo.url` (`lib/models/repo.dart`) holds the full GitHub URL
  (e.g. `https://github.com/owner/repo`). Issue URL = `${url}/issues/N`,
  PR URL = `${url}/pull/N`.
* `RepoRepository.streamRepo(repoId)` / `getRepo` exist (`repo_repo.dart`); the
  fake serves `DummyData.demoRepo` for the demo repo, so it works in fake mode too.
* The shell (`app_router.dart` ShellRoute) provides Tasks/Members/Commits/Discord/
  DailyReport VMs but NO Repo — that's why the URL wasn't reachable. Views must not
  import repositories (component-guidelines), so add a small RepoViewModel.
* No `url_launcher` in pubspec — must add it.

## Requirements
1. Add `url_launcher` dependency.
2. Add `RepoViewModel` (streams `streamRepo(repoId)`), provide it in the shell.
3. In TaskDetailsPage make the issue/PR chips tappable → `launchUrl` the GitHub
   URL built from `repo.url`. If `repo?.url` is empty/unknown, keep the chip
   non-tappable (graceful degrade — e.g. fake non-demo repo).

## Acceptance Criteria
* [ ] Tapping `Issue #N` / `PR #N` opens `…/issues/N` / `…/pull/N` in the browser.
* [ ] No repo URL → chip shows but does nothing (no crash).
* [ ] `flutter analyze` clean; existing tests green; Fake path unaffected.

## Out of Scope
* Membership / assigning to other users (separate concern).
* Deep-linking anything other than issue/PR.

## Technical Notes
* `url_launcher` `launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication)`.
* Guard context across the await with `if (!mounted)` / captured messenger.
