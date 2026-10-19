// Live Claude Code sessions: which conversations a daemon job or a terminal
// owns, and how to deliver a turn into a job without splitting it.
export { hiddenPathPrefixes, isHiddenProjectPath, liveSessionsService } from './services/live-sessions.service.js';
export { resolveLiveRoute } from './services/live-routing.service.js';
export { deliverToJob, startJobFromAgentView } from './services/live-inject.service.js';
export {
  refreshAllClaudeSessionNames,
  renameClaudeSession,
  resolveClaudeSessionName,
  syncJobNamesToDb,
} from './services/claude-session-names.service.js';
export { archiveDeletedJobSessions, removeClaudeJobForSession } from './services/job-lifecycle.service.js';
export { prefetchSuggestions } from './services/prompt-suggestion.service.js';
export { isLiveForkInstall } from './services/fork-install.service.js';
export { startJobNotifications } from './services/job-notifications.service.js';
export { markSessionSeen } from './services/session-seen.service.js';
export { default as liveSessionsRoutes } from './live-sessions.routes.js';
export { loginRateLimit } from './login-rate-limit.middleware.js';
