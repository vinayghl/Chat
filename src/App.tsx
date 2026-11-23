import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChatMessage, MoveRecord, PublicRoomState } from './shared/gameConstants.ts';
import {
  clearEphemeralSession,
  getSocket,
  loadEphemeralSession,
  saveEphemeralSession,
} from './socket/socketClient.ts';
import { useWebRTCVoice } from './voice/useWebRTCVoice.ts';
import { AnimatedBackground } from './components/AnimatedBackground.tsx';
import { HomeScreen } from './components/HomeScreen.tsx';
import { LobbyScreen } from './components/LobbyScreen.tsx';
import { GameScreen } from './components/GameScreen.tsx';
import { soundFx } from './utils/soundFx.ts';

interface AckRoomResponse {
  ok: boolean;
  error?: string;
  roomCode?: string;
  playerId?: string;
  reconnectSecret?: string;
  room?: PublicRoomState;
}

export default function App() {
  const socket = useMemo(() => getSocket(), []);

  const [socketConnected, setSocketConnected] = useState(socket.connected);
  const [room, setRoom] = useState<PublicRoomState | null>(null);
  const [myPlayerId, setMyPlayerId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [peerNotice, setPeerNotice] = useState<string | null>(null);

  const initialRoomCode = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('room') ?? '';
    return code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  }, []);

  const me = useMemo(
    () => room?.players.find((p) => p.playerId === myPlayerId) ?? null,
    [room, myPlayerId]
  );
  const opponent = useMemo(
    () => room?.players.find((p) => p.playerId !== myPlayerId) ?? null,
    [room, myPlayerId]
  );

  const voice = useWebRTCVoice({
    socket,
    roomCode: room?.roomCode ?? null,
    myPlayerId,
    mySlot: me?.slot ?? null,
    opponentConnected: Boolean(opponent && opponent.connected),
  });

  // Socket lifecycle & room state sync
  useEffect(() => {
    const handleConnect = () => {
      setSocketConnected(true);
      const saved = loadEphemeralSession();
      if (saved) {
        socket.emit('room:reconnect', saved, (res: AckRoomResponse) => {
          if (res?.ok && res.room && res.playerId) {
            setRoom(res.room);
            setMyPlayerId(res.playerId);
            setError(null);
          } else {
            clearEphemeralSession();
          }
        });
      }
    };

    const handleDisconnect = () => {
      setSocketConnected(false);
    };

    const handleRoomUpdated = (updatedRoom: PublicRoomState) => {
      setRoom(updatedRoom);
    };

    const handleGameMove = (payload: { move: MoveRecord; room: PublicRoomState }) => {
      setRoom(payload.room);
    };

    const handlePeerLeft = (payload: { nickname?: string }) => {
      setPeerNotice(
        `${payload.nickname ?? 'Your friend'} left the room. Waiting for a player to join.`
      );
      window.setTimeout(() => setPeerNotice(null), 5000);
    };

    const handleChatMessage = (message: ChatMessage) => {
      setRoom((prev) => {
        if (!prev) return prev;
        if (prev.chatMessages.some((m) => m.id === message.id)) {
          return prev;
        }
        return {
          ...prev,
          chatMessages: [...prev.chatMessages, message].slice(-100),
        };
      });
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('room:updated', handleRoomUpdated);
    socket.on('game:move', handleGameMove);
    socket.on('room:peer-left', handlePeerLeft);
    socket.on('chat:message', handleChatMessage);

    if (socket.connected) {
      handleConnect();
    }

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('room:updated', handleRoomUpdated);
      socket.off('game:move', handleGameMove);
      socket.off('room:peer-left', handlePeerLeft);
      socket.off('chat:message', handleChatMessage);
    };
  }, [socket]);

  const handleCreateRoom = useCallback(
    (nickname: string, avatarId: string) =>
      new Promise<void>((resolve) => {
        soundFx.unlock();
        setError(null);
        socket.emit(
          'room:create',
          { nickname, avatarId },
          (res: AckRoomResponse) => {
            if (res?.ok && res.room && res.playerId && res.roomCode && res.reconnectSecret) {
              saveEphemeralSession({
                roomCode: res.roomCode,
                playerId: res.playerId,
                reconnectSecret: res.reconnectSecret,
              });
              setMyPlayerId(res.playerId);
              setRoom(res.room);
              window.history.replaceState(null, '', `/?room=${res.roomCode}`);
            } else {
              setError(res?.error ?? 'Could not create room.');
            }
            resolve();
          }
        );
      }),
    [socket]
  );

  const handleJoinRoom = useCallback(
    (roomCode: string, nickname: string, avatarId: string) =>
      new Promise<void>((resolve) => {
        soundFx.unlock();
        setError(null);
        socket.emit(
          'room:join',
          { roomCode, nickname, avatarId },
          (res: AckRoomResponse) => {
            if (res?.ok && res.room && res.playerId && res.roomCode && res.reconnectSecret) {
              saveEphemeralSession({
                roomCode: res.roomCode,
                playerId: res.playerId,
                reconnectSecret: res.reconnectSecret,
              });
              setMyPlayerId(res.playerId);
              setRoom(res.room);
              window.history.replaceState(null, '', `/?room=${res.roomCode}`);
            } else {
              setError(res?.error ?? 'Could not join room.');
            }
            resolve();
          }
        );
      }),
    [socket]
  );

  const handleToggleReady = useCallback(
    () =>
      new Promise<void>((resolve) => {
        setError(null);
        socket.emit('room:toggle-ready', (res: AckRoomResponse) => {
          if (!res?.ok) {
            setError(res?.error ?? 'Failed to update ready state.');
          }
          resolve();
        });
      }),
    [socket]
  );

  const handleStartGame = useCallback(
    () =>
      new Promise<void>((resolve) => {
        soundFx.unlock();
        setError(null);
        socket.emit('game:start', (res: AckRoomResponse) => {
          if (!res?.ok) {
            setError(res?.error ?? 'Failed to start game.');
          }
          resolve();
        });
      }),
    [socket]
  );

  const handleRollDice = useCallback(
    () =>
      new Promise<void>((resolve) => {
        setError(null);
        socket.emit('game:roll-dice', (res: AckRoomResponse) => {
          if (!res?.ok && res?.error) {
            setError(res.error);
          }
          resolve();
        });
      }),
    [socket]
  );

  const handleRematch = useCallback(
    () =>
      new Promise<void>((resolve) => {
        setError(null);
        socket.emit('game:rematch', (res: AckRoomResponse) => {
          if (!res?.ok && res?.error) {
            setError(res.error);
          }
          resolve();
        });
      }),
    [socket]
  );

  const handleSendMessage = useCallback(
    (text: string) =>
      new Promise<void>((resolve) => {
        setError(null);
        socket.emit('chat:send', { text }, (res: AckRoomResponse) => {
          if (!res?.ok && res?.error) {
            setError(res.error);
          }
          resolve();
        });
      }),
    [socket]
  );

  const handleLeaveRoom = useCallback(
    () =>
      new Promise<void>((resolve) => {
        voice.teardownVoice();
        clearEphemeralSession();
        socket.emit('room:leave', () => {
          setRoom(null);
          setMyPlayerId(null);
          setError(null);
          setPeerNotice(null);
          window.history.replaceState(null, '', '/');
          resolve();
        });
      }),
    [socket, voice]
  );

  return (
    <>
      <AnimatedBackground />

      {!room || !myPlayerId ? (
        <HomeScreen
          socketConnected={socketConnected}
          initialRoomCode={initialRoomCode}
          onCreateRoom={handleCreateRoom}
          onJoinRoom={handleJoinRoom}
          error={error}
          clearError={() => setError(null)}
        />
      ) : room.phase === 'lobby' ? (
        <LobbyScreen
          room={room}
          myPlayerId={myPlayerId}
          voice={voice}
          onToggleReady={handleToggleReady}
          onStartGame={handleStartGame}
          onSendMessage={handleSendMessage}
          onLeaveRoom={handleLeaveRoom}
          error={peerNotice || error}
        />
      ) : (
        <GameScreen
          room={room}
          myPlayerId={myPlayerId}
          voice={voice}
          onRollDice={handleRollDice}
          onRematch={handleRematch}
          onSendMessage={handleSendMessage}
          onLeaveRoom={handleLeaveRoom}
          error={peerNotice || error}
        />
      )}
    </>
  );
}
