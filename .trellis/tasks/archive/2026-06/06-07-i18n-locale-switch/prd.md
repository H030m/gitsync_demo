# i18n: switchable Traditional Chinese / English (Settings toggle)

## Goal
Let the user switch the whole UI between 中文(繁體) and English from Settings,
persisted across launches.

## Approach (custom lightweight i18n)
* `lib/l10n/app_locale.dart` — `AppLocale { en, zhHant }` (+ Locale, label, pref key).
* `lib/services/locale_notifier.dart` — `LocaleNotifier` (ChangeNotifier), persists
  the choice via `shared_preferences`; default zhHant. Provided in `main.dart`.
* `lib/l10n/app_strings.dart` — hand-written string table; `context.l10n.<key>`
  picks the active language. **Falls back to the default locale when no
  LocaleNotifier is in the tree** (try/catch) so widget tests that pump a page in
  isolation don't crash.
* `main.dart` — `MaterialApp.router` gets `locale`, `supportedLocales`, and the
  `GlobalMaterial/Widgets/Cupertino` delegates (built-in widgets localize too).
* Settings — a `中文／English` SegmentedButton (+ the page itself localized).

## Done (localized)
Settings, Sign-in, Repo list, Notify, Tasks board (AppBar/tabs/columns/empty/
snackbar), Add task, Task details (+ pickers/dialogs/snackbars), Graph
(legend/menu/dialogs/banner/statuses).

## Remaining (follow-up)
* `daily_view_page.dart` + `stats_view_page.dart` (analytics screens, many strings)
  still have Chinese — not yet keyed.
* Backend `notifyAssignee` push title is still Chinese; localizing it needs the
  recipient's locale stored server-side (out of scope here).

## Acceptance Criteria
* [x] Settings toggle switches the localized screens live + persists.
* [x] flutter analyze clean; tests green (empty-board copy test updated).
