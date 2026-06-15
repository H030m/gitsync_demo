# Component (Widget / View) Guidelines

> Flutter has Widgets, not React components. "Views" = full-screen page Widgets in `lib/views/`;
> reusable pieces go in `lib/widgets/` (create when first needed).
> Source: [`COURSE_METHODS.md`](../../../docs/COURSE_METHODS.md), [`AI_AGENT_RULES.md §3`](../../../docs/AI_AGENT_RULES.md).

---

## View layer rules

- A page is a `XxxPage` Widget (usually `StatefulWidget` when it has form/animation state).
- Read state with `Consumer<VM>` in `build()`; read one-shot (no rebuild) with
  `Provider.of<VM>(ctx, listen: false)` inside callbacks.
- **Never** import `cloud_firestore` or `repositories/*` in a View. Go through the ViewModel.
- **Navigation** goes through `NavigationService` (`Provider.of<NavigationService>(ctx,
  listen:false).goTasks(repoId)`), never raw `context.go(...)` or `Navigator.push` — and never
  mix GoRouter with Navigator 1.0.

---

## Async + BuildContext

Every `BuildContext` use after an `await` must be guarded by `if (mounted)`:

```dart
try {
  await viewModel.addTask(newTask);
  if (mounted) {
    Provider.of<NavigationService>(context, listen: false).pop(context);
  }
} on TimeoutException catch (e) {
  if (mounted) {
    ScaffoldMessenger.of(context).clearSnackBars();
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text('Operation timed out: ${e.message}')));
  }
}
```

User-facing error handling (snackbars, dialogs) belongs **in the View** — not swallowed in the
ViewModel. The Repository adds a `.timeout(...)` and does **not** catch (see
[`hook-guidelines.md`](./hook-guidelines.md)).

---

## Styling / Theme

- **Never hardcode color strings.** Use `Theme.of(ctx).colorScheme.X` and
  `Theme.of(ctx).textTheme.X`. Brand colors live in `lib/theme/app_colors.dart` and are wired via
  `ColorScheme.fromSeed` in `app_theme.dart` (light seed `#1565C0`, dark accent `#FAB28E`).
- Spacing/radius tokens per [`ARCHITECTURE.md §8.2`](../../../docs/ARCHITECTURE.md) are codified in
  `lib/theme/app_dimens.dart` (`AppDimens.radiusSm/Md/Lg`, `spacingXs/Sm/Md/Lg`). **Use these
  instead of magic numbers** for padding/radius.
- Component look (Card, AppBar, FilledButton, SegmentedButton, inputs, ListTile, Divider, TabBar,
  FAB, SnackBar) is centralized in the `_themeFrom(...)` factory in `app_theme.dart`. **Polish
  app-wide by editing that one factory**, not per-page — both light and dark inherit it.
- Reuse `EmptyState(icon, title, message)` from `lib/widgets/empty_state.dart` for "nothing here
  yet" placeholders instead of a bare centered `Text`.
- Theme mode: `ThemeModeNotifier` defaults to `ThemeMode.system` with **no persistence**
  (resets on reload — intentional). Settings exposes a 3-way System/Light/Dark `SegmentedButton`,
  **not** a binary switch (a switch reading `mode == dark` contradicts the system default).

---

## Forms

```dart
final _formKey = GlobalKey<FormState>();
// ...
Future<void> _submit() async {
  if (!_formKey.currentState!.validate()) return;
  _formKey.currentState!.save();
  // call viewModel.addX()
}
```

---

## Graph / DAG visualization (graphview)

Task dependency graphs render with the **`graphview`** package + a layered Sugiyama
layout (`lib/views/tasks/widgets/task_graph_tab.dart`). Conventions learned:

- Use the **plain `GraphView(...)` constructor wrapped in your own
  `InteractiveViewer(constrained: false, ...)`** for pan/zoom. Do **not** use
  `GraphView.builder` — it injects its *own* internal `InteractiveViewer` (fixed
  `boundaryMargin: infinity`, `minScale: 0.01`), so combining it with a custom one
  double-nests them and you lose control of the zoom bounds.
- `addNode(Node.Id(id))` for **every** task first, then `addEdge` — otherwise
  dependency-less tasks vanish (edges alone only create their endpoints).
- Edge direction = **prerequisite → dependent** (`addEdge(Node.Id(depId), Node.Id(taskId))`).
  Guard against dangling edges: skip a `depId` not present in the current task set.
- `Node.Id(x)` stores `key = ValueKey(x)`; read it back in the builder via
  `node.key!.value`. Map id → model object for the node widget.
- Node colors come from `Theme.of(ctx).colorScheme` keyed on the status enum with an
  exhaustive `switch` (no `default`, so a new status is a compile error), per Styling above.
- **Readable Sugiyama layout** (06-06 polish): keep `ORIENTATION_TOP_BOTTOM` but use a
  small `nodeSeparation` (~24) + larger `levelSeparation` (~90) so siblings line up and
  diagonal sweeps shorten; short `CurvedBendPointShape(curveLength: 8)` + thin, low-alpha
  edge paint so nodes (not lines) carry the eye; **uniform node footprint** (fixed
  width+height, title `maxLines: 2` ellipsis) so every layer aligns.
- **Fit-to-view**: graphview lays out at intrinsic size, so wrap the `GraphView` in a
  `LayoutBuilder` + `GlobalKey`, and in a one-shot post-frame callback measure
  `key.currentContext.size`, compute `scale = min(viewportW/w, viewportH/h).clamp(.2,1)`,
  and set the `TransformationController` (scale on the matrix diagonal, translate in
  column 3 via `setEntry` — `Matrix4.translate/scale` are deprecated). Guard with a
  `_fitted` flag re-armed when the node-id set changes, so it frames on open without
  fighting the user's pan/zoom. A pinned (non-panning) status legend goes in the `Stack`
  next to the `Positioned.fill` viewer.
- **Editing the DAG** (06-06): graphview has no edge-drawing/node-drag, so editing is
  gesture + menu driven — `GestureDetector` on the node (`onTap` = open / pick-target in
  connect mode; `onLongPressStart` gives the global position for `showMenu`). Add-node is a
  `Positioned` `FloatingActionButton.small` in the `Stack`. Graph mutations go through the
  ViewModel; the **graph-theory lives in pure, unit-tested helpers**
  (`view_models/graph_edit_ops.dart`): `wouldCreateCycle` (DFS reachability — reject an edge
  whose reverse path already exists) before adding a `dependsOn`, and `bridgeOnDelete`
  (DAG contraction: reconnect a deleted node's prerequisites to its dependents, dedup, never
  self-depend) on delete. Re-layout + fit-to-view are automatic on the next stream rebuild.
  Editing `dependsOn` needs `TaskRepository.updateDependsOn` (don't forget the Fake).

---

## Scrolling & scrollbars

- **Columns/lists that grow must scroll, and need a bounded height to do so.** A
  kanban column whose card list is a plain `Column` overflows once tasks exceed the
  viewport. Give the column a bounded height — `Row(crossAxisAlignment: stretch)` in
  fill mode — then make the card area `Expanded(child: ListView(...))` so it scrolls
  within the column (`tasks_board_page.dart` `_BoardColumn`).
- **Phone board = collapsible sections, not horizontal columns** (06-13 redesign):
  below the fill threshold the board renders ONE vertical `ListView` of three
  status sections (`_SectionedBoardList`) — tonal tappable headers (reuse
  `_ColumnTheme` + `_CountChip` + `AnimatedRotation` chevron), `AnimatedSize`
  expand/collapse (todo+inProgress open / done collapsed by default, page-local
  state), simple rows (circle + title + `_AssigneeCircle`). Circle tap = mark done
  (capture messenger/l10n before the await — StatelessWidget has no `mounted`);
  done rows absorb the circle tap. Never reintroduce horizontal column scrolling
  on narrow widths — that was the UX complaint that triggered the redesign.
- **Pin panel scrollbars flush to the right edge.** A panel's scrolling `ListView` carries no
  right padding; wrap it in `Scrollbar(controller, thumbVisibility: true)` and push the horizontal
  inset INTO each child instead, so the scrollbar gutter sits at the outermost right
  (`_ReportsPanel` / `_DigestPanel` in `daily_view_page.dart`).
- **A vertical `SingleChildScrollView` wrapping shrink-wrapping content needs an explicit width.**
  `MarkdownView` (→ `MarkdownBody`) sizes to its content width, not the parent's. In a `Column`
  with `crossAxisAlignment: CrossAxisAlignment.start` the scroll view gets *loose* width
  constraints and collapses to the child's intrinsic width, so its desktop scrollbar floats in the
  middle of the card where the longest line ends — not at the card's right edge. Force the viewport
  to fill the card: `SingleChildScrollView(child: SizedBox(width: double.infinity, child: ...))`
  (the digest card body in `daily_view_page.dart`).

---

## Resolving a userId → profile (name / avatar / githubLogin)

`Member` (`repos/{repoId}/members/{uid}`) only carries `userId` + role + workload counts; the
human profile (`name`, `avatarUrl`, `githubLogin`) lives in `users/{uid}`. To show a member's
name/avatar (assignee row, picker), resolve the profile in a **ViewModel**, never by importing
`UserRepository` into the View. `MembersViewModel` caches profiles (`profileFor(uid)` /
`labelFor(uid)`), resolving each uid once via `UserRepository.getUser` and notifying as lookups
land — mirrors `StatsViewModel`'s name-resolution cache. Reuse it; don't re-resolve in the widget.

## Push notifications (FCM) + in-app banners

- **Only initialize FCM in live mode.** `FirebaseMessaging` needs an initialized Firebase app,
  which fake-backend mode skips. Guard the `PushMessagingService.initialize(uid)` call with
  `!AppConfig.useFakeBackend` (it's wired in the sign-in success path). `initialize` is idempotent.
- **Deep-link taps via the FCM `data` payload, not the notification body.** The backend
  (`tools/notify.ts notifyAssignee(..., data)`) sends `{ type, repoId, taskId }`; the client reads
  `m.data['repoId'|'taskId']` in `onMessageOpenedApp` + `getInitialMessage` (cold start) and routes
  via `NavigationService.goTaskDetails`, falling back to `goNotify()`.
- **Foreground "assigned to me" UX = a Firestore listener, not FCM.** A `ChangeNotifier`/widget
  watches the repo's tasks for `assigneeId == currentUid`; this works in BOTH fake and live modes
  (FCM only covers background/closed). **Seed the baseline on the first non-loading snapshot**
  (`if (vm.loading) return;` then capture the current assigned-set once) so existing assignments
  aren't announced as new — only later transitions fire the banner. `RepoShell` does this and shows
  a SnackBar with a "View" action. Show it from a post-frame callback (the listener can fire
  mid-build).
- **User-triggered notification UI must surface the permission state.** When Android 13+'s
  `POST_NOTIFICATIONS` is denied, `flutter_local_notifications` `show()` silently no-ops — a
  "send test notification" button then looks broken with zero feedback (root cause of the
  "test button does nothing" report, task `06-03-wire-fcm-notifications`). From a **user
  gesture**, call `LocalNotificationsService.ensurePermission()` first (short-circuits if
  enabled, otherwise re-prompts once and re-checks `areNotificationsEnabled()`); on `false`,
  show a SnackBar hint (`l10n notificationsDisabledHint`) instead of failing silently.
  **Passive listeners stay silent by design** (the FCM `onMessage` foreground redraw must NOT
  re-prompt — never pop a permission dialog without a user gesture).

---

## Localization (i18n)

UI strings are localized (中文(繁體) / English), not hardcoded. Access them via
`context.l10n.<key>` (extension in `lib/l10n/app_strings.dart`); add a getter to
`AppStrings` with both languages (`_(en, zh)`) rather than putting literals in
widgets. The active language comes from `LocaleNotifier` (a root-level
`ChangeNotifier`, persisted via `shared_preferences`, like `ThemeModeNotifier`);
the Settings page switches it. `context.l10n` **falls back to the default locale
when no `LocaleNotifier` is in the tree** (try/catch) so widget tests pumping a
page in isolation still build. In async callbacks, capture `final s = context.l10n;`
*before* the first `await` (don't touch context after await). `MaterialApp` wires
`locale` + `supportedLocales` + the Global*Localizations delegates so built-in
widgets localize too. Proper nouns / IDs (e.g. "GitHub", "Issue #N") stay as-is.
`LocaleNotifier` also **mirrors the choice to the backend** (`users/{uid}.locale`
via `UserRepository.updateLocale`) once a user is attached (`attachUser` on
sign-in, `detachUser` on sign-out) so server-sent FCM push copy is localized per
recipient — see `database-guidelines.md` "Localizing outbound push".

---

## Scope discipline (`AI_AGENT_RULES.md §3.2`)

Implement only what was asked. Don't add confirmation dialogs, undo snackbars, analytics, extra
comments, or refactors that weren't requested. If you think one is warranted, ask in the final
message — don't add it silently.

---

## Common mistakes

- Importing a Repository directly into a View.
- Using `context` after `await` without `if (mounted)`.
- Hardcoding `Color(0xFF...)` instead of `colorScheme`.
- Forgetting to add a new repository method to the Fake implementation (breaks `BACKEND=fake`).
- A vertical `SingleChildScrollView` around shrink-wrapping content (e.g. `MarkdownView`) without
  `SizedBox(width: double.infinity, ...)` — the scrollbar floats mid-card instead of at the edge.
