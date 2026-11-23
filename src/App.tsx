import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChatMessage, MoveRecord, PublicRoomState } from './shared/gameConstants.ts';
import {
  clearEphemeralSession,
  getServerUrl,
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
  const [connectionMode, setConnectionMode] = useState<'socket' | 'p2p'>(socket.mode);
  const [connectionError, setConnectionError] = useState<string | null>(null);
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
      setConnectionMode(socket.mode);
      setConnectionError(null);
      const saved = loadEphemeralSession();
      if (saved) {
        if (socket.mode === 'p2p' && saved.isHost) {
          clearEphemeralSession();
          return;
        }
        socket.emit('room:reconnect', saved, (rawRes: unknown) => {
          const res = rawRes as AckRoomResponse;
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

    const handleConnectError = (rawErr: unknown) => {
      setSocketConnected(false);
      if (socket.mode === 'p2p') {
        setConnectionError(null);
        return;
      }
      const err = rawErr as Error | undefined;
      setConnectionError(
        `Reconnecting real-time channel (${err?.message || 'transport retry'})...`
      );
    };

    const handleModeChanged = (rawMode: unknown) => {
      if (rawMode === 'p2p' || rawMode === 'socket') {
        setConnectionMode(rawMode);
      }
    };

    const handleRoomUpdated = (rawRoom: unknown) => {
      setRoom(rawRoom as PublicRoomState);
    };

    const handleGameMove = (rawPayload: unknown) => {
      const payload = rawPayload as { move: MoveRecord; room: PublicRoomState };
      if (payload?.room) {
        setRoom(payload.room);
      }
    };

    const handlePeerLeft = (rawPayload: unknown) => {
      const payload = (rawPayload as { nickname?: string }) ?? {};
      setPeerNotice(
        `${payload.nickname ?? 'Your friend'} left the room. Waiting for a player to join.`
      );
      window.setTimeout(() => setPeerNotice(null), 5000);
    };

    const handleChatMessage = (rawMessage: unknown) => {
      const message = rawMessage as ChatMessage;
      if (!message?.id) return;
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
    socket.on('connect_error', handleConnectError);
    socket.on('mode:changed', handleModeChanged);
    socket.on('room:updated', handleRoomUpdated);
    socket.on('game:move', handleGameMove);
    socket.on('room:peer-left', handlePeerLeft);
    socket.on('chat:message', handleChatMessage);

    void socket.ensureReady().then((detectedMode) => {
      setConnectionMode(detectedMode);
      if (socket.connected) {
        handleConnect();
      }
    });

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('connect_error', handleConnectError);
      socket.off('mode:changed', handleModeChanged);
      socket.off('room:updated', handleRoomUpdated);
      socket.off('game:move', handleGameMove);
      socket.off('room:peer-left', handlePeerLeft);
      socket.off('chat:message', handleChatMessage);
    };
  }, [socket]);

  const ensureConnected = useCallback(
    async () => {
      const detectedMode = await socket.ensureReady();
      setConnectionMode(detectedMode);
      if (socket.connected) {
        return true;
      }
      return new Promise<boolean>((resolve) => {
        socket.connect();
        const timer = window.setTimeout(() => {
          socket.off('connect', onConnect);
          resolve(false);
        }, 5500);
        const onConnect = () => {
          window.clearTimeout(timer);
          resolve(true);
        };
        socket.once('connect', onConnect);
      });
    },
    [socket]
  );

  const handleRetryConnection = useCallback(() => {
    setConnectionError(null);
    socket.disconnect();
    socket.connect();
  }, [socket]);

  const handleCreateRoom = useCallback(
    async (nickname: string, avatarId: string) => {
      soundFx.unlock();
      setError(null);
      const ready = await ensureConnected();
      if (!ready) {
        setError(
          connectionError ??
            'Unable to initialize connection. Please try again.'
        );
        return;
      }

      await new Promise<void>((resolve) => {
        let settled = false;
        const timeoutId = window.setTimeout(() => {
          if (!settled) {
            settled = true;
            setError('Timed out creating room. Please try again.');
            resolve();
          }
        }, 16000);

        socket.emit(
          'room:create',
          { nickname, avatarId },
          (rawRes: unknown) => {
            const res = rawRes as AckRoomResponse;
            if (settled) return;
            settled = true;
            window.clearTimeout(timeoutId);
            if (
              res?.ok &&
              res.room &&
              res.playerId &&
              res.roomCode &&
              res.reconnectSecret
            ) {
              saveEphemeralSession({
                roomCode: res.roomCode,
                playerId: res.playerId,
                reconnectSecret: res.reconnectSecret,
                isHost: true,
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
      });
    },
    [connectionError, ensureConnected, socket]
  );

  const handleJoinRoom = useCallback(
    async (roomCode: string, nickname: string, avatarId: string) => {
      soundFx.unlock();
      setError(null);
      const ready = await ensureConnected();
      if (!ready) {
        setError(
          connectionError ??
            'Unable to initialize connection. Please try again.'
        );
        return;
      }

      await new Promise<void>((resolve) => {
        let settled = false;
        const timeoutId = window.setTimeout(() => {
          if (!settled) {
            settled = true;
            setError('Timed out joining room. Please try again.');
            resolve();
          }
        }, 18000);

        socket.emit(
          'room:join',
          { roomCode, nickname, avatarId },
          (rawRes: unknown) => {
            const res = rawRes as AckRoomResponse;
            if (settled) return;
            settled = true;
            window.clearTimeout(timeoutId);
            if (
              res?.ok &&
              res.room &&
              res.playerId &&
              res.roomCode &&
              res.reconnectSecret
            ) {
              saveEphemeralSession({
                roomCode: res.roomCode,
                playerId: res.playerId,
                reconnectSecret: res.reconnectSecret,
                isHost: false,
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
      });
    },
    [connectionError, ensureConnected, socket]
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
          connectionMode={connectionMode}
          connectionError={connectionError}
          onRetryConnection={handleRetryConnection}
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
