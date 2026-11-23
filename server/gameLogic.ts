import crypto from 'node:crypto';
import { LADDERS, SNAKES, type MoveRecord } from '../src/shared/gameConstants.ts';
import type { InternalPlayer, InternalRoom } from './rooms.ts';

export function startGame(room: InternalRoom): void {
  if (room.players.length !== 2) {
    throw new Error('Two players are required to start a match.');
  }
  if (!room.players.every((p) => p.ready)) {
    throw new Error('Both players must be ready before starting.');
  }
  if (!room.players.every((p) => p.connected)) {
    throw new Error('Both players must be connected to start.');
  }

  const now = Date.now();
  room.phase = 'playing';
  room.winnerPlayerId = null;
  room.lastMove = null;
  room.history = [];
  room.turnNumber = 1;
  room.nextRollAllowedAt = 0;
  room.lastActivityAt = now;

  for (const p of room.players) {
    p.position = 0;
  }

  const starter =
    room.players.find((p) => p.slot === room.firstTurnSlot) ?? room.players[0];
  room.currentTurnPlayerId = starter.playerId;
}

export function executeDiceRoll(
  room: InternalRoom,
  player: InternalPlayer
): MoveRecord {
  if (room.phase !== 'playing') {
    throw new Error('Game is not currently active.');
  }
  if (room.currentTurnPlayerId !== player.playerId) {
    throw new Error('It is not your turn.');
  }

  const now = Date.now();
  if (now < room.nextRollAllowedAt) {
    throw new Error('Wait for the current move animation to finish.');
  }

  // Server-authoritative cryptographically uniform 1..6 dice roll
  const diceValue = crypto.randomInt(1, 7);
  const fromPosition = player.position;
  const candidatePosition = fromPosition + diceValue;

  let landedPosition = fromPosition;
  let finalPosition = fromPosition;
  let steps: number[] = [];
  let overshot = false;
  let transition: MoveRecord['transition'] = null;
  let won = false;

  if (candidatePosition > 100) {
    // Classic exact roll rule: cannot overshoot 100
    overshot = true;
  } else {
    landedPosition = candidatePosition;
    steps = [];
    for (let sq = fromPosition + 1; sq <= landedPosition; sq += 1) {
      steps.push(sq);
    }

    if (LADDERS[landedPosition] !== undefined) {
      finalPosition = LADDERS[landedPosition];
      transition = {
        type: 'ladder',
        from: landedPosition,
        to: finalPosition,
      };
    } else if (SNAKES[landedPosition] !== undefined) {
      finalPosition = SNAKES[landedPosition];
      transition = {
        type: 'snake',
        from: landedPosition,
        to: finalPosition,
      };
    } else {
      finalPosition = landedPosition;
    }

    player.position = finalPosition;
    if (finalPosition === 100) {
      won = true;
      room.phase = 'finished';
      room.winnerPlayerId = player.playerId;
      room.currentTurnPlayerId = null;
    }
  }

  const turnNumber = room.turnNumber;

  if (!won) {
    const opponent = room.players.find((p) => p.playerId !== player.playerId);
    room.currentTurnPlayerId = opponent ? opponent.playerId : player.playerId;
    room.turnNumber += 1;
  }

  // Calculate deterministic animation duration so next turn unlocks right after visual finish
  const diceRollMs = 620;
  const hopMs = steps.length * 190;
  const transitionMs = transition ? 520 : 0;
  const overshootMs = overshot ? 400 : 0;
  room.nextRollAllowedAt = now + diceRollMs + hopMs + transitionMs + overshootMs;
  room.lastActivityAt = now;

  const moveRecord: MoveRecord = {
    id: crypto.randomUUID(),
    turnNumber,
    playerId: player.playerId,
    playerSlot: player.slot,
    nickname: player.nickname,
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

  room.lastMove = moveRecord;
  room.history = [moveRecord, ...room.history].slice(0, 80);

  return moveRecord;
}

export function restartMatch(room: InternalRoom): void {
  if (room.players.length !== 2) {
    throw new Error('Two players are required for a rematch.');
  }
  const now = Date.now();
  // Alternate who goes first on rematch for fairness
  room.firstTurnSlot = room.firstTurnSlot === 1 ? 2 : 1;
  room.phase = 'playing';
  room.winnerPlayerId = null;
  room.lastMove = null;
  room.history = [];
  room.turnNumber = 1;
  room.nextRollAllowedAt = 0;
  room.lastActivityAt = now;

  for (const p of room.players) {
    p.position = 0;
    p.ready = true;
  }

  const starter =
    room.players.find((p) => p.slot === room.firstTurnSlot) ?? room.players[0];
  room.currentTurnPlayerId = starter.playerId;
}
