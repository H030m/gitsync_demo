// Cloud Functions entry point. Every exported symbol becomes a deployable
// function. Side-effect import of `./admin` initializes firebase-admin.
import './admin';

// ---- Callables ------------------------------------------------------------
export { addRepo } from './handlers/addRepo';
export { removeRepo } from './handlers/removeRepo';
export { breakdownTask } from './handlers/breakdownTask';
export { forceUnlockBreakdown } from './handlers/forceUnlockBreakdown';
export { deleteAllTasks } from './handlers/deleteAllTasks';
export { assignTask } from './handlers/assignTask';
export { generateHandoff } from './handlers/generateHandoff';
export { importCollaborators } from './handlers/importCollaborators';
export { summarizeDay } from './handlers/summarizeDay';
export { dailyBrief } from './handlers/dailyBrief';
export { explainCommit } from './handlers/explainCommit';
export { summarizeAuthorWork } from './handlers/summarizeAuthorWork';
export { getCommitGraph } from './handlers/getCommitGraph';
export { setDiscordWebhook } from './handlers/setDiscordWebhook';
export { subscribeToTopic } from './handlers/subscribeToTopic';
export { requestDiscordFetch } from './handlers/requestDiscordFetch';
export { setDiscordStartDate } from './handlers/setDiscordStartDate';
export { setDiscordRange } from './handlers/setDiscordRange';
export { discordChat } from './handlers/discordChat';
export { askRepo } from './handlers/askRepo';
export { editDiscordDigest } from './handlers/editDiscordDigest';
export { setDigestLock } from './handlers/setDigestLock';
export { backfillEmbeddings } from './handlers/backfillEmbeddings';

// ---- HTTP (webhooks + Cloud Tasks workers) -------------------------------
export { githubWebhook } from './handlers/githubWebhook';
export { discordMessageIngest } from './handlers/discordMessageIngest';
export { dailyReportWorker } from './handlers/dailyReportWorker';
export { claimDiscordFetch } from './handlers/claimDiscordFetch';
export { completeDiscordFetch } from './handlers/completeDiscordFetch';
export { setRepoChannel } from './handlers/setRepoChannel';
export { botEditDigest } from './handlers/botEditDigest';

// ---- Firestore triggers --------------------------------------------------
export { onTaskCreated } from './triggers/onTaskCreated';
export { onTaskUpdated } from './triggers/onTaskUpdated';
export { onTaskDeleted } from './triggers/onTaskDeleted';
export { onCommitCreated } from './triggers/onCommitCreated';
export { onCommitCompletesTask } from './triggers/onCommitCompletesTask';
export { onPRMerged } from './triggers/onPRMerged';
export { onPullRequestOpened } from './triggers/onPullRequestOpened';
export { onIssueWritten } from './triggers/onIssueWritten';
export { onDiscordMessageCreated } from './triggers/onDiscordMessageCreated';

// ---- Scheduled triggers --------------------------------------------------
export { scheduledDailyReport } from './triggers/scheduledDailyReport';
export { scheduledUnstickBreakdown } from './triggers/scheduledUnstickBreakdown';
