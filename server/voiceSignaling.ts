import type { Socket } from 'socket.io';
import { getMembershipBySocket, toPublicRoomState } from './rooms.ts';

export function registerVoiceSignalingHandlers(socket: Socket): void {
  socket.on('voice:offer', (payload: { sdp?: unknown }) => {
    const membership = getMembershipBySocket(socket.id);
    if (!membership || !payload || typeof payload.sdp !== 'object' || payload.sdp === null) {
      return;
    }
    const { room, player } = membership;
    room.lastActivityAt = Date.now();
    socket.to(room.roomCode).emit('voice:offer', {
      fromPlayerId: player.playerId,
      sdp: payload.sdp,
    });
  });

  socket.on('voice:answer', (payload: { sdp?: unknown }) => {
    const membership = getMembershipBySocket(socket.id);
    if (!membership || !payload || typeof payload.sdp !== 'object' || payload.sdp === null) {
      return;
    }
    const { room, player } = membership;
    room.lastActivityAt = Date.now();
    socket.to(room.roomCode).emit('voice:answer', {
      fromPlayerId: player.playerId,
      sdp: payload.sdp,
    });
  });

  socket.on('voice:ice-candidate', (payload: { candidate?: unknown }) => {
    const membership = getMembershipBySocket(socket.id);
    if (!membership || !payload || typeof payload.candidate !== 'object' || payload.candidate === null) {
      return;
    }
    const { room, player } = membership;
    socket.to(room.roomCode).emit('voice:ice-candidate', {
      fromPlayerId: player.playerId,
      candidate: payload.candidate,
    });
  });

  socket.on(
    'voice:state',
    (payload: { micEnabled?: boolean; micMuted?: boolean }) => {
      const membership = getMembershipBySocket(socket.id);
      if (!membership || !payload) return;

      const { room, player } = membership;
      if (typeof payload.micEnabled === 'boolean') {
        player.micEnabled = payload.micEnabled;
      }
      if (typeof payload.micMuted === 'boolean') {
        player.micMuted = payload.micMuted;
      }
      room.lastActivityAt = Date.now();

      socket.nsp.to(room.roomCode).emit('room:updated', toPublicRoomState(room));
    }
  );

  socket.on('voice:speaking', (payload: { speaking?: boolean }) => {
    const membership = getMembershipBySocket(socket.id);
    if (!membership || !payload) return;
    const { room, player } = membership;
    socket.to(room.roomCode).emit('voice:speaking', {
      playerId: player.playerId,
      speaking: Boolean(payload.speaking),
    });
  });

  socket.on('voice:ready', () => {
    const membership = getMembershipBySocket(socket.id);
    if (!membership) return;
    const { room, player } = membership;
    socket.to(room.roomCode).emit('voice:peer-ready', {
      playerId: player.playerId,
    });
  });
}
