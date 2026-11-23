import crypto from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import type { ChatMessage } from '../src/shared/gameConstants.ts';
import { executeDiceRoll, restartMatch, startGame } from './gameLogic.ts';
import {
  createRoom,
  detachSocket,
  getMembershipBySocket,
  joinRoom,
  markSocketDisconnected,
  reconnectPlayer,
  toPublicRoomState,
} from './rooms.ts';
import { registerVoiceSignalingHandlers } from './voiceSignaling.ts';

type AckCallback = (response: Record<string, unknown>) => void;

function safeAck(ack: unknown, payload: Record<string, unknown>): void {
  if (typeof ack === 'function') {
    ack(payload);
  }
}

export function registerSocketHandlers(io: Server): void {
  io.on('connection', (socket: Socket) => {
    registerVoiceSignalingHandlers(socket);

    socket.on(
      'room:create',
      (
        payload: { nickname?: string; avatarId?: string } | undefined,
        ack?: AckCallback
      ) => {
        try {
          const { room, player } = createRoom(
            socket.id,
            payload?.nickname,
            payload?.avatarId
          );
          socket.join(room.roomCode);
          const publicState = toPublicRoomState(room);
          safeAck(ack, {
            ok: true,
            roomCode: room.roomCode,
            playerId: player.playerId,
            reconnectSecret: player.reconnectSecret,
            room: publicState,
          });
        } catch (err) {
          safeAck(ack, {
            ok: false,
            error: err instanceof Error ? err.message : 'Failed to create room.',
          });
        }
      }
    );

    socket.on(
      'room:join',
      (
        payload: { roomCode?: string; nickname?: string; avatarId?: string } | undefined,
        ack?: AckCallback
      ) => {
        try {
          const { room, player } = joinRoom(
            socket.id,
            payload?.roomCode,
            payload?.nickname,
            payload?.avatarId
          );
          socket.join(room.roomCode);
          const publicState = toPublicRoomState(room);
          io.to(room.roomCode).emit('room:updated', publicState);
          safeAck(ack, {
            ok: true,
            roomCode: room.roomCode,
            playerId: player.playerId,
            reconnectSecret: player.reconnectSecret,
            room: publicState,
          });
        } catch (err) {
          safeAck(ack, {
            ok: false,
            error: err instanceof Error ? err.message : 'Failed to join room.',
          });
        }
      }
    );

    socket.on(
      'room:reconnect',
      (
        payload:
          | { roomCode?: string; playerId?: string; reconnectSecret?: string }
          | undefined,
        ack?: AckCallback
      ) => {
        try {
          const { room, player } = reconnectPlayer(
            socket.id,
            payload?.roomCode,
            payload?.playerId,
            payload?.reconnectSecret
          );
          socket.join(room.roomCode);
          const publicState = toPublicRoomState(room);
          io.to(room.roomCode).emit('room:updated', publicState);
          socket.to(room.roomCode).emit('voice:peer-ready', {
            playerId: player.playerId,
          });
          safeAck(ack, {
            ok: true,
            roomCode: room.roomCode,
            playerId: player.playerId,
            room: publicState,
          });
        } catch (err) {
          safeAck(ack, {
            ok: false,
            error: err instanceof Error ? err.message : 'Reconnection failed.',
          });
        }
      }
    );

    socket.on('room:toggle-ready', (ack?: AckCallback) => {
      const membership = getMembershipBySocket(socket.id);
      if (!membership) {
        safeAck(ack, { ok: false, error: 'Not in a room.' });
        return;
      }
      const { room, player } = membership;
      if (room.phase !== 'lobby') {
        safeAck(ack, { ok: false, error: 'Game has already started.' });
        return;
      }

      player.ready = !player.ready;
      room.lastActivityAt = Date.now();
      const publicState = toPublicRoomState(room);
      io.to(room.roomCode).emit('room:updated', publicState);
      safeAck(ack, { ok: true, ready: player.ready });
    });

    socket.on('game:start', (ack?: AckCallback) => {
      const membership = getMembershipBySocket(socket.id);
      if (!membership) {
        safeAck(ack, { ok: false, error: 'Not in a room.' });
        return;
      }
      const { room } = membership;
      try {
        startGame(room);
        const publicState = toPublicRoomState(room);
        io.to(room.roomCode).emit('room:updated', publicState);
        safeAck(ack, { ok: true });
      } catch (err) {
        safeAck(ack, {
          ok: false,
          error: err instanceof Error ? err.message : 'Unable to start game.',
        });
      }
    });

    socket.on('game:roll-dice', (ack?: AckCallback) => {
      const membership = getMembershipBySocket(socket.id);
      if (!membership) {
        safeAck(ack, { ok: false, error: 'Not in a room.' });
        return;
      }
      const { room, player } = membership;
      try {
        const move = executeDiceRoll(room, player);
        const publicState = toPublicRoomState(room);
        io.to(room.roomCode).emit('game:move', {
          move,
          room: publicState,
        });
        safeAck(ack, { ok: true, move });
      } catch (err) {
        safeAck(ack, {
          ok: false,
          error: err instanceof Error ? err.message : 'Cannot roll dice right now.',
        });
      }
    });

    socket.on('game:rematch', (ack?: AckCallback) => {
      const membership = getMembershipBySocket(socket.id);
      if (!membership) {
        safeAck(ack, { ok: false, error: 'Not in a room.' });
        return;
      }
      const { room } = membership;
      try {
        restartMatch(room);
        const publicState = toPublicRoomState(room);
        io.to(room.roomCode).emit('room:updated', publicState);
        safeAck(ack, { ok: true });
      } catch (err) {
        safeAck(ack, {
          ok: false,
          error: err instanceof Error ? err.message : 'Unable to start rematch.',
        });
      }
    });

    socket.on(
      'chat:send',
      (payload: { text?: unknown } | undefined, ack?: AckCallback) => {
        const membership = getMembershipBySocket(socket.id);
        if (!membership) {
          safeAck(ack, { ok: false, error: 'Not in a room.' });
          return;
        }
        const rawText = typeof payload?.text === 'string' ? payload.text : '';
        const text = rawText.replace(/\s+/g, ' ').trim();
        if (text.length < 1 || text.length > 280) {
          safeAck(ack, {
            ok: false,
            error: 'Message must be between 1 and 280 characters.',
          });
          return;
        }

        const { room, player } = membership;
        const now = Date.now();
        const message: ChatMessage = {
          id: crypto.randomUUID(),
          playerId: player.playerId,
          playerSlot: player.slot,
          nickname: player.nickname,
          text,
          timestamp: now,
        };

        room.chatMessages = [...room.chatMessages, message].slice(-100);
        room.lastActivityAt = now;
        io.to(room.roomCode).emit('chat:message', message);
        safeAck(ack, { ok: true, message });
      }
    );

    socket.on('room:leave', (ack?: AckCallback) => {
      const result = detachSocket(socket.id);
      if (result) {
        socket.leave(result.room.roomCode);
        if (!result.roomDeleted) {
          io.to(result.room.roomCode).emit('room:updated', toPublicRoomState(result.room));
          io.to(result.room.roomCode).emit('room:peer-left', {
            nickname: result.removedPlayer.nickname,
          });
        }
      }
      safeAck(ack, { ok: true });
    });

    socket.on('disconnect', () => {
      const disconnected = markSocketDisconnected(socket.id);
      if (disconnected) {
        io.to(disconnected.room.roomCode).emit(
          'room:updated',
          toPublicRoomState(disconnected.room)
        );
      }
    });
  });
}
