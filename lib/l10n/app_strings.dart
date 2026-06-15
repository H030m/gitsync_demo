import 'package:flutter/widgets.dart';
import 'package:provider/provider.dart';

import '../services/locale_notifier.dart';
import 'app_locale.dart';

/// `context.l10n.someKey` returns the string for the current UI language.
/// Falls back to the default language when no [LocaleNotifier] is in the tree
/// (e.g. widget tests that pump a page in isolation), so callers never crash.
extension AppLocalizationsX on BuildContext {
  AppStrings get l10n {
    try {
      return AppStrings(watch<LocaleNotifier>().locale);
    } catch (_) {
      return const AppStrings(AppLocale.zhHant);
    }
  }
}

/// Hand-written string table for the two supported languages. One getter per
/// user-facing string; `_(en, zh)` picks by the active locale. Kept in one file
/// so both translations sit side by side.
class AppStrings {
  const AppStrings(this.locale);
  final AppLocale locale;

  String _(String en, String zh) => locale == AppLocale.en ? en : zh;

  /// English language NAME for the active locale, sent to the backend AI flows
  /// on an explicit regenerate so the artifact comes back in the app language
  /// (W6). Not a user-facing string — a stable backend signal.
  String get backendLanguage => locale.backendLanguage;

  // ---- Common ----
  String get cancel => _('Cancel', '取消');
  String get delete => _('Delete', '刪除');
  String get add => _('Add', '新增');
  String get remove => _('Remove', '移除');
  String get done => _('Done', '完成');
  String get view => _('View', '查看');

  // ---- Status ----
  String get statusTodo => _('To do', '待辦');
  String get statusInProgress => _('In progress', '進行中');
  String get statusDone => _('Done', '完成');

  // ---- Sign in ----
  String get appTagline =>
      _("Your team's repos, tasks, and daily activity in one place.",
          '在一個地方掌握團隊的 repo、任務與每日動態。');
  String get signInWithGitHub => _('Sign in with GitHub', '使用 GitHub 登入');
  String get signingIn => _('Signing in…', '登入中…');

  // ---- Repo list ----
  String get yourRepos => _('Your repos', '你的 Repo');
  String get noReposTitle => _('No repos yet', '還沒有 Repo');
  String get noReposMsg => _('Tap + to connect your first GitHub repository.',
      '點 + 連結你的第一個 GitHub repo。');
  String get notSignedIn => _('Not signed in', '尚未登入');
  String get removeRepoTitle => _('Remove repo?', '移除 Repo?');
  String removeRepoBody(String name) => _(
      'Remove $name? This deletes the repo and all its tasks/data. This cannot be undone.',
      '確定移除 $name?這會刪除該 repo 及其所有任務/資料,且無法復原。');
  String get removeRepoFailed => _('Failed to remove repo', '移除 repo 失敗');

  // ---- Tasks board ----
  String get tasksTitle => _('Tasks', '任務');
  String get dangerZone => _('Danger zone', '危險操作');
  String get deleteAllTasks => _('Delete all tasks', '刪除所有任務');
  String get deleteAllTasksSubtitle =>
      _('Remove every task in this repo (e.g. to reset before a demo).',
          '移除這個 repo 的所有任務（例如 demo 前重置）。');
  String get deleteAllTasksConfirmTitle =>
      _('Delete all tasks?', '刪除所有任務？');
  String get deleteAllTasksConfirmBody => _(
      'This permanently removes every task in this repo. This cannot be undone.',
      '這會永久刪除這個 repo 的所有任務，且無法復原。');
  String deleteAllTasksDone(int n) =>
      _('Deleted $n task(s)', '已刪除 $n 個任務');
  String get deleteAllTasksFailed =>
      _('Failed to delete tasks', '刪除任務失敗');
  String get boardTab => _('Board', '看板');
  String get graphTab => _('Graph', '關聯圖');
  String get emptyBoardTitle =>
      _('No project structure yet', '您還未輸入專案架構');
  String get emptyBoardMsg =>
      _('Tap the + button to add tasks.', '請點擊右下角 + 號來新增任務');
  String updateStatusFailed(Object e) =>
      _('Failed to update status: $e', '更新狀態失敗:$e');
  String get changeStatusTitle => _('Change status', '變更狀態');

  // ---- Add task ----
  String get addTaskTitle => _('Add task', '新增任務');
  String get manual => _('Manual', '手動');
  String get aiBreakdown => _('AI breakdown', 'AI 拆解');
  String get aiBreakdownHint => _(
      'Paste a project spec and let AI split it into subtasks.',
      '貼上專案規格，讓 AI 自動拆成多個子任務。');
  String get taskTitleLabel => _('Task title', '任務標題');
  String get descriptionOptional => _('Description (optional)', '描述(選填)');
  String get assigneeOptional => _('Assignee (optional)', '負責人(選填)');
  String get addingTask => _('Adding…', '新增中…');
  String get projectSpec => _('Project spec', '專案規格');
  String get projectSpecHint => _(
      'Paste your SPEC.md (Markdown) here — the AI breaks it into a high-level TODO list.',
      '把你的 SPEC.md(Markdown)貼在這裡 —— AI 會拆成一份高層次的任務清單。');
  String get breakDownWithAI => _('Break down with AI', '用 AI 拆解');
  String get breakingDown => _('Breaking down…', '拆解中…');
  String generatedNSubtasks(int n) =>
      _('Generated $n subtasks', '產生了 $n 個子任務');
  String get reBreakdown => _('Re-breakdown', '重新拆解');
  String get taskAdded => _('Task added.', '已新增任務。');
  String taskAddedWithTitle(String title) =>
      _('Added: $title', '已新增：$title');
  String get couldNotAddTask =>
      _('Could not add the task. Please try again.', '無法新增任務，請檢查網路後重試。');
  String get couldNotBreakdown => _(
      'Could not break down the spec. Please try again.',
      '無法拆解規格，請再試一次。');
  String get openFullPage => _('Open full page', '開啟完整頁面');

  // ---- Task details ----
  String get taskDetailsTitle => _('Task details', '任務細節');
  String get deleteTaskTooltip => _('Delete task', '刪除任務');
  String get assignee => _('Assignee', '認領者');
  String get assign => _('Assign', '指派');
  String get change => _('Change', '變更');
  String get unassigned => _('Unassigned', '未指派');
  String get taskContent => _('Task content', '任務內容');
  String get descriptionSection => _('Description', '任務描述');
  String get implementationDetails => _('Implementation details', '實作細節');
  String get subtasks => _('Subtasks', '子任務');
  String get dependsOn => _('Depends on', '相依於');
  String get handoff => _('Handoff', '交接內容');
  String get generate => _('Generate', '產生');
  String get regenerate => _('Regenerate', '重新產生');
  String get noHandoffYet => _(
      'No handoff doc yet. It is generated automatically when this task\'s prerequisites are completed, or tap Generate.',
      '還沒有交接文件。會在前置任務完成時自動產生,或點「產生」。');
  String get assignToTitle => _('Assign to', '指派給');
  String get unassign => _('Unassign', '取消指派');
  String get importCollaborators =>
      _('Import collaborators from GitHub', '從 GitHub 匯入協作者');
  String get importCollaboratorsSub =>
      _('Adds teammates who already use GitSync', '加入已使用 GitSync 的隊友');
  String get noPrerequisites => _(
      'No prerequisites. Tap Add to choose a parent task.',
      '沒有前置任務。點「新增」選一個父任務。');
  String get addPrerequisite => _('Add a prerequisite', '新增前置任務');
  String get removePrerequisite => _('Remove prerequisite', '移除前置任務');
  String get noEligibleTasks => _('No eligible tasks to add.', '沒有可加入的任務。');
  String get deleteTaskQuestion => _('Delete task?', '刪除任務?');
  String deleteTaskBody(String title) => _(
      'Delete "$title"? Its prerequisites will be reconnected to the tasks that depend on it.',
      '確定刪除「$title」?它的前置任務會自動接到依賴它的任務上。');
  String get couldNotUpdateAssignee =>
      _('Could not update the assignee.', '無法更新負責人。');
  String get couldNotGenerateHandoff =>
      _('Could not generate the handoff doc.', '無法產生交接文件。');
  String get couldNotOpenLink => _('Could not open the link.', '無法開啟連結。');
  String get couldNotAddPrereq =>
      _('Could not add that prerequisite.', '無法新增該前置任務。');
  String get couldNotImport =>
      _('Could not import collaborators.', '無法匯入協作者。');
  String get importingCollaborators =>
      _('Importing GitHub collaborators…', '正在匯入 GitHub 協作者…');
  String importedSummary(int added, int already, int pending) => _(
      'Added $added member(s)${already > 0 ? ' · $already already in' : ''}${pending > 0 ? ' · $pending not signed in yet' : ''}. Reopen the picker to assign them.',
      '已加入 $added 位成員${already > 0 ? '・$already 位已在' : ''}${pending > 0 ? '・$pending 位尚未登入' : ''}。重新開啟選單即可指派。');

  // ---- Graph ----
  String get noTasksYet => _('No tasks yet', '還沒有任務');
  String get unlinked => _('Unlinked', '未連結');
  String get addTaskTooltip => _('Add task', '新增任務');
  String get openDetails => _('Open details', '開啟細節');
  String get linkFromHere => _('Link from here…', '從這裡連線…');
  String get dependencyAdded => _('Dependency added.', '已新增依賴。');
  String get cannotLink => _(
      "Can't link — it already exists or would create a cycle.",
      '無法連線 —— 已存在或會造成循環。');
  String linkTargetPrompt(String title) =>
      _('Tap the task that depends on "$title"', '點選依賴「$title」的任務');

  // ---- Notify ----
  String get notificationTitle => _('Notification', '通知');
  String get openedFromPush =>
      _('Opened from a push notification.', '從推播通知開啟。');
  String get backToRepos => _('Back to repos', '回到 Repo 列表');
  String newTaskAssigned(String title) =>
      _('New task assigned to you: $title', '有新任務指派給你:$title');

  // ---- Settings ----
  String get settingsTitle => _('Settings', '設定');
  String get appearance => _('Appearance', '外觀');
  String get language => _('Language', '語言');
  String get account => _('Account', '帳號');
  String get signOut => _('Sign out', '登出');
  String get notifications => _('Notifications', '通知');
  String get sendTestNotification =>
      _('Send test notification', '傳送測試通知');
  String get testNotificationTitle =>
      _('GitSync', 'GitSync');
  String get testNotificationBody => _(
        'This is a test notification 🎉',
        '這是一則測試通知 🎉',
      );
  String get notificationsDisabledHint => _(
        'Notifications are disabled. Enable them for GitSync in system '
        'settings to receive them.',
        '通知已停用。請到系統設定為 GitSync 開啟通知。',
      );
  String get notificationFailed => _(
        "Notification failed (try a full rebuild, not just hot restart)",
        '通知未送出(請完整重新編譯，非只 hot restart)',
      );
  String get themeSystem => _('System', '系統');
  String get themeLight => _('Light', '淺色');
  String get themeDark => _('Dark', '深色');
  String get backendFakeTitle =>
      _('Backend: FAKE (dummy data)', '後端:假資料(FAKE)');
  String get backendLiveTitle =>
      _('Backend: LIVE (Firebase)', '後端:正式(Firebase)');
  String get backendFakeBody => _(
      'No real Firebase / OpenAI / GitHub calls. Mutations live in memory and reset on restart. To switch: stop the app and re-run with `--dart-define=BACKEND=live`.',
      '不會呼叫真正的 Firebase / OpenAI / GitHub。所有變更只存在記憶體、重啟即重置。要切換:停止 app 並用 `--dart-define=BACKEND=live` 重跑。');
  String get backendLiveBody => _(
      'Hitting real Firebase project. Be careful with destructive actions.',
      '連到正式 Firebase 專案,執行破壞性操作請小心。');

  // ---- Daily ----
  String get dailyTitle => _('Daily', '每日彙整');
  String get dailyTabSummary => _('Summary', '摘要');
  String get dailyTabCommits => _('Commits', '提交紀錄');
  String get dailyTabDiscord => _('Discord', 'Discord');
  String get refreshCurrentRange => _('Refresh current range', '重新整理目前範圍');
  String get today => _('Today', '今天');
  String get resetRange => _('Reset range', '重設範圍');
  String get dailyReport => _('Daily report', '日報');
  String get noReportYet => _('No report yet', '尚未產生日報');
  String get generating => _('Generating…', '產生中…');
  String get regenerateReport => _('Regenerate', '重新產生');
  String get generateReport => _('Generate report', '產生日報');
  String get dayNoReportHint => _(
      'No report for this day yet. Tap "Generate report" to let the AI summarize the day\'s commits, tasks and chat.',
      '這天還沒有日報。點「產生日報」讓 AI 整理當天的 commits、任務與聊天。');
  String get highlights => _('Highlights', '重點');
  String get commitRollup => _('Commit rollup', '提交彙總');
  String get contributions => _('Contributions', '貢獻');
  String generatingDayProgress(int done, int total) =>
      _('Generating ($done/$total)', '產生中（$done/$total）');
  String get askAiAboutToday => _('Ask AI about today', '問 AI 今天的事');
  String get askAiAboutTodayHint => _('Ask AI about today…', '問 AI 今天的事…');
  String get briefHint => _(
      'e.g. "Which commits today are about OAuth?", "Did anyone mention a blocker?", "Who changed breakdownTask recently?"',
      'e.g. 「今天有哪些 commit 跟 OAuth 有關？」、「有沒有人提到 blocker？」、'
      '「breakdownTask 最近誰改的？」');
  String sourceCommits(int n) =>
      _('Source commits ($n)', '來源提交（$n）');
  String get newSession => _('New session', '開啟新 session');
  String get couldNotLoadCommits =>
      _('Could not load commits', '無法載入提交紀錄');
  String get retry => _('Retry', '重試');
  String get commitMap => _('Commit map', '提交地圖');
  String get branchGraph => _('Branch graph', '分支圖');
  String get listView => _('List', '列表');
  String get recent50 => _('Recent 50', '最近 50 筆');
  String get dateRangeLabel => _('Date range', '日期範圍');
  String get saving => _('Saving…', '儲存中…');
  String get noCommits => _('No commits', '沒有提交紀錄');
  String get noCommitsInPeriod => _(
      'No commits in this period. Pick another range or go back to the recent commits.',
      '這段期間沒有提交紀錄。請選擇其他範圍或回到最近的提交。');
  String get noMatchingCommits =>
      _('No matching commits', '沒有符合的提交紀錄');
  String get noCommitsMatchFilters =>
      _('No commits match the current filters.', '沒有符合目前篩選條件的提交紀錄。');
  String get clearFilters => _('Clear filters', '清除篩選');
  String get author => _('Author', '作者');
  String authorCount(int n) => _('Author ($n)', '作者（$n）');
  String get branch => _('Branch', '分支');
  String branchCount(int n) => _('Branch ($n)', '分支（$n）');
  String get searchMessageHint => _('Search message…', '搜尋訊息…');
  String get clear => _('Clear', '清除');
  String get nothingToFilterBy =>
      _('Nothing to filter by yet.', '目前沒有可篩選的項目。');
  String get couldNotLoadBranchGraph =>
      _('Could not load the branch graph', '無法載入分支圖');
  String get largeHistoryNotice => _(
      'Large history — showing the most recent branches/commits.',
      '歷史紀錄較多 — 僅顯示最近的分支/提交。');
  String get branchesInRow => _('Branches in this row', '這一列的分支');
  String get noBranchInfo => _('No branch info', '沒有分支資訊');
  String get aiWorkSummary => _('AI work summary', 'AI 工作摘要');
  String get couldNotGenerateSummary => _(
      'Could not generate the summary. Please try again.',
      '無法產生摘要，請再試一次。');
  String get updated => _('Updated ✓', '已更新 ✓');
  String get discordDigest => _('Discord digest', 'Discord 摘要');
  String discordDigestForDate(String date) =>
      _('Discord digest · $date', 'Discord 摘要 · $date');
  String digestSourceMessages(int n) =>
      _('Referenced messages ($n)', '參考訊息（$n）');
  String get noDigestInRange => _(
      'No digest in this range. Use "Refresh current range" above to pull messages.',
      '這個範圍還沒有摘要。用上方的「重新整理目前範圍」拉取訊息。');
  String get lockDigest => _('Lock digest', '鎖定摘要');
  String get unlockDigest => _('Unlock digest', '解鎖摘要');
  String get digestLockedHint => _(
      'Locked — unlock to let AI adjust this summary.',
      '已鎖定 — 解鎖後 AI 才能調整此摘要。');
  String get adjustSummaryHint => _(
      'Ask AI to adjust this summary…', '請 AI 調整此摘要…');
  String get adjustWithAi => _('Adjust with AI', '用 AI 調整');
  String get couldNotUpdateDigest => _(
      'Could not update the digest. Please try again.',
      '無法更新摘要，請再試一次。');
  String get askAiAboutChat => _('Ask AI about the chat', '問 AI 聊天內容');
  String get askAiAboutChatHint => _(
      'e.g. "Where did the OAuth progress discussion get to?" — the AI finds the relevant Discord messages.',
      '例如「OAuth 的進度討論到哪了？」— AI 會找出相關的 Discord 訊息。');
  String get askAiDiscordHint =>
      _('Ask AI about the Discord chat…', '問 AI 關於 Discord 的聊天…');
  String get unknownAuthor => _('Unknown', '未知');
  String relatedConversations(int n) =>
      _('Related conversations ($n)', '相關對話（$n）');
  String get thinking => _('Thinking…', '思考中…');

  String get askDiscordScope =>
      _('Based on Discord messages', '基於 Discord 訊息');

  // ---- Ask GitSync (global repo-wide chat) ----
  String get askRepoTitle => _('Ask GitSync', '問 GitSync');
  String get askRepoTooltip => _('Ask GitSync', '問 GitSync');
  String get askRepoHint =>
      _('Ask GitSync about this repo…', '問問 GitSync 關於這個 repo…');
  String get askRepoScope =>
      _('Based on commits, tasks, and team discussion',
        '基於 commit、任務與團隊討論');
  String get askRepoEmptyHint => _(
      'Ask anything about this repo — progress, people, code, commits, or team discussion.',
      '關於這個 repo 的任何事都可以問 —— 進度、成員、程式碼、commit，或團隊討論。');
  String get askRepoThinking => _('Thinking…', '思考中…');

  /// Localizes one agent tool-trace step. The backend writes fixed ENGLISH
  /// label constants (see functions/src/tools/agentTrace.ts); here we map each to
  /// a more descriptive, app-language line so the user sees concretely what the
  /// agent is doing (e.g. "查詢相關 Discord 訊息…") instead of a bare "思考中".
  /// Unknown labels are shown verbatim.
  String traceStep(String label) {
    switch (label) {
      // shared / askRepo + dailyBrief
      case 'Listing recent commits…':
        return _('Listing recent commits…', '列出近期 commit…');
      case 'Listing completed tasks…':
        return _('Listing completed tasks…', '列出已完成任務…');
      case 'Reading Discord digests…':
        return _('Reading Discord digests…', '讀取 Discord 摘要…');
      case 'Searching commit history…':
        return _('Searching commit history…', '搜尋 commit 歷史…');
      case 'Searching Discord…':
        return _('Searching related Discord messages…', '查詢相關 Discord 訊息…');
      case 'Reading .trellis planning docs…':
        return _('Reading .trellis planning docs…', '讀取 .trellis 規劃文件…');
      case 'Checking task dependents…':
        return _('Checking task dependents…', '檢查相依任務…');
      case 'Reading team roster…':
        return _('Reading the team roster…', '讀取團隊成員名單…');
      // generateHandoff
      case 'Listing related commits…':
        return _('Listing related commits…', '列出相關 commit…');
      case 'Reading a commit diff…':
        return _('Reading the commit diff…', '讀取 commit 變更內容…');
      case 'Drafting the handoff…':
        return _('Drafting the handoff…', '撰寫交接文件…');
      case 'Composing answer…':
        return _('Composing the answer…', '彙整回答…');
      // discordChat
      case 'Listing day summaries…':
        return _('Scanning daily summaries…', '掃描每日摘要…');
      case 'Reading a day digest…':
        return _("Reading a day's digest…", '讀取當日摘要…');
      // explainCommit
      case 'Listing nearby commits…':
        return _("Listing the author's nearby commits…", '查詢作者鄰近 commit…');
      case 'Writing the explanation…':
        return _('Writing the explanation…', '撰寫說明…');
      // editDiscordDigest
      case 'Revising the digest…':
        return _('Revising the digest…', '改寫摘要…');
    }
    // generateHandoff self-review carries a dynamic score, e.g.
    // "Reviewing draft (score 4/5)…" — match by prefix.
    if (label.startsWith('Reviewing draft')) {
      return _('Reviewing the draft…', '自我審查草稿…');
    }
    return label;
  }
  String get askRepoNewSession => _('New session', '開啟新 session');
  String askRepoCommitSources(int n) =>
      _('Source commits ($n)', '來源 commit（$n）');
  String askRepoDiscordSources(int n) =>
      _('Related conversations ($n)', '相關對話（$n）');

  // ---- Stats ----
  String get statsTitle => _('Stats', '統計');
  String get contributionTab => _('Contribution', '貢獻度');
  String get progressTab => _('Progress', '進度表');
  String get commitContributionCaption =>
      _('Contribution across all commits', '全部 commit 累計的貢獻度');
  String get taskContributionCaption =>
      _('Contribution across completed tasks', '已完成的任務累計的貢獻度');
  String get contributionBasisCommit => _('commit', 'commit');
  String get contributionBasisTask => _('Task', '任務');
  String get noCommitRecords => _('No commit records yet', '尚無 commit 紀錄');
  String get noDoneTasks => _('No completed tasks yet', '尚無已完成的任務');
  String get pieChart => _('Pie chart', '圓餅圖');
  String get statsDetails => _('Details', '詳細情形');
  String get aiSummaryGenerating =>
      _('Generating AI work summary…', 'AI 工作總結產生中…');
  String get summaryFailedRetry =>
      _('Generation failed, tap to retry', '產生失敗，點此重試');
  String get aiWorkSummaryTitle => _('AI work summary', 'AI 工作總結');
  String get authorContributionCaption => _(
      "Each author's commit share and AI work summary",
      '每位作者的 commit 佔比與 AI 工作統整');
}
