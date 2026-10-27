import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  Dispatch,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  SetStateAction,
  TouchEvent,
} from 'react';
import { useDropzone } from 'react-dropzone';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';
import { PROVIDER_PERMISSION_PREFERENCE_KEYS } from '@/shared/constants';
import { readUserPreference } from '@/shared/userSettings';
import type { BackgroundSendChoice, BackgroundSendPrompt, CommandModalPayload, CostCommandData, HelpCommandData, MarkSessionProcessing, ModelCommandData, QueuedDraft, SessionActivityMap, StatusCommandData,QueuedSendOptions,ChatAttachment,ChatMessage,PendingPermissionRequest,PermissionMode,SessionEstablishedContext,Project,ProjectSession,LLMProvider,SlashCommand } from '@/shared/types';
import { grantClaudeToolPermission } from '@/modules/chat/utils/chatPermissions';
import {
  hydrateChatDrafts,
  readDraftText,
  readQueuedMessages,
  subscribeToChatDrafts,
  writeDraftText,
  writeQueuedMessages,
} from '@/shared/chatDrafts';
import { escapeRegExp } from '@/modules/chat/utils/chatFormatting';
import { describeBackgroundTask, ownBackgroundTasks } from '@/modules/chat/utils/backgroundTasks';
import { useFileMentions } from '@/modules/chat/hooks/useFileMentions';
import { useInputHistory } from '@/modules/chat/hooks/useInputHistory';
import { useSlashCommands } from '@/modules/chat/hooks/useSlashCommands';

type UseChatComposerStateArgs = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  permissionMode: PermissionMode | string;
  cyclePermissionMode: () => void;
  resolvePermissionModeForProvider: (provider: LLMProvider, requestedMode: PermissionMode | string) => PermissionMode;
  /**
   * Model every send and command carries: the open session's model when there
   * is one, otherwise the user's per-provider selection.
   */
  currentProviderModel: string;
  currentProviderEffort: string;
  isLoading: boolean;
  processingSessions?: SessionActivityMap;
  canAbortSession: boolean;
  tokenBudget: Record<string, unknown> | null;
  sendMessage: (message: unknown) => void;
  /**
   * CloudCLI live: acknowledged send for chat turns (see WebSocketContext).
   * Resolves false when the message could not be handed to the server; the
   * composer then gets the text and files back. Falls back to `sendMessage`.
   */
  sendChatMessage?: (message: Record<string, unknown>) => Promise<boolean>;
  sendByCtrlEnter?: boolean;
  onSessionProcessing?: MarkSessionProcessing;
  onSessionIdle?: (sessionId: string) => void;
  /**
   * Invoked with the freshly allocated session id when the user sends the
   * first message of a brand-new conversation. The backend allocates the id
   * via POST /api/providers/sessions BEFORE the websocket send, so the id is
   * stable for the conversation's whole lifetime — the consumer navigates to
   * /session/:id and records it as the current session.
   */
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  scrollToBottom: () => void;
  addMessage: (msg: ChatMessage) => void;
  setIsUserScrolledUp: (isScrolledUp: boolean) => void;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
};

type MentionableFile = {
  name: string;
  path: string;
};

type CommandExecutionResult = {
  type: 'builtin' | 'custom';
  action?: string;
  data?: any;
  content?: string;
  hasBashCommands?: boolean;
  hasFileIncludes?: boolean;
};





type SubmitOptions = {
  /**
   * Send the text as a chat message even when it starts with "/" (or is
   * "help"). Set only for the re-submit of a custom command's expanded body:
   * like the Claude Code CLI, that body is never read as a command again, so a
   * body that opens with its own or another command's name cannot loop or
   * run that command instead of being sent.
   */
  skipCommandInterception?: boolean;
  /**
   * CloudCLI live: Ctrl/Cmd+Enter. Skips the queue when the turn in progress
   * belongs to a daemon job (see submitMessage).
   */
  sendNow?: boolean;
};

const createFakeSubmitEvent = () => {
  return { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;
};

/**
 * A phone or tablet with no mouse or trackpad: its on-screen keyboard has no
 * Shift+Enter. A computer with a touchscreen still has a fine pointer, so it
 * keeps Enter to send.
 */
const isTouchKeyboard = () =>
  typeof window !== 'undefined' && !(window.matchMedia?.('(any-pointer: fine)').matches ?? true);

const MAX_ATTACHMENT_COUNT = 10;
// CloudCLI live: what the phone's file picker offers (see useDropzone below).
const TOUCH_PICKER_ACCEPT = {
  'image/*': [],
  'video/*': [],
  'application/pdf': [],
  'text/*': [],
  'application/json': [],
  'application/zip': [],
};
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
// CloudCLI live: phone screen recordings easily exceed 10MB.
const MAX_VIDEO_ATTACHMENT_SIZE = 200 * 1024 * 1024;
const isVideoFile = (file: File) => file.type.startsWith('video/') || /\.(mov|mp4|m4v|webm|mkv|avi)$/i.test(file.name);

const isImageAttachment = (attachment: ChatAttachment) => {
  if (attachment.mimeType?.startsWith('image/')) return true;
  return /\.(gif|jpe?g|png|svg|webp)$/i.test(attachment.path || attachment.name || '');
};

const uploadAttachmentFiles = async (files: File[]): Promise<unknown[]> => {
  if (files.length === 0) {
    return [];
  }

  const formData = new FormData();
  files.forEach((file) => {
    formData.append('files', file);
  });

  const response = await api.assets.uploadFiles(formData);

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || 'Failed to upload files');
  }

  const result = await response.json();
  if (!Array.isArray(result.attachments) || result.attachments.length !== files.length) {
    throw new Error('File upload returned an incomplete result');
  }
  // CloudCLI live: a video comes back with a contact sheet of its frames.
  return [...result.attachments, ...(Array.isArray(result.derived) ? result.derived : [])];
};


/**
 * CloudCLI live: a session's queue is a list, sent one message per turn in
 * order by the server dispatcher. Each message has an id, so edits made here
 * (delete, reorder, send now) match it even after the server took the first.
 * Older stored messages without one get an id from their position.
 */
const queueItemId = (id: unknown, index: number): string => (typeof id === 'string' && id ? id : `legacy-${index}`);
const newQueueItemId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const restoreQueuedDrafts = (sessionKey: string): QueuedDraft[] => (
  readQueuedMessages(sessionKey).map((saved, index) => ({
    id: queueItemId(saved.id, index),
    content: saved.content,
    attachments: [],
    uploadedAttachments: saved.attachments ?? saved.images,
    options: saved.options,
  }))
);

const toStoredQueuedMessage = (draft: QueuedDraft) => ({
  id: draft.id,
  content: draft.content,
  options: draft.options,
  attachments: draft.uploadedAttachments,
});

/**
 * Changes a session's stored queue from its latest server copy, so a message
 * the dispatcher already sent is never written back. Returns the new queue.
 */
async function updateStoredQueue(
  sessionKey: string,
  mutate: (queue: QueuedDraft[]) => QueuedDraft[],
): Promise<void> {
  await hydrateChatDrafts();
  const next = mutate(restoreQueuedDrafts(sessionKey));
  writeQueuedMessages(sessionKey, next.map(toStoredQueuedMessage));
}

const getNotificationSessionSummary = (
  selectedSession: ProjectSession | null,
  fallbackInput: string,
): string | null => {
  const sessionSummary = selectedSession?.summary || selectedSession?.name || selectedSession?.title;
  if (typeof sessionSummary === 'string' && sessionSummary.trim()) {
    const normalized = sessionSummary.replace(/\s+/g, ' ').trim();
    return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
  }

  const normalizedFallback = fallbackInput.replace(/\s+/g, ' ').trim();
  if (!normalizedFallback) {
    return null;
  }

  return normalizedFallback.length > 80 ? `${normalizedFallback.slice(0, 77)}...` : normalizedFallback;
};

/**
 * Enter that CONFIRMS an IME candidate must not also submit.
 *
 * `event.isComposing` alone is not enough: Safari fires `compositionend` BEFORE the confirming
 * Enter's `keydown`, so the flag is already `false` by the time the handler runs. Chrome and
 * Firefox fire it after, which is why the naive guard looks correct on those two and the bug
 * reads as Safari-only. A tight window after `compositionend` covers it — that sequence is
 * synchronous (microseconds), while a human pressing Enter a second time takes >= 100ms and
 * never lands inside it.
 */
const SAFARI_IME_RACE_WINDOW_MS = 30;

export function useChatComposerState({
  selectedProject,
  selectedSession,
  currentSessionId,
  provider,
  permissionMode,
  cyclePermissionMode,
  resolvePermissionModeForProvider,
  currentProviderModel,
  currentProviderEffort,
  isLoading,
  processingSessions,
  canAbortSession,
  tokenBudget,
  sendMessage,
  sendChatMessage,
  sendByCtrlEnter,
  onSessionProcessing,
  onSessionIdle,
  onSessionEstablished,
  onFileOpen,
  onShowSettings,
  scrollToBottom,
  addMessage,
  setIsUserScrolledUp,
  setPendingPermissionRequests,
}: UseChatComposerStateArgs) {
  const { t } = useTranslation('chat');
  // The composer text together with the chat scope it belongs to. They are one
  // state rather than a value plus a ref because they have to move in lockstep:
  // on a session switch there is one commit where the scope has already changed
  // while the text has not, and anything that persisted the text in that commit
  // would write the previous session's message into the new session's draft.
  // A ref cannot express this — React evaluates a state updater eagerly, so a
  // ref set inside one is already ahead by the time the effects run.
  //
  // Restored synchronously from the draft mirror so a reload shows what was
  // being typed on the first paint rather than after the drafts request lands.
  /**
   * The already-sent message the composer is currently replacing, or null.
   *
   * Holds the anchor rather than the message, because that is all the send
   * needs and it keeps a stale message object from being captured while the
   * transcript refreshes underneath the composer.
   */
  const [editingAnchorId, setEditingAnchorId] = useState<string | null>(null);

  const [inputState, setInputState] = useState<{ scope: string | null; value: string }>(() => {
    if (typeof window === 'undefined') {
      return { scope: null, value: '' };
    }
    const initialScope = selectedSession?.id || currentSessionId
      || (selectedProject ? `project:${selectedProject.projectId}` : null);
    return {
      scope: initialScope,
      value: initialScope ? readDraftText(initialScope) : '',
    };
  });
  const input = inputState.value;
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [fileErrors, setFileErrors] = useState<Map<string, string>>(new Map());
  const [isTextareaExpanded, setIsTextareaExpanded] = useState(false);
  const [commandModalPayload, setCommandModalPayload] = useState<CommandModalPayload | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputHighlightRef = useRef<HTMLDivElement>(null);
  const textareaLineHeightRef = useRef<number | null>(null);
  const lastAutosizedInputRef = useRef<string | null>(null);
  const handleSubmitRef = useRef<
    ((
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
      queuedSubmission?: QueuedDraft,
      submitOptions?: SubmitOptions,
    ) => Promise<void>) | null
  >(null);
  const inputValueRef = useRef(input);
  const selectedProjectId = selectedProject?.projectId;
  // Prefer the stable backend-allocated id (selectedSession.id) but fall back
  // to currentSessionId for a just-established session that hasn't been
  // handed back to the parent's `selectedSession` prop yet.
  const sessionKey = selectedSession?.id || currentSessionId || null;
  // The chat scope a draft belongs to: the open session, or the project for a
  // chat that has not been sent yet and so has no session id. Drafts used to be
  // keyed by project alone, so every session in a project shared one draft.
  const draftScope = sessionKey ?? (selectedProjectId ? `project:${selectedProjectId}` : null);
  const draftScopeRef = useRef(draftScope);
  draftScopeRef.current = draftScope;
  // Composition is tracked on `window` in the capture phase rather than on the textarea, so a
  // composition that starts in one field and ends after focus moves still closes cleanly.
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);

  useEffect(() => {
    const onStart = () => {
      isComposingRef.current = true;
    };
    const onEnd = () => {
      isComposingRef.current = false;
      lastCompositionEndAtRef.current = performance.now();
    };
    // `blur` does not bubble, but a capture-phase listener on `window` still sees it on the way
    // down — otherwise a composition abandoned by clicking away would stay open forever.
    const onBlur = () => {
      isComposingRef.current = false;
    };
    window.addEventListener('compositionstart', onStart, true);
    window.addEventListener('compositionend', onEnd, true);
    window.addEventListener('blur', onBlur, true);
    return () => {
      window.removeEventListener('compositionstart', onStart, true);
      window.removeEventListener('compositionend', onEnd, true);
      window.removeEventListener('blur', onBlur, true);
    };
  }, []);

  const setInput = useCallback<Dispatch<SetStateAction<string>>>((next) => {
    setInputState((previous) => ({
      scope: draftScopeRef.current,
      value: typeof next === 'function' ? next(previous.value) : next,
    }));
  }, []);
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;

  // Recall writes go through the same pair of stores a send reads: the state
  // (for the render) and inputValueRef (so an immediate Enter submits the
  // recalled text, not a stale value).
  const setInputFromHistory = useCallback((value: string) => {
    setInput(value);
    inputValueRef.current = value;
  }, [setInput]);
  const { recordSentMessage, handleHistoryKeyDown } = useInputHistory({
    setInput: setInputFromHistory,
    textareaRef,
    scope: draftScope,
  });

  const [queuedDrafts, setQueuedDrafts] = useState<QueuedDraft[]>(() => {
    if (typeof window === 'undefined' || !sessionKey) {
      return [];
    }
    return restoreQueuedDrafts(sessionKey);
  });
  // Which session the in-memory `queuedDrafts` belong to; a list shown after
  // an await is dropped if the reader moved to another session meanwhile.
  const queuedDraftSessionRef = useRef<string | null>(sessionKey);
  // Shows the stored queue for this session, keeping the browser files of
  // messages queued from this composer (they are only used to edit them).
  const showStoredQueue = useCallback((key: string, extraFiles?: [string, File[]]) => {
    if (sessionKeyRef.current !== key) {
      return;
    }
    queuedDraftSessionRef.current = key;
    setQueuedDrafts((previous) => {
      const files = new Map(previous.map((draft) => [draft.id, draft.attachments] as const));
      if (extraFiles) {
        files.set(extraFiles[0], extraFiles[1]);
      }
      return restoreQueuedDrafts(key).map((draft) => ({ ...draft, attachments: files.get(draft.id) ?? [] }));
    });
  }, []);

  const handleBuiltInCommand = useCallback(
    (result: CommandExecutionResult) => {
      const { action, data } = result;
      switch (action) {
        case 'help':
          setCommandModalPayload({
            kind: 'help',
            data: (data || {}) as HelpCommandData,
          });
          break;

        case 'models':
          setCommandModalPayload({
            kind: 'models',
            data: (data || {}) as ModelCommandData,
          });
          break;

        case 'cost': {
          setCommandModalPayload({
            kind: 'cost',
            data: (data || {}) as CostCommandData,
          });
          break;
        }

        case 'status': {
          setCommandModalPayload({
            kind: 'status',
            data: (data || {}) as StatusCommandData,
          });
          break;
        }

        case 'memory':
          if (data.error) {
            addMessage({
              type: 'assistant',
              content: `Warning: ${data.message}`,
              timestamp: Date.now(),
            });
          } else {
            addMessage({
              type: 'assistant',
              content: `${data.message}\n\nPath: \`${data.path}\``,
              timestamp: Date.now(),
            });
            if (data.exists && onFileOpen) {
              onFileOpen(data.path);
            }
          }
          break;

        case 'config':
          onShowSettings?.();
          break;

        default:
          console.warn('Unknown built-in command action:', action);
      }
    },
    [onFileOpen, onShowSettings, addMessage],
  );

  const closeCommandModal = useCallback(() => {
    setCommandModalPayload(null);
  }, []);

  const handleCustomCommand = useCallback(async (result: CommandExecutionResult) => {
    const { content, hasBashCommands } = result;

    if (hasBashCommands) {
      const confirmed = window.confirm(
        'This command contains bash commands that will be executed. Do you want to proceed?',
      );
      if (!confirmed) {
        addMessage({
          type: 'assistant',
          content: 'Command execution cancelled',
          timestamp: Date.now(),
        });
        return;
      }
    }

    const commandContent = content || '';
    setInput(commandContent);
    inputValueRef.current = commandContent;

    // Defer submit to next tick so the command text is reflected in UI before dispatching.
    // The expanded body is the message itself: it skips slash-command interception.
    setTimeout(() => {
      if (handleSubmitRef.current) {
        handleSubmitRef.current(createFakeSubmitEvent(), undefined, { skipCommandInterception: true });
      }
    }, 0);
  }, [addMessage]);

  const executeCommand = useCallback(
    async (command: SlashCommand, rawInput?: string, options?: { preserveInput?: boolean }) => {
      if (!command || !selectedProject) {
        return;
      }

      try {
        const effectiveInput = rawInput ?? input;
        // Everything typed after the command name is its argument text, line
        // breaks included (`[\s\S]`, unlike `.`), trimmed as the Claude Code CLI
        // does. `$ARGUMENTS` gets it verbatim; `$1`, `$2`, … get its tokens.
        // The name must open the input and end at whitespace or the end: a pick
        // from the slash menu passes the whole composer, where the name may
        // appear later or inside a longer word ("see /echo2 …" has no arguments).
        const commandMatch = effectiveInput
          .trimStart()
          .match(new RegExp(`^${escapeRegExp(command.name)}(?=\\s|$)([\\s\\S]*)`));
        const rawArgs = commandMatch ? commandMatch[1].trim() : '';
        const args = rawArgs ? rawArgs.split(/\s+/) : [];

        // The `/api/commands/execute` context sends `projectId` now instead of
        // a folder-derived project name; the path is still included verbatim.
        const context = {
          projectPath: selectedProject.fullPath || selectedProject.path,
          projectId: selectedProject.projectId,
          sessionId: currentSessionId || selectedSession?.id || null,
          provider,
          model: currentProviderModel,
          tokenUsage: tokenBudget,
        };

        const response = await api.commands.execute({
          commandName: command.name,
          commandPath: command.path,
          args,
          rawArgs,
          context,
        });

        if (!response.ok) {
          let errorMessage = `Failed to execute command (${response.status})`;
          try {
            const errorData = await response.json();
            errorMessage = errorData?.message || errorData?.error || errorMessage;
          } catch {
            // Ignore JSON parse failures and use fallback message.
          }
          throw new Error(errorMessage);
        }

        const result = (await response.json()) as CommandExecutionResult;
        if (result.type === 'builtin') {
          handleBuiltInCommand(result);
          if (!options?.preserveInput) {
            setInput('');
            inputValueRef.current = '';
          }
        } else if (result.type === 'custom') {
          await handleCustomCommand(result);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('Error executing command:', error);
        addMessage({
          type: 'assistant',
          content: `Error executing command: ${message}`,
          timestamp: Date.now(),
        });
      }
    },
    [
      currentProviderModel,
      currentSessionId,
      handleBuiltInCommand,
      handleCustomCommand,
      input,
      provider,
      selectedProject,
      selectedSession?.id,
      addMessage,
      tokenBudget,
    ],
  );

  const showCostModal = useCallback(() => {
    executeCommand(
      {
        name: '/cost',
        description: 'Display token usage information',
        namespace: 'builtin',
        metadata: { type: 'builtin' },
      } as SlashCommand,
      '/cost',
      { preserveInput: true },
    );
  }, [executeCommand]);

  const {
    slashCommands,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    handleCommandInputChange,
    handleCommandMenuKeyDown,
  } = useSlashCommands({
    selectedProject,
    provider,
    input,
    setInput,
    textareaRef,
    onExecuteCommand: executeCommand,
  });

  const {
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  } = useFileMentions({
    selectedProject,
    input,
    setInput,
    textareaRef,
  });

  const syncInputOverlayScroll = useCallback((target: HTMLTextAreaElement) => {
    if (!inputHighlightRef.current || !target) {
      return;
    }
    inputHighlightRef.current.scrollTop = target.scrollTop;
    inputHighlightRef.current.scrollLeft = target.scrollLeft;
  }, []);

  const resizeTextarea = useCallback((target: HTMLTextAreaElement) => {
    target.style.height = 'auto';
    // CloudCLI live: on iOS the CSS max-height (40vh) ignores the keyboard,
    // so with an attachment preview the composer outgrew the visible area and
    // its lower part (text, buttons) was clipped. Cap at a share of what is
    // actually visible; the textarea scrolls beyond that.
    const visibleHeight = window.visualViewport?.height ?? window.innerHeight;
    const maxHeight = Math.max(48, Math.round(visibleHeight * 0.25));
    const nextHeight = Math.min(maxHeight, Math.max(22, target.scrollHeight));
    target.style.height = `${nextHeight}px`;

    let lineHeight = textareaLineHeightRef.current;
    if (!lineHeight) {
      lineHeight = parseInt(window.getComputedStyle(target).lineHeight);
      textareaLineHeightRef.current = Number.isFinite(lineHeight) ? lineHeight : 24;
    }

    const expanded = nextHeight > (textareaLineHeightRef.current || 24) * 2;
    setIsTextareaExpanded((previous) => previous === expanded ? previous : expanded);
    lastAutosizedInputRef.current = target.value;
  }, []);

  const handleAttachmentFiles = useCallback((files: File[]) => {
    // Errors describe the latest pick only.
    setFileErrors(new Map());
    const validFiles = files.filter((file) => {
      try {
        if (!file || typeof file !== 'object') {
          console.warn('Invalid file object:', file);
          return false;
        }

        if (file.size > (isVideoFile(file) ? MAX_VIDEO_ATTACHMENT_SIZE : MAX_ATTACHMENT_SIZE)) {
          const fileName = file.name || 'Unknown file';
          setFileErrors((previous) => {
            const next = new Map(previous);
            next.set(fileName, 'File too large (max 10MB, videos 200MB)');
            return next;
          });
          return false;
        }

        return true;
      } catch (error) {
        console.error('Error validating file:', error, file);
        return false;
      }
    });

    if (validFiles.length > 0) {
      setAttachedFiles((previous) => [...previous, ...validFiles].slice(0, MAX_ATTACHMENT_COUNT));
    }
  }, []);

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(event.clipboardData.items);

      items.forEach((item) => {
        if (!item.type.startsWith('image/')) {
          return;
        }
        const file = item.getAsFile();
        if (file) {
          handleAttachmentFiles([file]);
        }
      });

      if (items.length === 0 && event.clipboardData.files.length > 0) {
        const files = Array.from(event.clipboardData.files);
        const imageFiles = files.filter((file) => file.type.startsWith('image/'));
        if (imageFiles.length > 0) {
          handleAttachmentFiles(imageFiles);
        }
      }
    },
    [handleAttachmentFiles],
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    // Sizes are checked in handleAttachmentFiles, which reports what it skips;
    // a dropzone maxSize would drop large files without a word.
    maxFiles: MAX_ATTACHMENT_COUNT,
    // CloudCLI live: on a phone the picker gets explicit types. Without
    // `accept`, iOS's photo library let several photos be picked but the
    // confirm button did nothing; with them it opens its native photo picker.
    accept: isTouchKeyboard() ? TOUCH_PICKER_ACCEPT : undefined,
    onDrop: handleAttachmentFiles,
    noClick: true,
    noKeyboard: true,
  });

  // Snapshot of everything `chat.send` needs beyond the text itself. Built at
  // send time for immediate sends and at queue time for queued ones, so a
  // queued message keeps the provider settings it was composed under even if
  // it is later dispatched outside this composer (app-level auto-send).
  const buildSendOptions = useCallback((currentInput: string): QueuedSendOptions => {
    const getToolsSettings = () => readUserPreference(
      PROVIDER_PERMISSION_PREFERENCE_KEYS[provider],
      {
        allowedTools: [],
        disallowedTools: [],
        skipPermissions: false,
      },
    );

    const toolsSettings = getToolsSettings();

    return {
      model: currentProviderModel,
      effort: currentProviderEffort,
      permissionMode: resolvePermissionModeForProvider(provider, permissionMode),
      toolsSettings,
      skipPermissions: toolsSettings?.skipPermissions || false,
      sessionSummary: getNotificationSessionSummary(selectedSession, currentInput),
    };
  }, [
    currentProviderEffort,
    currentProviderModel,
    permissionMode,
    provider,
    resolvePermissionModeForProvider,
    selectedSession,
  ]);

  // Read at send time through a ref: the map changes on every poll, and a
  // submit handler rebuilt that often would re-render the whole composer.
  const processingSessionsRef = useRef(processingSessions);
  useEffect(() => {
    processingSessionsRef.current = processingSessions;
  }, [processingSessions]);

  // Sending over background work asks first. The dialog is rendered by the
  // composer; the submit awaits the user's choice through this resolver.
  const [backgroundSendPrompt, setBackgroundSendPrompt] = useState<BackgroundSendPrompt | null>(null);
  const backgroundSendResolverRef = useRef<((choice: BackgroundSendChoice) => void) | null>(null);

  const askBeforeSendingOverBackgroundWork = useCallback(
    (work: string[]) => new Promise<BackgroundSendChoice>((resolve) => {
      // Only one prompt at a time: a stale one is answered "cancel".
      backgroundSendResolverRef.current?.('cancel');
      backgroundSendResolverRef.current = resolve;
      setBackgroundSendPrompt({ work });
    }),
    [],
  );

  const resolveBackgroundSendPrompt = useCallback((choice: BackgroundSendChoice) => {
    const resolve = backgroundSendResolverRef.current;
    backgroundSendResolverRef.current = null;
    setBackgroundSendPrompt(null);
    resolve?.(choice);
  }, []);

  // An unmounted composer cannot answer; let the pending submit finish.
  useEffect(() => () => {
    backgroundSendResolverRef.current?.('cancel');
    backgroundSendResolverRef.current = null;
  }, []);

  // Persist a message to send "when this finishes" and show it as the queued
  // card. Used while a turn is in flight and when the user chooses to queue
  // behind background work. Attachments must already be uploaded.
  const queueMessage = useCallback(
    async (draft: QueuedDraft, queuedSessionKey: string | null) => {
      // CloudCLI live: queued messages stay separate; this one goes to the
      // end of the session's queue (sent one per turn, in queue order).
      const durableDraft: QueuedDraft = { ...draft, id: draft.id ?? newQueueItemId() };
      if (queuedSessionKey) {
        await updateStoredQueue(queuedSessionKey, (queue) => [...queue, durableDraft]);
      }

      // Recorded under the session the message was queued FOR, and before
      // the session-switch return below — the queued text must be
      // recallable even when it dispatches without this composer.
      recordSentMessage(durableDraft.content, queuedSessionKey);

      // The server owns dispatch after persistence. If the user changed
      // sessions during upload, the durable record is already enough; do
      // not attach its UI card to the newly opened composer.
      if (queuedSessionKey && sessionKeyRef.current !== queuedSessionKey) {
        return;
      }

      if (queuedSessionKey) {
        showStoredQueue(queuedSessionKey, [durableDraft.id ?? '', durableDraft.attachments]);
      }
      setInput('');
      inputValueRef.current = '';
      setAttachedFiles([]);
      setFileErrors(new Map());
      resetCommandMenuState();
      setIsTextareaExpanded(false);
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
      if (draftScopeRef.current) {
        writeDraftText(draftScopeRef.current, '');
      }
    },
    [recordSentMessage, resetCommandMenuState, setInput, showStoredQueue],
  );

  // CloudCLI live: a queued draft that could not go out yet goes back to the
  // head of its session's queue, without uploading its files again.
  const requeueAtHead = useCallback(async (draft: QueuedDraft) => {
    if (!sessionKey) return;
    const back = { ...draft, id: draft.id ?? newQueueItemId() };
    await updateStoredQueue(sessionKey, (queue) => [back, ...queue.filter((item) => item.id !== back.id)]);
    showStoredQueue(sessionKey, [back.id, back.attachments]);
  }, [sessionKey, showStoredQueue]);

  const submitMessage = useCallback(
    async (
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
      queuedSubmission?: QueuedDraft,
      submitOptions?: SubmitOptions,
    ) => {
      event.preventDefault();
      const currentInput = queuedSubmission?.content ?? inputValueRef.current;
      const currentAttachments = queuedSubmission?.attachments ?? attachedFiles;
      const previouslyUploadedAttachments = queuedSubmission?.uploadedAttachments ?? [];
      if (
        (
          !currentInput.trim()
          && currentAttachments.length === 0
          && previouslyUploadedAttachments.length === 0
        )
        || !selectedProject
      ) {
        return;
      }

      // A turn is already in flight: stash this message instead of sending it.
      // Upload attached files now so the queued record contains durable image
      // descriptors that can be sent even if another session is open later.
      // CloudCLI live: Ctrl/Cmd+Enter skips the queue when the turn in progress
      // belongs to a daemon job: Claude Code takes the message right away and
      // queues it in the job itself. A run of this app still queues here.
      const runningSessionId = selectedSession?.id || currentSessionId || null;
      // A chat that runs as a daemon job takes it too when this app started the
      // turn: the server pastes it into the job, which queues it itself.
      const sendsNow = Boolean(submitOptions?.sendNow) && Boolean(
        selectedSession?.live?.jobId
        || (runningSessionId && processingSessionsRef.current?.get(runningSessionId)?.external),
      );
      if (isLoading && !sendsNow) {
        // A run can restart in the tiny gap between scheduling and flushing a
        // queued submission. Put the same durable draft back without uploading
        // its files again.
        if (queuedSubmission) {
          await requeueAtHead(queuedSubmission);
          return;
        }

        const queuedOptions = buildSendOptions(currentInput);
        const queuedSessionKey = sessionKey;
        let uploadedAttachments: unknown[] = [];
        try {
          uploadedAttachments = await uploadAttachmentFiles(currentAttachments);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('Queued file upload failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to upload files: ${message}`,
            timestamp: new Date(),
          });
          return;
        }

        await queueMessage({
          content: currentInput,
          attachments: currentAttachments,
          uploadedAttachments,
          options: queuedOptions,
        }, queuedSessionKey);
        return;
      }

      // Intercept slash commands only when "/" is the first input character.
      // Also accept exact "help" as a convenience alias for users who expect CLI-style help.
      const commandInput = currentInput.trimEnd();
      const isHelpAlias = commandInput.trim().toLowerCase() === 'help';
      if (!submitOptions?.skipCommandInterception && (commandInput.startsWith('/') || isHelpAlias)) {
        // The name ends at the first whitespace of any kind, so "/cmd" followed
        // by a line break still runs /cmd (the Claude Code CLI splits the same way).
        const firstWhitespace = commandInput.search(/\s/);
        const commandName = isHelpAlias
          ? '/help'
          : firstWhitespace > 0 ? commandInput.slice(0, firstWhitespace) : commandInput;
        const matchedCommand =
          slashCommands.find((cmd: SlashCommand) => cmd.name === commandName) ||
          (commandName === '/help'
            ? ({
                name: '/help',
                description: 'Show help documentation for Claude Code',
                namespace: 'builtin',
                metadata: { type: 'builtin' },
              } as SlashCommand)
            : undefined);
        if (matchedCommand && matchedCommand.type !== 'skill') {
          executeCommand(matchedCommand, isHelpAlias ? '/help' : commandInput);
          recordSentMessage(currentInput);
          setInput('');
          inputValueRef.current = '';
          setAttachedFiles([]);
          setFileErrors(new Map());
          resetCommandMenuState();
          setIsTextareaExpanded(false);
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
          }
          return;
        }
      }

      const messageContent = currentInput;

      let uploadedAttachments = previouslyUploadedAttachments;
      if (uploadedAttachments.length === 0 && currentAttachments.length > 0) {
        try {
          uploadedAttachments = await uploadAttachmentFiles(currentAttachments);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('File upload failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to upload files: ${message}`,
            timestamp: new Date(),
          });
          return;
        }
      }

      const resolvedProjectPath = selectedProject.fullPath || selectedProject.path || '';
      const sessionSummary = getNotificationSessionSummary(selectedSession, currentInput);

      // The conversation always has a stable backend-allocated session id
      // BEFORE the first websocket send: brand-new chats allocate one here
      // via the session gateway. There is no client-visible session-id
      // handoff later — this id stays valid for the conversation's lifetime.
      let targetSessionId = selectedSession?.id || currentSessionId || null;
      if (!targetSessionId) {
        let createdSessionName = sessionSummary;
        try {
          const response = await api.providers.createSession({
            provider,
            projectPath: resolvedProjectPath,
            initialMessage: messageContent,
          });
          if (!response.ok) {
            throw new Error(`Failed to create session (${response.status})`);
          }
          const body = await response.json();
          targetSessionId = body?.data?.sessionId || null;
          // A blank server name would leave the session unlabeled, so the local
          // summary stays the fallback unless a real name comes back.
          const returnedSessionName = typeof body?.data?.sessionName === 'string'
            ? body.data.sessionName.trim()
            : '';
          if (returnedSessionName) {
            createdSessionName = returnedSessionName;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('Session creation failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to start a new session: ${message}`,
            timestamp: new Date(),
          });
          return;
        }

        if (!targetSessionId) {
          addMessage({
            type: 'error',
            content: 'Failed to start a new session: no session id returned.',
            timestamp: new Date(),
          });
          return;
        }

        onSessionEstablished?.(targetSessionId, {
          provider,
          project: selectedProject,
          summary: createdSessionName,
        });
      }

      // A new turn replaces the CLI process a session's background work runs
      // under: the agents, workflows and commands it still has going are
      // stopped, or finish where nothing is listening. Sending is the user's
      // call, but not one to make for them — and queueing behind the work,
      // which the server holds until it finishes, is the safe alternative.
      const backgroundActivity = processingSessionsRef.current?.get(targetSessionId);
      if (backgroundActivity?.background) {
        const work = ownBackgroundTasks(backgroundActivity.tasks ?? [])
          .map((task) => describeBackgroundTask(task, t));
        const choice = await askBeforeSendingOverBackgroundWork(work);
        if (choice === 'cancel') {
          return;
        }
        if (choice === 'queue') {
          if (queuedSubmission) {
            await requeueAtHead(queuedSubmission);
            return;
          }
          // Attachments were uploaded above; queue the same descriptors.
          await queueMessage({
            content: currentInput,
            attachments: currentAttachments,
            uploadedAttachments,
            options: buildSendOptions(currentInput),
          }, targetSessionId);
          return;
        }
      }

      const attachmentRecords = uploadedAttachments as ChatAttachment[];
      const userMessage: ChatMessage = {
        type: 'user',
        content: currentInput,
        images: attachmentRecords.filter(isImageAttachment),
        files: attachmentRecords.filter((attachment) => !isImageAttachment(attachment)),
        timestamp: new Date(),
        // Tags this echo as the replacement, so the truncation the server
        // broadcasts a moment later cuts the turns being replaced without
        // taking the message the user just sent with them.
        ...(editingAnchorId ? { replacesAnchorId: editingAnchorId } : {}),
      };

      addMessage(userMessage);
      // Mark this request as processing in the per-session activity map (the
      // single source of truth the indicator derives from). The id is always
      // concrete at this point — no pending placeholder exists anymore.
      onSessionProcessing?.(targetSessionId, {
        statusText: null,
        canInterrupt: true,
      });

      setIsUserScrolledUp(false);
      setTimeout(() => scrollToBottom(), 100);

      // One message shape for every provider. The backend resolves the
      // provider, project path, and provider-native resume id from the
      // session row; `options` only carries composer-level preferences.
      const chatFrame = {
        // Replacing an already-sent message is its own frame: it changes the
        // shape of the conversation, so it gets validated separately and can
        // report why it was refused.
        type: editingAnchorId ? 'chat.edit-send' : 'chat.send',
        sessionId: targetSessionId,
        ...(editingAnchorId ? { anchorId: editingAnchorId } : {}),
        content: messageContent,
        options: {
          ...(queuedSubmission?.options ?? buildSendOptions(messageContent)),
          attachments: uploadedAttachments,
        },
      };
      if (sendChatMessage) {
        // CloudCLI live: the composer is cleared right away as before; if the
        // server never takes the message, text and files come back to it.
        const failedSessionId = targetSessionId;
        void sendChatMessage(chatFrame).then((sent) => {
          if (sent) {
            return;
          }
          onSessionIdle?.(failedSessionId);
          const typedSince = inputValueRef.current;
          const restored = typedSince.trim() ? `${currentInput}\n\n${typedSince}` : currentInput;
          setInput(restored);
          inputValueRef.current = restored;
          if (currentAttachments.length > 0) {
            setAttachedFiles((previous) => [...currentAttachments, ...previous]);
          }
          addMessage({
            type: 'error',
            content: t('composer.sendFailed', { defaultValue: 'Message not sent, try again' }),
            timestamp: new Date(),
          });
        });
      } else {
        sendMessage(chatFrame);
      }
      setEditingAnchorId(null);

      // Recorded under the (possibly just-allocated) session id, so the first
      // message of a new chat lands in the history of the session the user is
      // navigated to. Queued drafts were recorded when they were queued; the
      // consecutive-duplicate check keeps this second call a no-op.
      recordSentMessage(currentInput, targetSessionId);
      setInput('');
      inputValueRef.current = '';
      resetCommandMenuState();
      setAttachedFiles([]);
      setFileErrors(new Map());
      setIsTextareaExpanded(false);

      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }

      if (draftScopeRef.current) {
        writeDraftText(draftScopeRef.current, '');
      }
    },
    [
      selectedSession,
      askBeforeSendingOverBackgroundWork,
      attachedFiles,
      buildSendOptions,
      currentSessionId,
      editingAnchorId,
      executeCommand,
      isLoading,
      onSessionProcessing,
      onSessionEstablished,
      provider,
      queueMessage,
      recordSentMessage,
      resetCommandMenuState,
      scrollToBottom,
      selectedProject,
      sendMessage,
      sendChatMessage,
      onSessionIdle,
      sessionKey,
      addMessage,
      setIsUserScrolledUp,
      slashCommands,
      t,
    ],
  );

  // Chat scopes with a submit still awaiting its upload or, for a brand-new
  // chat, its session id. The composer does not change until that returns (the
  // text stays, send stays enabled), so on a slow server the user submits
  // again — and each extra submit of a new chat allocated its own session and
  // sent it the same first message.
  const submittingScopesRef = useRef(new Set<string>());

  const handleSubmit = useCallback(
    async (
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
      queuedSubmission?: QueuedDraft,
      submitOptions?: SubmitOptions,
    ) => {
      const scope = draftScopeRef.current ?? '';
      if (submittingScopesRef.current.has(scope)) {
        // Still cancel the event: an ignored form submit must not reload the page.
        event.preventDefault();
        return;
      }
      submittingScopesRef.current.add(scope);
      try {
        await submitMessage(event, queuedSubmission, submitOptions);
      } finally {
        submittingScopesRef.current.delete(scope);
      }
    },
    [submitMessage],
  );

  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  // The server dispatcher owns sending. While the queue is visible, it is
  // re-read every few seconds, so a message the server sent leaves the list.
  const hasQueuedDrafts = queuedDrafts.length > 0;
  useEffect(() => {
    if (!sessionKey || !hasQueuedDrafts) {
      return;
    }
    let cancelled = false;
    const reconcile = async () => {
      await hydrateChatDrafts();
      if (!cancelled) {
        showStoredQueue(sessionKey);
      }
    };
    const timer = setInterval(() => void reconcile(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [hasQueuedDrafts, sessionKey, showStoredQueue]);

  /** Takes one message out of the queue (on screen at once, then in storage). */
  const takeQueuedDraft = useCallback((id: string): QueuedDraft | null => {
    const key = sessionKeyRef.current;
    const draft = queuedDrafts.find((item) => item.id === id) ?? null;
    if (!key || !draft) {
      return null;
    }
    setQueuedDrafts((previous) => previous.filter((item) => item.id !== id));
    void updateStoredQueue(key, (queue) => queue.filter((item) => item.id !== id))
      .then(() => showStoredQueue(key));
    return draft;
  }, [queuedDrafts, showStoredQueue]);

  const editQueuedDraft = useCallback((id: string) => {
    const draft = takeQueuedDraft(id);
    if (!draft) {
      return;
    }
    setInput(draft.content);
    inputValueRef.current = draft.content;
    setAttachedFiles(draft.attachments);
    textareaRef.current?.focus();
  }, [takeQueuedDraft]);

  const deleteQueuedDraft = useCallback((id: string) => {
    takeQueuedDraft(id);
  }, [takeQueuedDraft]);

  // CloudCLI live: the touch counterpart of Ctrl/Cmd+Enter for a message that is
  // already queued. A daemon job takes it right away; a run of this app puts the
  // same draft back at the head of the queue.
  const sendQueuedDraftNow = useCallback((id: string) => {
    const draft = takeQueuedDraft(id);
    if (draft) {
      void handleSubmitRef.current?.(createFakeSubmitEvent(), draft, { sendNow: true });
    }
  }, [takeQueuedDraft]);

  /**
   * CloudCLI live: sends a voice message. The transcript is the message text
   * (what the agent reads); the recording goes along as an attachment, so the
   * chat can play it back. Takes the same path as a typed message, so it is
   * queued while a turn runs.
   */
  const sendVoiceMessage = useCallback((recording: File, transcript: string) => {
    void handleSubmitRef.current?.(createFakeSubmitEvent(), {
      content: transcript,
      attachments: [recording],
    });
  }, []);

  /** CloudCLI live: puts the queue in the order given by the dragged list. */
  const reorderQueuedDrafts = useCallback((orderedIds: string[]) => {
    const key = sessionKeyRef.current;
    if (!key) {
      return;
    }
    const rank = (id: string | undefined) => {
      const index = orderedIds.indexOf(id ?? '');
      return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    };
    const byOrder = (a: QueuedDraft, b: QueuedDraft) => rank(a.id) - rank(b.id);
    setQueuedDrafts((previous) => [...previous].sort(byOrder));
    void updateStoredQueue(key, (queue) => [...queue].sort(byOrder)).then(() => showStoredQueue(key));
  }, [showStoredQueue]);

  // A voice transcript either fills the input (to edit before sending) or, when the
  // user tapped "stop and send", is submitted straight away. Mirror the value into
  // inputValueRef synchronously so handleSubmit reads the new text, not the stale state.
  const handleVoiceTranscript = useCallback((text: string, send?: boolean) => {
    const base = inputValueRef.current.trim();
    const next = base ? `${base} ${text}` : text;
    setInput(next);
    inputValueRef.current = next;
    if (send) handleSubmitRef.current?.(createFakeSubmitEvent());
  }, [setInput]);

  useEffect(() => {
    inputValueRef.current = input;
  }, [input]);

  // Swap in the open scope's draft, and pick up one that arrives from another
  // device with the hydrated drafts.
  useEffect(() => {
    if (!draftScope) {
      return;
    }

    const restoreDraft = () => {
      const savedInput = readDraftText(draftScope);
      setInputState((previous) => {
        if (previous.scope === draftScope && previous.value === savedInput) {
          return previous;
        }
        inputValueRef.current = savedInput;
        return { scope: draftScope, value: savedInput };
      });
    };

    restoreDraft();
    return subscribeToChatDrafts(restoreDraft);
  }, [draftScope]);

  // Only persist text that was typed for the scope it is about to be written
  // to; see the inputState declaration for why the scope travels with the text.
  useEffect(() => {
    if (!draftScope || inputState.scope !== draftScope) {
      return;
    }
    writeDraftText(draftScope, inputState.value);
  }, [inputState, draftScope]);

  // Switching sessions swaps in that session's queued draft. Browser File
  // objects are local to the mounted composer, while their already-uploaded
  // descriptors restore from storage and remain sendable.
  useEffect(() => {
    queuedDraftSessionRef.current = sessionKey;
    if (!sessionKey) {
      setQueuedDrafts([]);
      return;
    }
    setQueuedDrafts(restoreQueuedDrafts(sessionKey));
  }, [sessionKey]);

  useEffect(() => {
    if (!textareaRef.current) {
      return;
    }
    if (lastAutosizedInputRef.current === input) {
      return;
    }
    // Re-run for restored drafts and programmatic input changes. User typing is
    // already resized in onInput, so this avoids doing the same forced layout twice.
    resizeTextarea(textareaRef.current);
  }, [input, resizeTextarea]);

  // CloudCLI live: the visible area shrinks when the keyboard opens and an
  // attachment preview takes room, so re-apply the height cap then too.
  useEffect(() => {
    const viewport = window.visualViewport;
    const refit = () => {
      if (textareaRef.current) resizeTextarea(textareaRef.current);
    };
    refit();
    viewport?.addEventListener('resize', refit);
    return () => viewport?.removeEventListener('resize', refit);
  }, [attachedFiles.length, resizeTextarea]);

  useEffect(() => {
    if (!textareaRef.current || input.trim()) {
      return;
    }
    textareaRef.current.style.height = 'auto';
    setIsTextareaExpanded(false);
  }, [input]);

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = event.target.value;
      const cursorPos = event.target.selectionStart;

      setInput(newValue);
      inputValueRef.current = newValue;
      setCursorPosition(cursorPos);

      if (!newValue.trim()) {
        event.target.style.height = 'auto';
        setIsTextareaExpanded(false);
        resetCommandMenuState();
        return;
      }

      handleCommandInputChange(newValue, cursorPos);
    },
    [handleCommandInputChange, resetCommandMenuState, setCursorPosition],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (handleCommandMenuKeyDown(event)) {
        return;
      }

      if (handleFileMentionsKeyDown(event)) {
        return;
      }

      if (handleHistoryKeyDown(event)) {
        return;
      }

      if (event.key === 'Tab' && !showFileDropdown && !showCommandMenu) {
        event.preventDefault();
        cyclePermissionMode();
        return;
      }

      if (event.key === 'Enter') {
        const endedJustNow =
          performance.now() - lastCompositionEndAtRef.current < SAFARI_IME_RACE_WINDOW_MS;
        if (event.nativeEvent.isComposing || isComposingRef.current || endedJustNow) {
          return;
        }

        if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
          event.preventDefault();
          // Ctrl/Cmd+Enter sends now, past the queue (see submitMessage).
          handleSubmit(event, undefined, { sendNow: true });
        } else if (
          !event.shiftKey && !event.ctrlKey && !event.metaKey && !sendByCtrlEnter
          // CloudCLI live: on a phone, Return adds a line and only the send
          // button sends. The preference lives on the server and is shared by
          // every device, so it cannot tell the phone from the computer.
          && !isTouchKeyboard()
        ) {
          event.preventDefault();
          handleSubmit(event);
        }
      }
    },
    [
      cyclePermissionMode,
      handleCommandMenuKeyDown,
      handleFileMentionsKeyDown,
      handleHistoryKeyDown,
      handleSubmit,
      sendByCtrlEnter,
      showCommandMenu,
      showFileDropdown,
    ],
  );

  const handleTextareaClick = useCallback(
    (event: MouseEvent<HTMLTextAreaElement>) => {
      setCursorPosition(event.currentTarget.selectionStart);
    },
    [setCursorPosition],
  );

  const handleTextareaInput = useCallback(
    (event: FormEvent<HTMLTextAreaElement>) => {
      const target = event.currentTarget;
      resizeTextarea(target);
      setCursorPosition(target.selectionStart);
      syncInputOverlayScroll(target);
    },
    [resizeTextarea, setCursorPosition, syncInputOverlayScroll],
  );

  const handleClearInput = useCallback(() => {
    setInput('');
    inputValueRef.current = '';
    resetCommandMenuState();
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.focus();
    }
    setIsTextareaExpanded(false);
  }, [resetCommandMenuState]);

  const handleAbortSession = useCallback(() => {
    if (!canAbortSession) {
      return;
    }

    const targetSessionId = selectedSession?.id || currentSessionId || null;
    if (!targetSessionId) {
      console.warn('Abort requested but no session ID is available.');
      return;
    }

    // The backend resolves the provider from the session row, so no provider
    // field is needed here.
    sendMessage({
      type: 'chat.abort',
      sessionId: targetSessionId,
    });
  }, [canAbortSession, currentSessionId, selectedSession?.id, sendMessage]);

  const handleGrantToolPermission = useCallback(
    (suggestion: { entry: string; toolName: string }) => {
      if (!suggestion || provider !== 'claude') {
        return { success: false };
      }
      return grantClaudeToolPermission(suggestion.entry);
    },
    [provider],
  );

  const handlePermissionDecision = useCallback(
    (
      requestIds: string | string[],
      decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
    ) => {
      const ids = Array.isArray(requestIds) ? requestIds : [requestIds];
      const validIds = ids.filter(Boolean);
      if (validIds.length === 0) {
        return;
      }

      validIds.forEach((requestId) => {
        sendMessage({
          type: 'chat.permission-response',
          requestId,
          allow: Boolean(decision?.allow),
          updatedInput: decision?.updatedInput,
          message: decision?.message,
          rememberEntry: decision?.rememberEntry,
        });
      });

      setPendingPermissionRequests((previous) =>
        previous.filter((request) => !validIds.includes(request.requestId)),
      );
    },
    [sendMessage, setPendingPermissionRequests],
  );

  const [isInputFocused, setIsInputFocused] = useState(false);

  const handleInputFocusChange = useCallback(
    (focused: boolean) => {
      setIsInputFocused(focused);
    },
    [],
  );

  /** Loads an already-sent message back into the composer to be replaced. */
  const beginEditMessage = useCallback((message: ChatMessage) => {
    if (!message.transcriptAnchorId) return;
    setEditingAnchorId(message.transcriptAnchorId);
    setInput(message.content || '');
    inputValueRef.current = message.content || '';
    textareaRef.current?.focus();
  }, [setInput]);

  const cancelEditMessage = useCallback(() => {
    setEditingAnchorId(null);
    setInput('');
    inputValueRef.current = '';
  }, [setInput]);

  return {
    input,
    setInput,
    editingAnchorId,
    beginEditMessage,
    cancelEditMessage,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles: filteredFiles as MentionableFile[],
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedFiles,
    setAttachedFiles,
    fileErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openAttachmentPicker: open,
    handleSubmit,
    backgroundSendPrompt,
    resolveBackgroundSendPrompt,
    queuedDrafts,
    editQueuedDraft,
    deleteQueuedDraft,
    sendQueuedDraftNow,
    sendVoiceMessage,
    reorderQueuedDrafts,
    handleVoiceTranscript,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    isInputFocused,
    commandModalPayload,
    closeCommandModal,
    showCostModal,
  };
}
