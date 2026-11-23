import crypto from 'node:crypto';
import type {
  ChatMessage,
  MoveRecord,
  PlayerSlot,
  PlayerState,
  PublicRoomState,
  RoomPhase,
} from '../src/shared/gameConstants.ts';
import { AVATAR_OPTIONS } from '../src/shared/gameConstants.ts';

export interface InternalPlayer extends PlayerState {
  socketId: string;
  reconnectSecret: string;
}

export interface InternalRoom {
  roomCode: string;
  phase: RoomPhase;
  players: InternalPlayer[];
  currentTurnPlayerId: string | null;
  turnNumber: number;
  winnerPlayerId: string | null;
  lastMove: MoveRecord | null;
  history: MoveRecord[];
  chatMessages: ChatMessage[];
  nextRollAllowedAt: number;
  createdAt: number;
  lastActivityAt: number;
  emptySinceAt: number | null;
  firstTurnSlot: PlayerSlot;
}

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 6;
const ROOM_INACTIVITY_TTL_MS = 30 * 60 * 1000; // 30 minutes
const ROOM_ALL_DISCONNECTED_TTL_MS = 5 * 60 * 1000; // 5 minutes if everyone disconnected

const rooms = new Map<string, InternalRoom>();
const socketToMembership = new Map<string, { roomCode: string; playerId: string }>();

export function sanitizeNickname(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, 18);
}

export function sanitizeRoomCode(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LENGTH);
}

export function sanitizeAvatarId(raw: unknown, fallbackSlot: PlayerSlot): string {
  if (typeof raw === 'string' && AVATAR_OPTIONS.some((a) => a.id === raw)) {
    return raw;
  }
  return AVATAR_OPTIONS[fallbackSlot === 1 ? 0 : 1].id;
}

function generateUniqueRoomCode(): string {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
      code += ROOM_CODE_ALPHABET[crypto.randomInt(0, ROOM_CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) {
      return code;
    }
  }
  throw new Error('Unable to allocate a unique room code');
}

export function createRoom(
  socketId: string,
  nicknameInput: unknown,
  avatarInput?: unknown
): { room: InternalRoom; player: InternalPlayer } {
  const nickname = sanitizeNickname(nicknameInput);
  if (nickname.length < 1) {
    throw new Error('Please enter a nickname (1–18 characters).');
  }

  // Ensure this socket leaves any prior room first
  detachSocket(socketId);

  const roomCode = generateUniqueRoomCode();
  const now = Date.now();
  const playerId = crypto.randomUUID();
  const reconnectSecret = crypto.randomBytes(16).toString('hex');

  const player: InternalPlayer = {
    playerId,
    slot: 1,
    nickname,
    avatarId: sanitizeAvatarId(avatarInput, 1),
    position: 0,
    ready: false,
    connected: true,
    micEnabled: false,
    micMuted: false,
    lastSeenAt: now,
    socketId,
    reconnectSecret,
  };

  const room: InternalRoom = {
    roomCode,
    phase: 'lobby',
    players: [player],
    currentTurnPlayerId: null,
    turnNumber: 0,
    winnerPlayerId: null,
    lastMove: null,
    history: [],
    chatMessages: [],
    nextRollAllowedAt: 0,
    createdAt: now,
    lastActivityAt: now,
    emptySinceAt: null,
    firstTurnSlot: 1,
  };

  rooms.set(roomCode, room);
  socketToMembership.set(socketId, { roomCode, playerId });
  return { room, player };
}

export function joinRoom(
  socketId: string,
  roomCodeInput: unknown,
  nicknameInput: unknown,
  avatarInput?: unknown
): { room: InternalRoom; player: InternalPlayer } {
  const roomCode = sanitizeRoomCode(roomCodeInput);
  if (roomCode.length !== ROOM_CODE_LENGTH) {
    throw new Error('Room code must be 6 characters.');
  }

  const room = rooms.get(roomCode);
  if (!room) {
    throw new Error('Room not found or has expired.');
  }

  const nickname = sanitizeNickname(nicknameInput);
  if (nickname.length < 1) {
    throw new Error('Please enter a nickname (1–18 characters).');
  }

  if (room.players.length >= 2) {
    throw new Error('This room is already full (2/2 players).');
  }

  if (room.phase !== 'lobby') {
    throw new Error('This match is already in progress.');
  }

  detachSocket(socketId);

  const takenSlot = room.players[0]?.slot;
  const nextSlot: PlayerSlot = takenSlot === 1 ? 2 : 1;
  let avatarId = sanitizeAvatarId(avatarInput, nextSlot);
  if (room.players[0]?.avatarId === avatarId) {
    const alternative = AVATAR_OPTIONS.find((a) => a.id !== avatarId);
    if (alternative) avatarId = alternative.id;
  }

  const now = Date.now();
  const playerId = crypto.randomUUID();
  const reconnectSecret = crypto.randomBytes(16).toString('hex');

  const player: InternalPlayer = {
    playerId,
    slot: nextSlot,
    nickname,
    avatarId,
    position: 0,
    ready: false,
    connected: true,
    micEnabled: false,
    micMuted: false,
    lastSeenAt: now,
    socketId,
    reconnectSecret,
  };

  room.players.push(player);
  room.players.sort((a, b) => a.slot - b.slot);
  room.lastActivityAt = now;
  room.emptySinceAt = null;
  socketToMembership.set(socketId, { roomCode, playerId });

  return { room, player };
}

export function reconnectPlayer(
  socketId: string,
  roomCodeInput: unknown,
  playerIdInput: unknown,
  secretInput: unknown
): { room: InternalRoom; player: InternalPlayer } {
  const roomCode = sanitizeRoomCode(roomCodeInput);
  const room = rooms.get(roomCode);
  if (!room) {
    throw new Error('Room no longer exists.');
  }

  if (typeof playerIdInput !== 'string' || typeof secretInput !== 'string') {
    throw new Error('Invalid reconnection credentials.');
  }

  const player = room.players.find((p) => p.playerId === playerIdInput);
  if (!player) {
    throw new Error('Player session not found in this room.');
  }

  const expectedBuf = Buffer.from(player.reconnectSecret, 'utf8');
  const actualBuf = Buffer.from(secretInput, 'utf8');
  if (
    expectedBuf.length !== actualBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, actualBuf)
  ) {
    throw new Error('Session verification failed.');
  }

  // Remove old socket mapping if still present
  if (player.socketId && player.socketId !== socketId) {
    socketToMembership.delete(player.socketId);
  }

  const now = Date.now();
  player.socketId = socketId;
  player.connected = true;
  player.lastSeenAt = now;
  room.lastActivityAt = now;
  room.emptySinceAt = null;
  socketToMembership.set(socketId, { roomCode, playerId: player.playerId });

  return { room, player };
}

export function getMembershipBySocket(
  socketId: string
): { room: InternalRoom; player: InternalPlayer } | null {
  const entry = socketToMembership.get(socketId);
  if (!entry) return null;
  const room = rooms.get(entry.roomCode);
  if (!room) {
    socketToMembership.delete(socketId);
    return null;
  }
  const player = room.players.find((p) => p.playerId === entry.playerId);
  if (!player) {
    socketToMembership.delete(socketId);
    return null;
  }
  return { room, player };
}

export function markSocketDisconnected(
  socketId: string
): { room: InternalRoom; player: InternalPlayer } | null {
  const membership = getMembershipBySocket(socketId);
  socketToMembership.delete(socketId);
  if (!membership) return null;

  const { room, player } = membership;
  // Ignore stale disconnect events if the player already reconnected on a newer socket
  if (player.socketId !== socketId) {
    return null;
  }

  const now = Date.now();
  player.connected = false;
  player.lastSeenAt = now;
  room.lastActivityAt = now;

  if (room.players.every((p) => !p.connected)) {
    room.emptySinceAt = now;
  }

  return { room, player };
}

export function detachSocket(
  socketId: string
): { room: InternalRoom; removedPlayer: InternalPlayer; roomDeleted: boolean } | null {
  const membership = getMembershipBySocket(socketId);
  socketToMembership.delete(socketId);
  if (!membership) return null;

  const { room, player } = membership;
  room.players = room.players.filter((p) => p.playerId !== player.playerId);
  room.lastActivityAt = Date.now();

  if (room.players.length === 0) {
    rooms.delete(room.roomCode);
    return { room, removedPlayer: player, roomDeleted: true };
  }

  // If the remaining player was in a game and someone explicitly left, return to lobby
  if (room.phase !== 'lobby') {
    room.phase = 'lobby';
    room.currentTurnPlayerId = null;
    room.winnerPlayerId = null;
    room.lastMove = null;
    room.history = [];
    room.turnNumber = 0;
    room.nextRollAllowedAt = 0;
    for (const remaining of room.players) {
      remaining.position = 0;
      remaining.ready = false;
    }
  } else {
    // Re-assign remaining player cleanly if needed, keep their slot or ready=false
    room.players[0].ready = false;
  }

  if (room.players.every((p) => !p.connected)) {
    room.emptySinceAt = Date.now();
  }

  return { room, removedPlayer: player, roomDeleted: false };
}

export function getRoom(roomCode: string): InternalRoom | undefined {
  return rooms.get(sanitizeRoomCode(roomCode));
}

export function getActiveRoomCount(): number {
  return rooms.size;
}

export function toPublicRoomState(room: InternalRoom): PublicRoomState {
  return {
    roomCode: room.roomCode,
    phase: room.phase,
    players: room.players.map((p) => ({
      playerId: p.playerId,
      slot: p.slot,
      nickname: p.nickname,
      avatarId: p.avatarId,
      position: p.position,
      ready: p.ready,
      connected: p.connected,
      micEnabled: p.micEnabled,
      micMuted: p.micMuted,
      lastSeenAt: p.lastSeenAt,
    })),
    currentTurnPlayerId: room.currentTurnPlayerId,
    turnNumber: room.turnNumber,
    winnerPlayerId: room.winnerPlayerId,
    lastMove: room.lastMove,
    history: room.history,
    chatMessages: room.chatMessages,
    nextRollAllowedAt: room.nextRollAllowedAt,
    createdAt: room.createdAt,
  };
}

export function cleanupExpiredRooms(): number {
  const now = Date.now();
  let removed = 0;
  for (const [code, room] of rooms.entries()) {
    const inactiveTooLong = now - room.lastActivityAt > ROOM_INACTIVITY_TTL_MS;
    const allDisconnectedTooLong =
      room.emptySinceAt !== null && now - room.emptySinceAt > ROOM_ALL_DISCONNECTED_TTL_MS;

    if (inactiveTooLong || allDisconnectedTooLong) {
      for (const p of room.players) {
        if (p.socketId) {
          socketToMembership.delete(p.socketId);
        }
      }
      rooms.delete(code);
      removed += 1;
    }
  }
  return removed;
}
