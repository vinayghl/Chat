import Peer, { type DataConnection } from 'peerjs';
import {
  AVATAR_OPTIONS,
  LADDERS,
  SNAKES,
  type ChatMessage,
  type MoveRecord,
  type PlayerSlot,
  type PlayerState,
  type PublicRoomState,
} from '../shared/gameConstants.ts';

export type AckFn = (response: Record<string, unknown>) => void;
export type EventListener = (...args: unknown[]) => void;

export interface RealtimeClient {
  readonly connected: boolean;
  readonly active: boolean;
  readonly mode: 'socket' | 'p2p';
  connect(): void;
  disconnect(): void;
  emit(event: string, ...args: unknown[]): void;
  on(event: string, listener: EventListener): void;
  off(event: string, listener: EventListener): void;
  once(event: string, listener: EventListener): void;
}

const PEER_PREFIX = 'duel-snl-v1-';
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 6;

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  {
    urls: [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun2.l.google.com:19302',
      'stun:stun3.l.google.com:19302',
    ],
  },
];

function randomInt(maxExclusive: number): number {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return arr[0] % maxExclusive;
}

function generateRoomCode(): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizeNickname(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, 18);
}

function sanitizeRoomCode(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LENGTH);
}

function sanitizeAvatarId(raw: unknown, fallbackSlot: PlayerSlot): string {
  if (typeof raw === 'string' && AVATAR_OPTIONS.some((a) => a.id === raw)) {
    return raw;
  }
  return AVATAR_OPTIONS[fallbackSlot === 1 ? 0 : 1].id;
}

interface WireMessage {
  kind: 'rpc' | 'ack' | 'broadcast' | 'signal';
  reqId?: string;
  event?: string;
  payload?: unknown;
  response?: Record<string, unknown>;
}

export class P2PRealtimeClient implements RealtimeClient {
  public readonly mode = 'p2p' as const;
  private _connected = true;
  private _active = true;

  private listeners = new Map<string, Set<EventListener>>();
  private peer: Peer | null = null;
  private role: 'none' | 'host' | 'guest' = 'none';

  // Host state
  private hostRoom: PublicRoomState | null = null;
  private hostPlayerId: string | null = null;
  private guestPlayerId: string | null = null;
  private guestSecret: string | null = null;
  private guestConn: DataConnection | null = null;
  private firstTurnSlot: PlayerSlot = 1;

  // Guest state
  private hostConn: DataConnection | null = null;
  private pendingAcks = new Map<string, AckFn>();

  public get connected(): boolean {
    return this._connected;
  }

  public get active(): boolean {
    return this._active;
  }

  public connect(): void {
    this._active = true;
    this._connected = true;
    this.dispatch('connect');
  }

  public disconnect(): void {
    this.teardownPeer();
    this._active = false;
    this._connected = false;
    this.dispatch('disconnect');
  }

  public on(event: string, listener: EventListener): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  public off(event: string, listener: EventListener): void {
    this.listeners.get(event)?.delete(listener);
  }

  public once(event: string, listener: EventListener): void {
    const wrapper: EventListener = (...args) => {
      this.off(event, wrapper);
      listener(...args);
    };
    this.on(event, wrapper);
  }

  private dispatch(event: string, ...args: unknown[]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of Array.from(set)) {
      fn(...args);
    }
  }

  private teardownPeer(): void {
    for (const ack of this.pendingAcks.values()) {
      ack({ ok: false, error: 'Connection closed.' });
    }
    this.pendingAcks.clear();

    if (this.guestConn) {
      try {
        this.guestConn.close();
      } catch {
        // Ignore
      }
      this.guestConn = null;
    }
    if (this.hostConn) {
      try {
        this.hostConn.close();
      } catch {
        // Ignore
      }
      this.hostConn = null;
    }
    if (this.peer) {
      try {
        this.peer.destroy();
      } catch {
        // Ignore
      }
      this.peer = null;
    }
    this.role = 'none';
    this.hostRoom = null;
    this.hostPlayerId = null;
    this.guestPlayerId = null;
    this.guestSecret = null;
    this.firstTurnSlot = 1;
  }

  public emit(event: string, ...args: unknown[]): void {
    let payload: Record<string, unknown> | undefined;
    let ack: AckFn | undefined;

    if (typeof args[0] === 'function') {
      ack = args[0] as AckFn;
    } else {
      payload = args[0] as Record<string, unknown> | undefined;
      if (typeof args[1] === 'function') {
        ack = args[1] as AckFn;
      }
    }

    if (event === 'room:create') {
      void this.handleCreateRoom(payload, ack);
      return;
    }
    if (event === 'room:join') {
      void this.handleJoinRoom(payload, ack);
      return;
    }
    if (event === 'room:reconnect') {
      void this.handleReconnect(payload, ack);
      return;
    }
    if (event === 'room:leave') {
      this.handleLeaveRoom(ack);
      return;
    }

    if (this.role === 'host') {
      if (event.startsWith('voice:')) {
        this.handleHostVoiceSignal(event, payload);
        return;
      }
      this.handleHostAction(this.hostPlayerId ?? '', event, payload, ack);
      return;
    }

    if (this.role === 'guest' && this.hostConn && this.hostConn.open) {
      if (event.startsWith('voice:')) {
        this.hostConn.send({ kind: 'signal', event, payload } satisfies WireMessage);
        return;
      }
      const reqId = generateId();
      if (ack) {
        this.pendingAcks.set(reqId, ack);
        window.setTimeout(() => {
          const pending = this.pendingAcks.get(reqId);
          if (pending) {
            this.pendingAcks.delete(reqId);
            pending({ ok: false, error: 'Host did not respond in time.' });
          }
        }, 7000);
      }
      this.hostConn.send({ kind: 'rpc', reqId, event, payload } satisfies WireMessage);
      return;
    }

    ack?.({ ok: false, error: 'Not connected to a room.' });
  }

  private async handleCreateRoom(
    payload: Record<string, unknown> | undefined,
    ack?: AckFn
  ): Promise<void> {
    const nickname = sanitizeNickname(payload?.nickname);
    if (!nickname) {
      ack?.({ ok: false, error: 'Please enter a nickname (1–18 characters).' });
      return;
    }

    this.teardownPeer();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const roomCode = generateRoomCode();
      const peerId = `${PEER_PREFIX}${roomCode}`;
      try {
        const peer = await this.openPeer(peerId);
        this.peer = peer;
        this.role = 'host';

        const now = Date.now();
        const playerId = generateId();
        const reconnectSecret = generateId();
        this.hostPlayerId = playerId;
        this.firstTurnSlot = 1;

        const hostPlayer: PlayerState = {
          playerId,
          slot: 1,
          nickname,
          avatarId: sanitizeAvatarId(payload?.avatarId, 1),
          position: 0,
          ready: false,
          connected: true,
          micEnabled: false,
          micMuted: false,
          lastSeenAt: now,
        };

        this.hostRoom = {
          roomCode,
          phase: 'lobby',
          players: [hostPlayer],
          currentTurnPlayerId: null,
          turnNumber: 0,
          winnerPlayerId: null,
          lastMove: null,
          history: [],
          chatMessages: [],
          nextRollAllowedAt: 0,
          createdAt: now,
        };

        this.attachHostPeerListeners(peer);

        ack?.({
          ok: true,
          roomCode,
          playerId,
          reconnectSecret,
          room: this.cloneRoom(this.hostRoom),
        });
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (msg.includes('unavailable-id') && attempt < 3) {
          continue;
        }
        this.teardownPeer();
        ack?.({
          ok: false,
          error:
            'Could not register room on peer signaling network. Please try again.',
        });
        return;
      }
    }
  }

  private openPeer(explicitId?: string): Promise<Peer> {
    return new Promise((resolve, reject) => {
      const options = {
        config: { iceServers: DEFAULT_ICE_SERVERS },
        debug: 0,
      };
      const peer = explicitId ? new Peer(explicitId, options) : new Peer(options);
      let settled = false;

      const timer = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            peer.destroy();
          } catch {
            // Ignore
          }
          reject(new Error('Peer signaling timed out.'));
        }
      }, 10000);

      peer.once('open', () => {
        if (!settled) {
          settled = true;
          window.clearTimeout(timer);
          resolve(peer);
        }
      });

      peer.once('error', (err) => {
        if (!settled) {
          settled = true;
          window.clearTimeout(timer);
          try {
            peer.destroy();
          } catch {
            // Ignore
          }
          reject(new Error(err?.type || err?.message || 'Peer error'));
        }
      });
    });
  }

  private attachHostPeerListeners(peer: Peer): void {
    peer.on('connection', (conn) => {
      conn.on('data', (raw) => {
        const msg = raw as WireMessage;
        if (!msg || typeof msg !== 'object') return;

        if (msg.kind === 'rpc' && msg.event) {
          const reply = (response: Record<string, unknown>) => {
            if (msg.reqId && conn.open) {
              conn.send({
                kind: 'ack',
                reqId: msg.reqId,
                response,
              } satisfies WireMessage);
            }
          };

          if (msg.event === 'room:join') {
            this.handleHostIncomingJoin(
              conn,
              msg.payload as Record<string, unknown> | undefined,
              reply
            );
            return;
          }

          if (msg.event === 'room:reconnect') {
            this.handleHostIncomingReconnect(
              conn,
              msg.payload as Record<string, unknown> | undefined,
              reply
            );
            return;
          }

          if (conn !== this.guestConn || !this.guestPlayerId) {
            reply({ ok: false, error: 'Unauthorized connection.' });
            return;
          }

          if (msg.event === 'room:leave') {
            this.handleHostGuestLeft();
            reply({ ok: true });
            return;
          }

          this.handleHostAction(
            this.guestPlayerId,
            msg.event,
            msg.payload as Record<string, unknown> | undefined,
            reply
          );
          return;
        }

        if (msg.kind === 'signal' && msg.event && conn === this.guestConn) {
          const p = (msg.payload as Record<string, unknown> | undefined) ?? {};
          if (msg.event === 'voice:state' && this.hostRoom && this.guestPlayerId) {
            const guest = this.hostRoom.players.find(
              (pl) => pl.playerId === this.guestPlayerId
            );
            if (guest) {
              if (typeof p.micEnabled === 'boolean') guest.micEnabled = p.micEnabled;
              if (typeof p.micMuted === 'boolean') guest.micMuted = p.micMuted;
              this.broadcastFromHost('room:updated', this.cloneRoom(this.hostRoom));
            }
            return;
          }
          if (msg.event === 'voice:ready') {
            this.dispatch('voice:peer-ready', { playerId: this.guestPlayerId });
            return;
          }
          this.dispatch(msg.event, {
            ...p,
            fromPlayerId: this.guestPlayerId,
            playerId: this.guestPlayerId,
          });
        }
      });

      conn.on('close', () => {
        if (conn === this.guestConn && this.hostRoom && this.guestPlayerId) {
          const guest = this.hostRoom.players.find(
            (pl) => pl.playerId === this.guestPlayerId
          );
          if (guest) {
            guest.connected = false;
            guest.lastSeenAt = Date.now();
            this.dispatch('room:updated', this.cloneRoom(this.hostRoom));
          }
        }
      });
    });
  }

  private handleHostIncomingJoin(
    conn: DataConnection,
    payload: Record<string, unknown> | undefined,
    reply: AckFn
  ): void {
    if (!this.hostRoom) {
      reply({ ok: false, error: 'Room not found.' });
      return;
    }
    const nickname = sanitizeNickname(payload?.nickname);
    if (!nickname) {
      reply({ ok: false, error: 'Please enter a nickname (1–18 characters).' });
      return;
    }
    if (this.hostRoom.players.length >= 2) {
      reply({ ok: false, error: 'This room is already full (2/2 players).' });
      return;
    }
    if (this.hostRoom.phase !== 'lobby') {
      reply({ ok: false, error: 'This match is already in progress.' });
      return;
    }

    let avatarId = sanitizeAvatarId(payload?.avatarId, 2);
    if (this.hostRoom.players[0]?.avatarId === avatarId) {
      const alt = AVATAR_OPTIONS.find((a) => a.id !== avatarId);
      if (alt) avatarId = alt.id;
    }

    const playerId = generateId();
    const reconnectSecret = generateId();
    const now = Date.now();

    const guestPlayer: PlayerState = {
      playerId,
      slot: 2,
      nickname,
      avatarId,
      position: 0,
      ready: false,
      connected: true,
      micEnabled: false,
      micMuted: false,
      lastSeenAt: now,
    };

    this.guestPlayerId = playerId;
    this.guestSecret = reconnectSecret;
    this.guestConn = conn;
    this.hostRoom.players = [...this.hostRoom.players, guestPlayer];

    const snapshot = this.cloneRoom(this.hostRoom);
    reply({
      ok: true,
      roomCode: this.hostRoom.roomCode,
      playerId,
      reconnectSecret,
      room: snapshot,
    });
    this.broadcastFromHost('room:updated', snapshot);
  }

  private handleHostIncomingReconnect(
    conn: DataConnection,
    payload: Record<string, unknown> | undefined,
    reply: AckFn
  ): void {
    if (
      !this.hostRoom ||
      !this.guestPlayerId ||
      payload?.playerId !== this.guestPlayerId ||
      payload?.reconnectSecret !== this.guestSecret
    ) {
      reply({ ok: false, error: 'Session verification failed.' });
      return;
    }

    const guest = this.hostRoom.players.find(
      (pl) => pl.playerId === this.guestPlayerId
    );
    if (!guest) {
      reply({ ok: false, error: 'Player session not found.' });
      return;
    }

    this.guestConn = conn;
    guest.connected = true;
    guest.lastSeenAt = Date.now();
    const snapshot = this.cloneRoom(this.hostRoom);
    reply({
      ok: true,
      roomCode: this.hostRoom.roomCode,
      playerId: this.guestPlayerId,
      room: snapshot,
    });
    this.broadcastFromHost('room:updated', snapshot);
    this.dispatch('voice:peer-ready', { playerId: this.guestPlayerId });
  }

  private handleHostGuestLeft(): void {
    if (!this.hostRoom || !this.guestPlayerId) return;
    const leaving = this.hostRoom.players.find(
      (p) => p.playerId === this.guestPlayerId
    );
    this.hostRoom.players = this.hostRoom.players.filter(
      (p) => p.playerId !== this.guestPlayerId
    );
    this.guestPlayerId = null;
    this.guestSecret = null;
    if (this.guestConn) {
      try {
        this.guestConn.close();
      } catch {
        // Ignore
      }
      this.guestConn = null;
    }
    this.hostRoom.phase = 'lobby';
    this.hostRoom.currentTurnPlayerId = null;
    this.hostRoom.winnerPlayerId = null;
    this.hostRoom.lastMove = null;
    this.hostRoom.history = [];
    this.hostRoom.turnNumber = 0;
    this.hostRoom.nextRollAllowedAt = 0;
    for (const p of this.hostRoom.players) {
      p.position = 0;
      p.ready = false;
    }
    this.dispatch('room:updated', this.cloneRoom(this.hostRoom));
    if (leaving) {
      this.dispatch('room:peer-left', { nickname: leaving.nickname });
    }
  }

  private handleHostVoiceSignal(
    event: string,
    payload: Record<string, unknown> | undefined
  ): void {
    if (!this.hostRoom || !this.hostPlayerId) return;
    if (event === 'voice:state' && payload) {
      const host = this.hostRoom.players.find(
        (p) => p.playerId === this.hostPlayerId
      );
      if (host) {
        if (typeof payload.micEnabled === 'boolean') {
          host.micEnabled = payload.micEnabled;
        }
        if (typeof payload.micMuted === 'boolean') {
          host.micMuted = payload.micMuted;
        }
        this.broadcastFromHost('room:updated', this.cloneRoom(this.hostRoom));
      }
      return;
    }

    if (this.guestConn && this.guestConn.open) {
      this.guestConn.send({
        kind: 'signal',
        event: event === 'voice:ready' ? 'voice:peer-ready' : event,
        payload: {
          ...(payload ?? {}),
          fromPlayerId: this.hostPlayerId,
          playerId: this.hostPlayerId,
        },
      } satisfies WireMessage);
    }
  }

  private handleHostAction(
    actorPlayerId: string,
    event: string,
    payload: Record<string, unknown> | undefined,
    ack?: AckFn
  ): void {
    if (!this.hostRoom) {
      ack?.({ ok: false, error: 'Not in a room.' });
      return;
    }
    const room = this.hostRoom;
    const actor = room.players.find((p) => p.playerId === actorPlayerId);
    if (!actor) {
      ack?.({ ok: false, error: 'Player not found.' });
      return;
    }

    if (event === 'room:toggle-ready') {
      if (room.phase !== 'lobby') {
        ack?.({ ok: false, error: 'Game has already started.' });
        return;
      }
      actor.ready = !actor.ready;
      this.broadcastFromHost('room:updated', this.cloneRoom(room));
      ack?.({ ok: true, ready: actor.ready });
      return;
    }

    if (event === 'game:start') {
      if (room.players.length !== 2) {
        ack?.({ ok: false, error: 'Two players are required to start a match.' });
        return;
      }
      if (!room.players.every((p) => p.ready)) {
        ack?.({ ok: false, error: 'Both players must be ready before starting.' });
        return;
      }
      if (!room.players.every((p) => p.connected)) {
        ack?.({ ok: false, error: 'Both players must be connected to start.' });
        return;
      }

      room.phase = 'playing';
      room.winnerPlayerId = null;
      room.lastMove = null;
      room.history = [];
      room.turnNumber = 1;
      room.nextRollAllowedAt = 0;
      for (const p of room.players) p.position = 0;
      const starter =
        room.players.find((p) => p.slot === this.firstTurnSlot) ?? room.players[0];
      room.currentTurnPlayerId = starter.playerId;

      this.broadcastFromHost('room:updated', this.cloneRoom(room));
      ack?.({ ok: true });
      return;
    }

    if (event === 'game:roll-dice') {
      if (room.phase !== 'playing') {
        ack?.({ ok: false, error: 'Game is not currently active.' });
        return;
      }
      if (room.currentTurnPlayerId !== actor.playerId) {
        ack?.({ ok: false, error: 'It is not your turn.' });
        return;
      }
      const now = Date.now();
      if (now < room.nextRollAllowedAt) {
        ack?.({ ok: false, error: 'Wait for the current move animation to finish.' });
        return;
      }

      const diceValue = randomInt(6) + 1;
      const fromPosition = actor.position;
      const candidate = fromPosition + diceValue;

      let landedPosition = fromPosition;
      let finalPosition = fromPosition;
      let steps: number[] = [];
      let overshot = false;
      let transition: MoveRecord['transition'] = null;
      let won = false;

      if (candidate > 100) {
        overshot = true;
      } else {
        landedPosition = candidate;
        for (let sq = fromPosition + 1; sq <= landedPosition; sq += 1) {
          steps.push(sq);
        }
        if (LADDERS[landedPosition] !== undefined) {
          finalPosition = LADDERS[landedPosition];
          transition = { type: 'ladder', from: landedPosition, to: finalPosition };
        } else if (SNAKES[landedPosition] !== undefined) {
          finalPosition = SNAKES[landedPosition];
          transition = { type: 'snake', from: landedPosition, to: finalPosition };
        } else {
          finalPosition = landedPosition;
        }
        actor.position = finalPosition;
        if (finalPosition === 100) {
          won = true;
          room.phase = 'finished';
          room.winnerPlayerId = actor.playerId;
          room.currentTurnPlayerId = null;
        }
      }

      const turnNumber = room.turnNumber;
      if (!won) {
        const other = room.players.find((p) => p.playerId !== actor.playerId);
        room.currentTurnPlayerId = other ? other.playerId : actor.playerId;
        room.turnNumber += 1;
      }

      const animMs =
        620 +
        steps.length * 190 +
        (transition ? 520 : 0) +
        (overshot ? 400 : 0);
      room.nextRollAllowedAt = now + animMs;

      const move: MoveRecord = {
        id: generateId(),
        turnNumber,
        playerId: actor.playerId,
        playerSlot: actor.slot,
        nickname: actor.nickname,
        diceValue,
        fromPosition,
        landedPosition,
        finalPosition,
        steps,
        transition,
        overshot,
        won,
        timestamp: now,
      };

      room.lastMove = move;
      room.history = [move, ...room.history].slice(0, 80);

      const snapshot = this.cloneRoom(room);
      this.broadcastFromHost('game:move', { move, room: snapshot });
      ack?.({ ok: true, move });
      return;
    }

    if (event === 'game:rematch') {
      if (room.players.length !== 2) {
        ack?.({ ok: false, error: 'Two players are required for a rematch.' });
        return;
      }
      this.firstTurnSlot = this.firstTurnSlot === 1 ? 2 : 1;
      room.phase = 'playing';
      room.winnerPlayerId = null;
      room.lastMove = null;
      room.history = [];
      room.turnNumber = 1;
      room.nextRollAllowedAt = 0;
      for (const p of room.players) {
        p.position = 0;
        p.ready = true;
      }
      const starter =
        room.players.find((p) => p.slot === this.firstTurnSlot) ?? room.players[0];
      room.currentTurnPlayerId = starter.playerId;

      this.broadcastFromHost('room:updated', this.cloneRoom(room));
      ack?.({ ok: true });
      return;
    }

    if (event === 'chat:send') {
      const rawText = typeof payload?.text === 'string' ? payload.text : '';
      const text = rawText.replace(/\s+/g, ' ').trim();
      if (text.length < 1 || text.length > 280) {
        ack?.({ ok: false, error: 'Message must be between 1 and 280 characters.' });
        return;
      }
      const message: ChatMessage = {
        id: generateId(),
        playerId: actor.playerId,
        playerSlot: actor.slot,
        nickname: actor.nickname,
        text,
        timestamp: Date.now(),
      };
      room.chatMessages = [...room.chatMessages, message].slice(-100);
      this.broadcastFromHost('chat:message', message);
      ack?.({ ok: true, message });
      return;
    }

    ack?.({ ok: false, error: 'Unknown action.' });
  }

  private broadcastFromHost(event: string, payload: unknown): void {
    this.dispatch(event, payload);
    if (this.guestConn && this.guestConn.open) {
      this.guestConn.send({
        kind: 'broadcast',
        event,
        payload,
      } satisfies WireMessage);
    }
  }

  private async handleJoinRoom(
    payload: Record<string, unknown> | undefined,
    ack?: AckFn
  ): Promise<void> {
    const roomCode = sanitizeRoomCode(payload?.roomCode);
    if (roomCode.length !== ROOM_CODE_LENGTH) {
      ack?.({ ok: false, error: 'Room code must be 6 characters.' });
      return;
    }
    const nickname = sanitizeNickname(payload?.nickname);
    if (!nickname) {
      ack?.({ ok: false, error: 'Please enter a nickname (1–18 characters).' });
      return;
    }

    await this.connectToHostAndRpc(
      roomCode,
      'room:join',
      { roomCode, nickname, avatarId: payload?.avatarId },
      ack
    );
  }

  private async handleReconnect(
    payload: Record<string, unknown> | undefined,
    ack?: AckFn
  ): Promise<void> {
    const roomCode = sanitizeRoomCode(payload?.roomCode);
    if (roomCode.length !== ROOM_CODE_LENGTH) {
      ack?.({ ok: false, error: 'Invalid room code.' });
      return;
    }
    await this.connectToHostAndRpc(
      roomCode,
      'room:reconnect',
      {
        roomCode,
        playerId: payload?.playerId,
        reconnectSecret: payload?.reconnectSecret,
      },
      ack
    );
  }

  private async connectToHostAndRpc(
    roomCode: string,
    rpcEvent: string,
    rpcPayload: Record<string, unknown>,
    ack?: AckFn
  ): Promise<void> {
    this.teardownPeer();

    try {
      const peer = await this.openPeer();
      this.peer = peer;
      this.role = 'guest';

      const conn = peer.connect(`${PEER_PREFIX}${roomCode}`, { reliable: true });
      this.hostConn = conn;

      await new Promise<void>((resolve, reject) => {
        let done = false;
        const timer = window.setTimeout(() => {
          if (!done) {
            done = true;
            reject(new Error('Room not found or host is unreachable.'));
          }
        }, 9000);

        conn.once('open', () => {
          if (!done) {
            done = true;
            window.clearTimeout(timer);
            resolve();
          }
        });

        peer.once('error', (err) => {
          if (!done) {
            done = true;
            window.clearTimeout(timer);
            if (err?.type === 'peer-unavailable') {
              reject(new Error('Room not found or host closed the room.'));
            } else {
              reject(new Error('Could not connect to room host.'));
            }
          }
        });
      });

      conn.on('data', (raw) => {
        const msg = raw as WireMessage;
        if (!msg || typeof msg !== 'object') return;

        if (msg.kind === 'ack' && msg.reqId) {
          const pending = this.pendingAcks.get(msg.reqId);
          if (pending) {
            this.pendingAcks.delete(msg.reqId);
            pending(msg.response ?? { ok: false, error: 'Empty response.' });
          }
          return;
        }

        if (msg.kind === 'broadcast' && msg.event) {
          this.dispatch(msg.event, msg.payload);
          return;
        }

        if (msg.kind === 'signal' && msg.event) {
          this.dispatch(msg.event, msg.payload);
        }
      });

      conn.on('close', () => {
        if (this.role === 'guest') {
          this.dispatch('room:peer-left', { nickname: 'Host' });
        }
      });

      const reqId = generateId();
      if (ack) {
        this.pendingAcks.set(reqId, (response) => {
          if (!response.ok) {
            this.teardownPeer();
          }
          ack(response);
        });
        window.setTimeout(() => {
          const pending = this.pendingAcks.get(reqId);
          if (pending) {
            this.pendingAcks.delete(reqId);
            this.teardownPeer();
            pending({ ok: false, error: 'Timed out joining room.' });
          }
        }, 7000);
      }

      conn.send({
        kind: 'rpc',
        reqId,
        event: rpcEvent,
        payload: rpcPayload,
      } satisfies WireMessage);
    } catch (err) {
      this.teardownPeer();
      ack?.({
        ok: false,
        error: err instanceof Error ? err.message : 'Unable to join room.',
      });
    }
  }

  private handleLeaveRoom(ack?: AckFn): void {
    if (this.role === 'guest' && this.hostConn && this.hostConn.open) {
      try {
        this.hostConn.send({
          kind: 'rpc',
          reqId: generateId(),
          event: 'room:leave',
        } satisfies WireMessage);
      } catch {
        // Ignore
      }
    }
    this.teardownPeer();
    ack?.({ ok: true });
  }

  private cloneRoom(room: PublicRoomState): PublicRoomState {
    return JSON.parse(JSON.stringify(room)) as PublicRoomState;
  }
}
