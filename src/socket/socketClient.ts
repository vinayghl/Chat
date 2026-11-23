import { io, type Socket } from 'socket.io-client';

let socketInstance: Socket | null = null;

export function getSocket(): Socket {
  if (!socketInstance) {
    socketInstance = io({
      autoConnect: true,
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 800,
      reconnectionDelayMax: 4000,
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
