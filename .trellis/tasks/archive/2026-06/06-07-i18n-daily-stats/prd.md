# i18n: localize Daily + Stats screens into app_strings

Finishes the i18n follow-up: the two remaining analytics screens
(`daily_view_page.dart`, `stats_view_page.dart`) get fully localized, with all
their strings added to the single table `lib/l10n/app_strings.dart`.

## Outcome
* ALL user-facing UI strings now live in one file (`app_strings.dart`) with both
  languages side by side — translating = editing that one file (the user's ask).
* Daily: done (Daily section added). Stats: done (Stats section added).

## Acceptance Criteria
* [ ] Daily + Stats fully switch zh/en. analyze clean; daily + stats tests green
  (zh fallback values kept identical to any test-asserted strings).
