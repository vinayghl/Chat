import { io, type Socket } from 'socket.io-client';

let socketInstance: Socket | null = null;
let errorCount = 0;

/**
 * Resolves the multiplayer backend URL.
 * - When deployed as a single full-stack Node.js service (Render, Railway, Cloud Run, local dev),
 *   VITE_SERVER_URL is empty and it connects to window.location.origin.
 * - When the frontend is hosted statically (e.g. Netlify), set VITE_SERVER_URL to the
 *   deployed Node.js backend URL (e.g. https://duel-server.onrender.com).
 */
export function getServerUrl(): string {
  const configured = import.meta.env.VITE_SERVER_URL;
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return configured.trim().replace(/\/+$/, '');
  }
  if (typeof window !== 'undefined') {
    return window.location.origin;
  }
  return '';
}

export function getSocket(): Socket {
  if (!socketInstance) {
    const serverUrl = getServerUrl();
    const isCrossOrigin =
      typeof window !== 'undefined' &&
      serverUrl !== '' &&
      serverUrl !== window.location.origin;

    socketInstance = io(serverUrl || undefined, {
      path: '/socket.io/',
      autoConnect: true,
      transports: ['polling', 'websocket'],
      upgrade: true,
      withCredentials: !isCrossOrigin,
      timeout: 8000,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000,
    });

    // Cycle transport order if a proxy or multi-instance load balancer rejects one transport
    socketInstance.on('connect_error', () => {
      errorCount += 1;
      if (!socketInstance) return;
      if (errorCount % 3 === 1) {
        socketInstance.io.opts.transports = ['websocket'];
      } else if (errorCount % 3 === 2) {
        socketInstance.io.opts.transports = ['polling'];
      } else {
        socketInstance.io.opts.transports = ['polling', 'websocket'];
      }
    });

    socketInstance.on('connect', () => {
      errorCount = 0;
    });
  }
  return socketInstance;
}

export interface EphemeralSession {
  roomCode: string;
  playerId: string;
  reconnectSecret: string;
}

const SESSION_KEY = 'duel_ephemeral_session';

export function saveEphemeralSession(session: EphemeralSession): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Ignore storage restriction errors
  }
}

export function loadEphemeralSession(): EphemeralSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<EphemeralSession>;
    if (
      typeof parsed.roomCode === 'string' &&
      typeof parsed.playerId === 'string' &&
      typeof parsed.reconnectSecret === 'string'
    ) {
      return {
        roomCode: parsed.roomCode,
        playerId: parsed.playerId,
        reconnectSecret: parsed.reconnectSecret,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function clearEphemeralSession(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Ignore storage restriction errors
  }
}
