import { io, type Socket } from 'socket.io-client';
import {
  P2PRealtimeClient,
  type EventListener,
  type RealtimeClient,
} from './p2pTransport.ts';

export type { RealtimeClient } from './p2pTransport.ts';

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

class UnifiedRealtimeClient implements RealtimeClient {
  private socketClient: Socket | null = null;
  private p2pClient: P2PRealtimeClient | null = null;
  private _mode: 'socket' | 'p2p' = 'socket';
  private detected = false;
  private detectingPromise: Promise<'socket' | 'p2p'> | null = null;
  private listeners = new Map<string, Set<EventListener>>();

  constructor() {
    void this.detectAndInitialize();
  }

  public get mode(): 'socket' | 'p2p' {
    return this._mode;
  }

  public get connected(): boolean {
    if (!this.detected) return false;
    return this._mode === 'socket'
      ? Boolean(this.socketClient?.connected)
      : Boolean(this.p2pClient?.connected);
  }

  public get active(): boolean {
    if (!this.detected) return true;
    return this._mode === 'socket'
      ? Boolean(this.socketClient?.active)
      : Boolean(this.p2pClient?.active);
  }

  public async ensureReady(): Promise<'socket' | 'p2p'> {
    if (this.detected) return this._mode;
    return this.detectAndInitialize();
  }

  private detectAndInitialize(): Promise<'socket' | 'p2p'> {
    if (this.detectingPromise) return this.detectingPromise;

    this.detectingPromise = (async () => {
      const configuredUrl = import.meta.env.VITE_SERVER_URL;
      const hasExplicitServer =
        typeof configuredUrl === 'string' && configuredUrl.trim().length > 0;

      if (hasExplicitServer) {
        this.activateSocket(getServerUrl());
        return 'socket' as const;
      }

      // Probe same-origin /api/health to detect whether a Node.js backend is running
      // (full-stack Cloud Run/Render/local) or static-only hosting (Netlify/Vercel/GH Pages).
      let hasBackend = false;
      try {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 1600);
        const res = await fetch(`${getServerUrl()}/api/health`, {
          signal: controller.signal,
        });
        window.clearTimeout(timer);
        const ct = res.headers.get('content-type') ?? '';
        if (res.ok && ct.includes('application/json')) {
          const data = (await res.json()) as { ok?: boolean };
          hasBackend = Boolean(data?.ok);
        }
      } catch {
        hasBackend = false;
      }

      if (hasBackend) {
        this.activateSocket(getServerUrl());
        return 'socket' as const;
      }

      this.activateP2P();
      return 'p2p' as const;
    })();

    return this.detectingPromise;
  }

  private activateSocket(serverUrl: string): void {
    this._mode = 'socket';
    this.detected = true;

    const isCrossOrigin =
      typeof window !== 'undefined' &&
      serverUrl !== '' &&
      serverUrl !== window.location.origin;

    const sock = io(serverUrl || undefined, {
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

    let errorCount = 0;
    sock.on('connect_error', () => {
      errorCount += 1;
      if (errorCount % 3 === 1) {
        sock.io.opts.transports = ['websocket'];
      } else if (errorCount % 3 === 2) {
        sock.io.opts.transports = ['polling'];
      } else {
        sock.io.opts.transports = ['polling', 'websocket'];
      }
    });
    sock.on('connect', () => {
      errorCount = 0;
    });

    for (const [event, set] of this.listeners.entries()) {
      for (const fn of set) {
        sock.on(event, fn);
      }
    }

    this.socketClient = sock;
  }

  private activateP2P(): void {
    this._mode = 'p2p';
    this.detected = true;

    const p2p = new P2PRealtimeClient();
    for (const [event, set] of this.listeners.entries()) {
      for (const fn of set) {
        p2p.on(event, fn);
      }
    }
    this.p2pClient = p2p;
    p2p.connect();
    this.dispatchLocal('mode:changed', 'p2p');
  }

  private dispatchLocal(event: string, ...args: unknown[]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of Array.from(set)) {
      fn(...args);
    }
  }

  public connect(): void {
    if (!this.detected) {
      void this.detectAndInitialize();
      return;
    }
    if (this._mode === 'socket') {
      this.socketClient?.connect();
    } else {
      this.p2pClient?.connect();
    }
  }

  public disconnect(): void {
    if (this._mode === 'socket') {
      this.socketClient?.disconnect();
    } else {
      this.p2pClient?.disconnect();
    }
  }

  public emit(event: string, ...args: unknown[]): void {
    if (!this.detected) {
      void this.detectAndInitialize().then(() => {
        this.emit(event, ...args);
      });
      return;
    }
    if (this._mode === 'socket') {
      this.socketClient?.emit(event, ...args);
    } else {
      this.p2pClient?.emit(event, ...args);
    }
  }

  public on(event: string, listener: EventListener): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);

    if (this._mode === 'socket' && this.socketClient) {
      this.socketClient.on(event, listener);
    } else if (this._mode === 'p2p' && this.p2pClient) {
      this.p2pClient.on(event, listener);
    }
  }

  public off(event: string, listener: EventListener): void {
    this.listeners.get(event)?.delete(listener);
    if (this._mode === 'socket' && this.socketClient) {
      this.socketClient.off(event, listener);
    } else if (this._mode === 'p2p' && this.p2pClient) {
      this.p2pClient.off(event, listener);
    }
  }

  public once(event: string, listener: EventListener): void {
    const wrapper: EventListener = (...args) => {
      this.off(event, wrapper);
      listener(...args);
    };
    this.on(event, wrapper);
  }
}

let unifiedInstance: UnifiedRealtimeClient | null = null;

export function getSocket(): UnifiedRealtimeClient {
  if (!unifiedInstance) {
    unifiedInstance = new UnifiedRealtimeClient();
  }
  return unifiedInstance;
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
