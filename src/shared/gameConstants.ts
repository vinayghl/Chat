export type PlayerSlot = 1 | 2;

export type RoomPhase = 'lobby' | 'playing' | 'finished';

export interface PlayerState {
  playerId: string;
  slot: PlayerSlot;
  nickname: string;
  avatarId: string;
  position: number; // 0 = staging before square 1, 1..100 on board
  ready: boolean;
  connected: boolean;
  micEnabled: boolean;
  micMuted: boolean;
  lastSeenAt: number;
}

export interface MoveRecord {
  id: string;
  turnNumber: number;
  playerId: string;
  playerSlot: PlayerSlot;
  nickname: string;
  diceValue: number;
  fromPosition: number;
  landedPosition: number; // before snake/ladder
  finalPosition: number;  // after snake/ladder
  steps: number[];        // square-by-square walk path
  transition: {
    type: 'ladder' | 'snake';
    from: number;
    to: number;
  } | null;
  overshot: boolean;
  won: boolean;
  timestamp: number;
}

export interface ChatMessage {
  id: string;
  playerId: string;
  playerSlot: PlayerSlot;
  nickname: string;
  text: string;
  timestamp: number;
}

export interface PublicRoomState {
  roomCode: string;
  phase: RoomPhase;
  players: PlayerState[];
  currentTurnPlayerId: string | null;
  turnNumber: number;
  winnerPlayerId: string | null;
  lastMove: MoveRecord | null;
  history: MoveRecord[];
  chatMessages: ChatMessage[];
  nextRollAllowedAt: number;
  createdAt: number;
}

export interface IceConfigResponse {
  iceServers: RTCIceServer[];
  hasTurn: boolean;
}

export const LADDERS: Record<number, number> = {
  4: 25,
  13: 46,
  33: 49,
  42: 63,
  50: 69,
  62: 81,
  74: 92,
};

export const SNAKES: Record<number, number> = {
  27: 5,
  40: 3,
  43: 18,
  54: 31,
  66: 45,
  76: 58,
  89: 53,
  99: 41,
};

export const AVATAR_OPTIONS = [
  { id: 'crimson-crown', label: 'Crimson Crown', primary: '#F43F5E', secondary: '#9F1239' },
  { id: 'emerald-viper', label: 'Emerald Viper', primary: '#10B981', secondary: '#065F46' },
  { id: 'amber-lion', label: 'Amber Lion', primary: '#F59E0B', secondary: '#92400E' },
  { id: 'cobalt-wolf', label: 'Cobalt Wolf', primary: '#38BDF8', secondary: '#0369A1' },
] as const;

/**
 * Converts a board square (1..100) into 0-based (row, col) on a 10x10 top-left origin grid.
 * Square 1 = bottom-left (row 9, col 0). Square 100 = top-left (row 0, col 0).
 */
export function getSquareCoords(square: number): { row: number; col: number; xPct: number; yPct: number } {
  const clamped = Math.max(1, Math.min(100, square));
  const rowFromBottom = Math.floor((clamped - 1) / 10);
  const row = 9 - rowFromBottom;
  const offsetInRow = (clamped - 1) % 10;
  const col = rowFromBottom % 2 === 0 ? offsetInRow : 9 - offsetInRow;
  return {
    row,
    col,
    xPct: col * 10 + 5,
    yPct: row * 10 + 5,
  };
}
