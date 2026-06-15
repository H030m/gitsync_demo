// Localized copy for outbound notifications (FCM push titles), keyed by the
// recipient's stored UI language. Mirrors the client string table
// (`lib/l10n/app_strings.dart`): each entry returns `en` or `zh` by locale.
//
// Only message *titles* live here — notification bodies are real data (e.g. the
// task title) and stay verbatim. The recipient's locale is read from their user
// doc (`apps/gitsync/users/{uid}.locale`), written by the client when it changes
// or on sign-in (see `services/locale_notifier.dart`).

/** The two languages GitSync supports, matching the client `AppLocale.prefValue`. */
export type NotifyLocale = 'en' | 'zhHant';

/**
 * Coerce a stored `locale` field into a known locale, defaulting to Traditional
 * Chinese (the app default) for missing/unknown values.
 */
export function notifyLocaleFromPref(value: unknown): NotifyLocale {
  return value === 'en' ? 'en' : 'zhHant';
}

const pick = (locale: NotifyLocale, en: string, zh: string): string =>
  locale === 'en' ? en : zh;

/** Localized notification titles. Add new push copy here, both languages. */
export const notifyMessages = {
  /** A prerequisite finished and this task is now unblocked for its assignee. */
  taskReadyTitle: (locale: NotifyLocale): string =>
    pick(locale, 'A new task is ready to start', '有新任務可以開始了'),
};
