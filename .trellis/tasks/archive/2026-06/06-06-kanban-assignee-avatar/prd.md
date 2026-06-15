# Show GitHub avatar on the kanban assignee circle

## Goal
The kanban card's bottom-right assignee circle (`_AssigneeCircle` in
`tasks_board_page.dart`) shows the first character of the assignee's **uid**
(e.g. "U"). Show the assignee's GitHub avatar image instead, keeping the letter
as a fallback when there's no photo.

## What I already know
* `MembersViewModel.profileFor(uid)` (added in 06-06-rich-task-cards) returns the
  member's `AppUser` (with `avatarUrl` from GitHub, `githubLogin`, `name`),
  cached. It's provided in the shell, so the card can read it.
* `task_details_page.dart`'s `_Avatar` already does exactly this
  (CircleAvatar foregroundImage NetworkImage + letter fallback) — mirror it.

## Requirements
1. `_AssigneeCircle` resolves the assignee via `MembersViewModel.profileFor`;
   show `avatarUrl` as a `CircleAvatar.foregroundImage`; fall back to the
   githubLogin/name initial (then uid) when no photo. Keep the unassigned grey
   circle and the 20px size / accent tint.

## Acceptance Criteria
* [ ] Assigned card shows the GitHub avatar; falls back to a letter when no URL.
* [ ] Unassigned card unchanged (grey circle). analyze + tests green.

## Out of Scope
* Any other card element.
