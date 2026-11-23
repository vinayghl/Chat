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
import { MqttWssClient } from './mqttWssClient.ts';

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

const TOPIC_PREFIX = 'duel-snl/v1';
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 6;

const PUBLIC_WSS_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
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

interface WireEnvelope {
  kind: 'rpc' | 'ack' | 'broadcast' | 'signal';
  reqId?: string;
  fromClientId?: string;
  event?: string;
  payload?: unknown;
  response?: Record<string, unknown>;
}

export class P2PRealtimeClient implements RealtimeClient {
  public readonly mode = 'p2p' as const;
  private _connected = true;
  private _active = true;

  private listeners = new Map<string, Set<EventListener>>();
  private mqtt: MqttWssClient | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private role: 'none' | 'host' | 'guest' = 'none';
  private clientConnId: string = generateId();

  // Host state (strictly in-memory for the active session)
  private hostRoom: PublicRoomState | null = null;
  private hostPlayerId: string | null = null;
  private guestPlayerId: string | null = null;
  private guestSecret: string | null = null;
  private guestClientConnId: string | null = null;
  private firstTurnSlot: PlayerSlot = 1;

  // Guest state
  private activeRoomCode: string | null = null;
  private pendingAcks = new Map<string, AckFn>();

  private visibilityCleanup: (() => void) | null = null;

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
    this.teardownTransport();
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

  private attachBrowserResumeListeners(): void {
    this.detachBrowserResumeListeners();
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      return;
    }
    const onResume = () => {
      if (
        document.visibilityState === 'visible' &&
        this.role !== 'none' &&
        this.mqtt &&
        !this.mqtt.connected
      ) {
        void this.mqtt.reconnectNow();
      }
    };
    const onOnline = () => {
      if (this.role !== 'none' && this.mqtt && !this.mqtt.connected) {
        void this.mqtt.reconnectNow();
      }
    };
    const onPageHide = () => {
      if (this.role === 'host' && this.hostRoom && this.mqtt?.connected) {
        this.broadcastFromHost('room:host-left', {});
      }
    };

    document.addEventListener('visibilitychange', onResume);
    window.addEventListener('online', onOnline);
    window.addEventListener('pagehide', onPageHide);

    this.visibilityCleanup = () => {
      document.removeEventListener('visibilitychange', onResume);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('pagehide', onPageHide);
    };
  }

  private detachBrowserResumeListeners(): void {
    if (this.visibilityCleanup) {
      this.visibilityCleanup();
      this.visibilityCleanup = null;
    }
  }

  private teardownTransport(): void {
    this.detachBrowserResumeListeners();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    for (const ack of this.pendingAcks.values()) {
      ack({ ok: false, error: 'Connection closed.' });
    }
    this.pendingAcks.clear();

    if (this.mqtt) {
      this.mqtt.close();
      this.mqtt = null;
    }

    this.role = 'none';
    this.activeRoomCode = null;
    this.hostRoom = null;
    this.hostPlayerId = null;
    this.guestPlayerId = null;
    this.guestSecret = null;
    this.guestClientConnId = null;
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

    if (this.role === 'guest' && this.activeRoomCode && this.mqtt) {
      const toHostTopic = `${TOPIC_PREFIX}/${this.activeRoomCode}/to-host`;

      if (event.startsWith('voice:')) {
        this.sendToTopic(toHostTopic, {
          kind: 'signal',
          fromClientId: this.clientConnId,
          event,
          payload,
        });
        return;
      }

      const reqId = generateId();
      if (ack) {
        this.pendingAcks.set(reqId, ack);
        setTimeout(() => {
          const pending = this.pendingAcks.get(reqId);
          if (pending) {
            this.pendingAcks.delete(reqId);
            pending({ ok: false, error: 'Host did not respond in time.' });
          }
        }, 7000);
      }

      const sent = this.sendToTopic(toHostTopic, {
        kind: 'rpc',
        reqId,
        fromClientId: this.clientConnId,
        event,
        payload,
      });

      if (!sent && ack) {
        this.pendingAcks.delete(reqId);
        void this.mqtt.reconnectNow();
        ack({
          ok: false,
          error: 'Reconnecting to room channel. Please try again.',
        });
      }
      return;
    }

    ack?.({ ok: false, error: 'Not connected to a room.' });
  }

  private sendToTopic(topic: string, msg: WireEnvelope): boolean {
    if (!this.mqtt || !this.mqtt.connected) return false;
    return this.mqtt.publish(topic, JSON.stringify(msg));
  }

  private scheduleAutoReconnect(client: MqttWssClient): void {
    if (this.reconnectTimer !== null || this.mqtt !== client) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.mqtt === client && this.role !== 'none' && !client.connected) {
        void client.reconnectNow().then(() => {
          if (this.mqtt === client && !client.connected) {
            this.scheduleAutoReconnect(client);
          }
        });
      }
    }, 1200);
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

    this.teardownTransport();

    const roomCode = generateRoomCode();
    const toHostTopic = `${TOPIC_PREFIX}/${roomCode}/to-host`;

    for (const brokerUrl of PUBLIC_WSS_BROKERS) {
      const client = new MqttWssClient(
        brokerUrl,
        (topic, rawPayload) => {
          if (topic === toHostTopic) {
            this.onHostReceivedMessage(rawPayload);
          }
        },
        {
          onDisconnect: () => {
            if (this.mqtt === client && this.role === 'host') {
              this.scheduleAutoReconnect(client);
            }
          },
          onReconnect: () => {
            if (this.mqtt === client && this.role === 'host' && this.hostRoom) {
              this.broadcastFromHost('room:updated', this.cloneRoom(this.hostRoom));
            }
          },
        }
      );

      try {
        await client.connect(4500);
        await client.subscribe(toHostTopic, 3500);

        this.mqtt = client;
        this.role = 'host';
        this.activeRoomCode = roomCode;
        this.clientConnId = generateId();

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

        this.attachBrowserResumeListeners();

        ack?.({
          ok: true,
          roomCode,
          playerId,
          reconnectSecret,
          room: this.cloneRoom(this.hostRoom),
        });
        return;
      } catch {
        client.close();
      }
    }

    this.teardownTransport();
    ack?.({
      ok: false,
      error:
        'Could not connect to the public relay network. Check your internet connection and try again.',
    });
  }

  private onHostReceivedMessage(rawPayload: string): void {
    if (this.role !== 'host' || !this.hostRoom) return;
    let msg: WireEnvelope;
    try {
      msg = JSON.parse(rawPayload) as WireEnvelope;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    const fromClientId =
      typeof msg.fromClientId === 'string' ? msg.fromClientId : '';
    if (!fromClientId) return;

    if (msg.kind === 'rpc' && msg.event) {
      const replyTopic = `${TOPIC_PREFIX}/${this.hostRoom.roomCode}/to-guest/${fromClientId}`;
      const reply = (response: Record<string, unknown>) => {
        if (msg.reqId) {
          this.sendToTopic(replyTopic, {
            kind: 'ack',
            reqId: msg.reqId,
            response,
          });
        }
      };

      if (msg.event === 'room:join') {
        this.handleHostIncomingJoin(
          fromClientId,
          msg.payload as Record<string, unknown> | undefined,
          reply
        );
        return;
      }

      if (msg.event === 'room:reconnect') {
        this.handleHostIncomingReconnect(
          fromClientId,
          msg.payload as Record<string, unknown> | undefined,
          reply
        );
        return;
      }

      if (fromClientId !== this.guestClientConnId || !this.guestPlayerId) {
        reply({ ok: false, error: 'Unauthorized or expired player session.' });
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

    if (
      msg.kind === 'signal' &&
      msg.event &&
      fromClientId === this.guestClientConnId &&
      this.guestPlayerId
    ) {
      const p = (msg.payload as Record<string, unknown> | undefined) ?? {};
      if (msg.event === 'voice:state') {
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
  }

  private handleHostIncomingJoin(
    fromClientId: string,
    payload: Record<string, unknown> | undefined,
    reply: AckFn
  ): void {
    if (!this.hostRoom) {
      reply({ ok: false, error: 'Room not found.' });
      return;
    }

    // Idempotent retry from the exact same guest connection attempt
    if (
      fromClientId === this.guestClientConnId &&
      this.guestPlayerId &&
      this.guestSecret
    ) {
      const snapshot = this.cloneRoom(this.hostRoom);
      reply({
        ok: true,
        roomCode: this.hostRoom.roomCode,
        playerId: this.guestPlayerId,
        reconnectSecret: this.guestSecret,
        room: snapshot,
      });
      this.broadcastFromHost('room:updated', snapshot);
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
    this.guestClientConnId = fromClientId;
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
    fromClientId: string,
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

    this.guestClientConnId = fromClientId;
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
    this.guestClientConnId = null;

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

    if (this.guestClientConnId) {
      this.sendToTopic(`${TOPIC_PREFIX}/${this.hostRoom.roomCode}/broadcast`, {
        kind: 'signal',
        event: event === 'voice:ready' ? 'voice:peer-ready' : event,
        payload: {
          ...(payload ?? {}),
          fromPlayerId: this.hostPlayerId,
          playerId: this.hostPlayerId,
        },
      });
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
      const steps: number[] = [];
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
    if (this.hostRoom) {
      this.sendToTopic(`${TOPIC_PREFIX}/${this.hostRoom.roomCode}/broadcast`, {
        kind: 'broadcast',
        event,
        payload,
      });
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

    await this.connectGuestToHostAndRpc(
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
    await this.connectGuestToHostAndRpc(
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

  private async connectGuestToHostAndRpc(
    roomCode: string,
    rpcEvent: string,
    rpcPayload: Record<string, unknown>,
    ack?: AckFn
  ): Promise<void> {
    this.teardownTransport();

    const guestConnId = generateId();
    this.clientConnId = guestConnId;

    const toHostTopic = `${TOPIC_PREFIX}/${roomCode}/to-host`;
    const toGuestTopic = `${TOPIC_PREFIX}/${roomCode}/to-guest/${guestConnId}`;
    const broadcastTopic = `${TOPIC_PREFIX}/${roomCode}/broadcast`;

    for (let brokerIdx = 0; brokerIdx < PUBLIC_WSS_BROKERS.length; brokerIdx += 1) {
      const brokerUrl = PUBLIC_WSS_BROKERS[brokerIdx];
      const isPrimary = brokerIdx === 0;
      const connectTimeout = isPrimary ? 3500 : 3000;
      const probeWaitMs = isPrimary ? 4300 : 2800;

      let resolvedOrRejected = false;
      let retryTimers: ReturnType<typeof setTimeout>[] = [];

      const clearRetryTimers = () => {
        for (const t of retryTimers) clearTimeout(t);
        retryTimers = [];
      };

      const client = new MqttWssClient(
        brokerUrl,
        (topic, rawPayload) => {
          this.onGuestReceivedMessage(
            topic,
            toGuestTopic,
            broadcastTopic,
            rawPayload
          );
        },
        {
          onDisconnect: () => {
            if (this.mqtt === client && this.role === 'guest') {
              this.scheduleAutoReconnect(client);
            }
          },
        }
      );

      try {
        await client.connect(connectTimeout);
        await Promise.all([
          client.subscribe(toGuestTopic, 3000),
          client.subscribe(broadcastTopic, 3000),
        ]);

        this.mqtt = client;
        this.role = 'guest';
        this.activeRoomCode = roomCode;

        const reqId = generateId();
        const response = await new Promise<Record<string, unknown> | null>(
          (resolve) => {
            const finish = (res: Record<string, unknown> | null) => {
              if (resolvedOrRejected) return;
              resolvedOrRejected = true;
              clearRetryTimers();
              this.pendingAcks.delete(reqId);
              resolve(res);
            };

            this.pendingAcks.set(reqId, (res) => finish(res));

            const sendAttempt = () => {
              if (resolvedOrRejected || !client.connected) return;
              client.publish(
                toHostTopic,
                JSON.stringify({
                  kind: 'rpc',
                  reqId,
                  fromClientId: guestConnId,
                  event: rpcEvent,
                  payload: rpcPayload,
                } satisfies WireEnvelope)
              );
            };

            sendAttempt();
            // Retry cleanly in case Host briefly switched apps on mobile
            retryTimers.push(setTimeout(sendAttempt, 1400));
            if (isPrimary) {
              retryTimers.push(setTimeout(sendAttempt, 2800));
            }
            retryTimers.push(setTimeout(() => finish(null), probeWaitMs));
          }
        );

        if (response !== null) {
          if (!response.ok) {
            this.teardownTransport();
          } else {
            this.attachBrowserResumeListeners();
          }
          ack?.(response);
          return;
        }

        // No host answered on this broker — clean up and try next fallback broker
        this.pendingAcks.clear();
        this.mqtt = null;
        this.role = 'none';
        this.activeRoomCode = null;
        client.close();
      } catch {
        clearRetryTimers();
        this.pendingAcks.clear();
        if (this.mqtt === client) {
          this.mqtt = null;
          this.role = 'none';
          this.activeRoomCode = null;
        }
        client.close();
      }
    }

    this.teardownTransport();
    ack?.({
      ok: false,
      error:
        'Room not found or host left. Ask your friend to keep their room screen open and check the 6-character code.',
    });
  }

  private onGuestReceivedMessage(
    topic: string,
    toGuestTopic: string,
    broadcastTopic: string,
    rawPayload: string
  ): void {
    let msg: WireEnvelope;
    try {
      msg = JSON.parse(rawPayload) as WireEnvelope;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (topic === toGuestTopic && msg.kind === 'ack' && msg.reqId) {
      const pending = this.pendingAcks.get(msg.reqId);
      if (pending) {
        this.pendingAcks.delete(msg.reqId);
        pending(msg.response ?? { ok: false, error: 'Empty response.' });
      }
      return;
    }

    if (topic === broadcastTopic) {
      if (msg.kind === 'broadcast' && msg.event) {
        if (msg.event === 'room:host-left') {
          this.dispatch('room:peer-left', { nickname: 'Host' });
          return;
        }
        this.dispatch(msg.event, msg.payload);
        return;
      }

      if (msg.kind === 'signal' && msg.event) {
        this.dispatch(msg.event, msg.payload);
      }
    }
  }

  private handleLeaveRoom(ack?: AckFn): void {
    if (this.role === 'guest' && this.activeRoomCode && this.mqtt?.connected) {
      this.sendToTopic(`${TOPIC_PREFIX}/${this.activeRoomCode}/to-host`, {
        kind: 'rpc',
        reqId: generateId(),
        fromClientId: this.clientConnId,
        event: 'room:leave',
      });
    } else if (this.role === 'host' && this.hostRoom && this.mqtt?.connected) {
      this.broadcastFromHost('room:host-left', {});
    }
    this.teardownTransport();
    ack?.({ ok: true });
  }

  private cloneRoom(room: PublicRoomState): PublicRoomState {
    return JSON.parse(JSON.stringify(room)) as PublicRoomState;
  }
}
