import { io, type Socket } from 'socket.io-client';

let socketInstance: Socket | null = null;
let errorCount = 0;

export function getSocket(): Socket {
  if (!socketInstance) {
    const serverUrl =
      typeof window !== 'undefined' ? window.location.origin : undefined;

    socketInstance = io(serverUrl, {
      path: '/socket.io/',
      autoConnect: true,
      transports: ['polling', 'websocket'],
      upgrade: true,
      withCredentials: true,
      timeout: 8000,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000,
    });

    // If initial polling+upgrade fails behind a proxy or multi-instance load balancer,
    // cycle transport order automatically so either WebSocket-only or polling-only succeeds.
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
