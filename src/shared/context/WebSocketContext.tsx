import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '@/modules/auth';
import { IS_PLATFORM } from '@/shared/utils';
import { expireAuthSession, isAuthTokenExpired } from '@/shared/authToken';
import type { ServerEvent } from '@/shared/types';


type ServerEventListener = (event: ServerEvent) => void;

/**
 * Where the chat socket stands. `connecting` covers a handshake the provider
 * started on purpose (after sign-in, or with a refreshed token) and the time
 * signed out; `disconnected` a socket that closed on its own (it dropped, or an
 * attempt failed) until a reconnect opens again.
 */
type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  /**
   * Sends a chat turn (`chat.send` / `chat.edit-send`) so it is never lost in
   * silence: a closed or quiet socket is replaced first, the frame carries a
   * `clientMessageId`, and the server must answer `chat.ack`. Without an ack
   * it is sent once more over a fresh socket (the server drops duplicates).
   * Resolves false when the message could not be handed over.
   */
  sendChatMessage: (message: Record<string, unknown>) => Promise<boolean>;
  /**
   * Subscribes to every websocket frame. Returns an unsubscribe function.
   *
   * This is the primary consumption API: events are dispatched synchronously
   * to every listener, so rapid back-to-back frames cannot be coalesced or
   * dropped. Frames are deliberately not copied into React state; each
   * listener updates only the state owned by the feature that handles it.
   */
  subscribe: (listener: ServerEventListener) => () => void;
  isConnected: boolean;
  /**
   * Lets the UI tell a lost connection (`disconnected`, reconnecting every few
   * seconds) apart from the first handshake (`connecting`), so it can show the
   * former without flashing on every page load. A socket the provider replaces
   * on purpose, such as on a token refresh, reports `connecting` until the new
   * one opens, never `disconnected`.
   */
  connectionStatus: ConnectionStatus;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

const buildWebSocketUrl = (token: string | null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (IS_PLATFORM) return `${protocol}//${window.location.host}/ws`; // Platform mode: Use same domain as the page (goes through proxy)
  if (!token) return null;
  if (isAuthTokenExpired(token)) {
    expireAuthSession();
    return null;
  }
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`; // OSS mode: Use same host:port that served the page
};

/** A frame older than this means the socket may be half-dead (phone woke up). */
const CHAT_SEND_STALE_MS = 20_000;
/** How long a chat send waits for a socket to open. */
const CHAT_SEND_OPEN_TIMEOUT_MS = 10_000;
/** How long a chat send waits for the server's `chat.ack`. */
const CHAT_SEND_ACK_TIMEOUT_MS = 8_000;

const newClientMessageId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
};

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false); // Track if component is unmounted
  const hasConnectedRef = useRef(false); // Track if we've ever connected (to detect reconnects)
  /**
   * Listener registry for the subscribe API. A ref (not state) because the
   * set must be readable synchronously inside `onmessage` and never trigger
   * re-renders of the provider tree.
   */
  const listenersRef = useRef(new Set<ServerEventListener>());
  // Drives `isConnected` and the workspace header's "Reconnecting" indicator.
  // Three values rather than a boolean: a first handshake still in flight must
  // not read as a lost connection, or every page load would flash the indicator.
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // When the current socket last heard from the server (open or any frame).
  const lastFrameAtRef = useRef(0);
  // Chat sends waiting for their `chat.ack`, by client message id.
  const pendingAcksRef = useRef(new Map<string, () => void>());
  const { isLoading: isAuthLoading, token, user } = useAuth();

  const dispatch = useCallback((event: ServerEvent) => {
    for (const listener of listenersRef.current) {
      try {
        listener(event);
      } catch (error) {
        console.error('WebSocket listener error:', error);
      }
    }
  }, []);

  // Named function expression so the reconnect timer below can call itself
  // without reading the `connect` binding while it is still initializing.
  const connect = useCallback(function connect() {
    if (unmountedRef.current) return; // Prevent connection if unmounted
    if (!IS_PLATFORM && (isAuthLoading || !user)) return;
    try {
      // Construct WebSocket URL
      const wsUrl = buildWebSocketUrl(token);

      if (!wsUrl) return console.warn('No authentication token found for WebSocket connection');

      const websocket = new WebSocket(wsUrl);
      // Store connecting sockets too, so a token refresh can close them before
      // their handshake completes with stale credentials.
      wsRef.current = websocket;

      websocket.onopen = () => {
        lastFrameAtRef.current = Date.now();
        setConnectionStatus('connected');
        if (hasConnectedRef.current) {
          // This is a reconnect — signal so components can catch up on missed messages
          dispatch({ kind: 'websocket_reconnected', timestamp: Date.now() });
        }
        hasConnectedRef.current = true;
      };

      websocket.onmessage = (event) => {
        lastFrameAtRef.current = Date.now();
        try {
          const data = JSON.parse(event.data) as ServerEvent;
          const frame = data as { kind?: unknown; clientMessageId?: unknown };
          if (frame.kind === 'pong') return;
          if (frame.kind === 'chat.ack') {
            if (typeof frame.clientMessageId === 'string') {
              pendingAcksRef.current.get(frame.clientMessageId)?.();
            }
            return;
          }
          dispatch(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = () => {
        if (wsRef.current !== websocket) {
          return;
        }
        // Also reached when the very first attempt fails, which is a lost
        // connection too. The effect cleanup detaches this handler before
        // closing a socket on purpose, so a token refresh never gets here.
        setConnectionStatus('disconnected');
        wsRef.current = null;

        // Attempt to reconnect after 3 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          if (unmountedRef.current) return; // Prevent reconnection if unmounted
          connect();
        }, 3000);
      };

      websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

    } catch (error) {
      console.error('Error creating WebSocket connection:', error);
    }
  }, [dispatch, isAuthLoading, token, user]); // reconnect with current authentication state

  // Declared after `connect` so the effect body does not reference it before
  // initialization. `connect` is memoized on [dispatch, isAuthLoading, token,
  // user] and `dispatch` is stable, so depending on it reconnects on exactly
  // the same transitions as the previous [isAuthLoading, token, user] list.
  useEffect(() => {
    // The cleanup below sets unmountedRef = true. Without this reset, every
    // re-run of the effect (e.g. on token refresh) would short-circuit connect()
    // at its unmounted guard and leave the socket permanently disconnected.
    unmountedRef.current = false;
    if (!IS_PLATFORM && (isAuthLoading || !user)) {
      return undefined;
    }
    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      const activeSocket = wsRef.current;
      if (activeSocket) {
        // Prevent the intentionally closed, old-token socket from scheduling
        // a reconnect after the refreshed-token effect has already started.
        activeSocket.onopen = null;
        activeSocket.onmessage = null;
        activeSocket.onclose = null;
        activeSocket.onerror = null;
        activeSocket.close();
        wsRef.current = null;
      }
      // What comes next is a socket with a refreshed token, or none after a
      // sign-out or session expiry. Either way it starts from a fresh
      // handshake: the socket closed here is no longer live, and a drop seen
      // before must not show as "Reconnecting" after the next sign-in.
      setConnectionStatus('connecting');
    };
  }, [connect, isAuthLoading, user]); // reconnect after authentication or token refresh

  // Drops the current socket (live or not) and opens a new one.
  const replaceSocket = useCallback(() => {
    if (unmountedRef.current) return;
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    const stale = wsRef.current;
    if (stale) {
      stale.onopen = null;
      stale.onmessage = null;
      stale.onclose = null;
      stale.onerror = null;
      try {
        stale.close();
      } catch {
        // already gone
      }
      wsRef.current = null;
    }
    connect();
  }, [connect]);

  // CloudCLI live: iOS suspends a backgrounded app (above all an installed
  // one) and can hand back a socket that still reads as open but is dead: no
  // close event, so the reconnect above never runs and every update after it
  // is missed until a reload. Coming back after a while, or back online, the
  // socket is replaced; the reconnect event then has the chat and the sidebar
  // catch up on what they missed.
  useEffect(() => {
    if (!IS_PLATFORM && (isAuthLoading || !user)) {
      return undefined;
    }
    const RESUME_AFTER_HIDDEN_MS = 5_000;
    let hiddenAt = document.visibilityState === 'hidden' ? Date.now() : 0;

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
      }
      if (hiddenAt && Date.now() - hiddenAt >= RESUME_AFTER_HIDDEN_MS) {
        replaceSocket();
      }
      hiddenAt = 0;
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) replaceSocket();
    };

    // The same dead socket can happen with the app left open in the
    // foreground (network change, proxy idle timeout). A socket quiet for a
    // whole interval is asked for a pong; still silent one interval later, it
    // is replaced.
    const LIVENESS_INTERVAL_MS = 20_000;
    let pingSentAt = 0;
    const checkLiveness = () => {
      const socket = wsRef.current;
      if (document.visibilityState !== 'visible' || !socket || socket.readyState !== WebSocket.OPEN) {
        pingSentAt = 0;
        return;
      }
      if (pingSentAt && lastFrameAtRef.current < pingSentAt) {
        pingSentAt = 0;
        replaceSocket();
        return;
      }
      pingSentAt = 0;
      if (Date.now() - lastFrameAtRef.current >= LIVENESS_INTERVAL_MS) {
        pingSentAt = Date.now();
        try {
          socket.send(JSON.stringify({ type: 'ping' }));
        } catch {
          replaceSocket();
        }
      }
    };
    const livenessTimer = setInterval(checkLiveness, LIVENESS_INTERVAL_MS);

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('online', replaceSocket);
    return () => {
      clearInterval(livenessTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('online', replaceSocket);
    };
  }, [replaceSocket, isAuthLoading, user]);

  const sendMessage = useCallback((message: unknown) => {
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket not connected');
    }
  }, []);

  // Resolves with the open socket, or null after `timeoutMs`.
  const waitForOpenSocket = useCallback((timeoutMs: number) => new Promise<WebSocket | null>((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const socket = wsRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) {
        resolve(socket);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(null);
        return;
      }
      setTimeout(check, 100);
    };
    check();
  }), []);

  // A socket fit to carry a chat turn: open and heard from recently. A closed
  // one is reconnected now (not after the 3 s backoff), a quiet one replaced.
  const ensureLiveSocket = useCallback(async (): Promise<WebSocket | null> => {
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      if (Date.now() - lastFrameAtRef.current <= CHAT_SEND_STALE_MS) {
        return socket;
      }
      replaceSocket();
    } else if (!socket || socket.readyState !== WebSocket.CONNECTING) {
      replaceSocket();
    }
    return waitForOpenSocket(CHAT_SEND_OPEN_TIMEOUT_MS);
  }, [replaceSocket, waitForOpenSocket]);

  const sendChatMessage = useCallback(async (message: Record<string, unknown>): Promise<boolean> => {
    const clientMessageId = typeof message.clientMessageId === 'string'
      ? message.clientMessageId
      : newClientMessageId();
    const payload = JSON.stringify({ ...message, clientMessageId });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let socket: WebSocket | null;
      if (attempt === 0) {
        socket = await ensureLiveSocket();
      } else {
        // No ack over the first socket: it may be half-dead. Start over.
        replaceSocket();
        socket = await waitForOpenSocket(CHAT_SEND_OPEN_TIMEOUT_MS);
      }
      if (!socket) {
        continue;
      }

      const acked = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          pendingAcksRef.current.delete(clientMessageId);
          resolve(false);
        }, CHAT_SEND_ACK_TIMEOUT_MS);
        pendingAcksRef.current.set(clientMessageId, () => {
          clearTimeout(timer);
          pendingAcksRef.current.delete(clientMessageId);
          resolve(true);
        });
      });
      try {
        socket.send(payload);
      } catch (error) {
        console.warn('Chat send failed on this socket:', error);
      }
      if (await acked) {
        return true;
      }
      console.warn(`No ack for chat message ${clientMessageId} (attempt ${attempt + 1})`);
    }
    return false;
  }, [ensureLiveSocket, replaceSocket, waitForOpenSocket]);

  const subscribe = useCallback((listener: ServerEventListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    sendChatMessage,
    subscribe,
    isConnected: connectionStatus === 'connected',
    connectionStatus,
  }), [sendMessage, sendChatMessage, subscribe, connectionStatus]);

  return value;
};

/** Mounted once by App; owns the single chat websocket that the chat, project-workspace and task-master modules subscribe to. */
export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();

  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;
