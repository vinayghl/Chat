import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  LogOut,
  RotateCcw,
  Swords,
  Trophy,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
  TrendingDown,
  History,
} from 'lucide-react';
import type { MoveRecord, PublicRoomState } from '../shared/gameConstants.ts';
import type { UseWebRTCVoiceReturn } from '../voice/useWebRTCVoice.ts';
import { soundFx } from '../utils/soundFx.ts';
import { Dice3D } from './Dice3D.tsx';
import { PlayerAvatar } from './PlayerAvatar.tsx';
import { SnakeAndLaddersBoard } from './SnakeAndLaddersBoard.tsx';
import { VoiceControls } from './VoiceControls.tsx';
import { ChatBox } from './ChatBox.tsx';

interface GameScreenProps {
  room: PublicRoomState;
  myPlayerId: string;
  voice: UseWebRTCVoiceReturn;
  onRollDice: () => Promise<void>;
  onRematch: () => Promise<void>;
  onSendMessage: (text: string) => Promise<void>;
  onLeaveRoom: () => Promise<void>;
  error: string | null;
}

export const GameScreen: React.FC<GameScreenProps> = ({
  room,
  myPlayerId,
  voice,
  onRollDice,
  onRematch,
  onSendMessage,
  onLeaveRoom,
  error,
}) => {
  const [sfxMuted, setSfxMuted] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [animatingMove, setAnimatingMove] = useState(false);
  const [diceValue, setDiceValue] = useState<number>(room.lastMove?.diceValue ?? 6);
  const [highlightedSquare, setHighlightedSquare] = useState<number | null>(null);
  const [showVictoryModal, setShowVictoryModal] = useState(
    room.phase === 'finished'
  );
  const [displayPositions, setDisplayPositions] = useState<Record<string, number>>(
    () => {
      const init: Record<string, number> = {};
      for (const p of room.players) {
        init[p.playerId] = p.position;
      }
      return init;
    }
  );
  const [rematchBusy, setRematchBusy] = useState(false);

  const animatedMoveIdRef = useRef<string | null>(room.lastMove?.id ?? null);
  const animationTimersRef = useRef<number[]>([]);
  const prevTurnPlayerRef = useRef<string | null>(room.currentTurnPlayerId);

  const clearAnimationTimers = () => {
    animationTimersRef.current.forEach((id) => window.clearTimeout(id));
    animationTimersRef.current = [];
  };

  useEffect(() => {
    return () => {
      clearAnimationTimers();
    };
  }, []);

  // Sync displayPositions cleanly when game restarts or reconnects without an active animation
  useEffect(() => {
    if (!animatingMove && !room.lastMove) {
      const next: Record<string, number> = {};
      for (const p of room.players) {
        next[p.playerId] = p.position;
      }
      setDisplayPositions(next);
      setShowVictoryModal(room.phase === 'finished');
      animatedMoveIdRef.current = null;
    }
  }, [animatingMove, room.lastMove, room.phase, room.players]);

  // Animate new server-broadcast moves step-by-step
  useEffect(() => {
    const move: MoveRecord | null = room.lastMove;
    if (!move || move.id === animatedMoveIdRef.current) {
      return;
    }
    animatedMoveIdRef.current = move.id;

    // If reconnecting after a stale move, snap immediately to authoritative state
    if (Date.now() - move.timestamp > 4500) {
      const snapped: Record<string, number> = {};
      for (const p of room.players) {
        snapped[p.playerId] = p.position;
      }
      setDisplayPositions(snapped);
      setDiceValue(move.diceValue);
      setShowVictoryModal(room.phase === 'finished');
      return;
    }

    clearAnimationTimers();
    setAnimatingMove(true);
    setRolling(true);
    setShowVictoryModal(false);
    soundFx.playDiceRoll();

    const rollTimer = window.setTimeout(() => {
      setRolling(false);
      setDiceValue(move.diceValue);

      if (move.overshot) {
        soundFx.playOvershootThud();
        const doneTimer = window.setTimeout(() => {
          setAnimatingMove(false);
        }, 350);
        animationTimersRef.current.push(doneTimer);
        return;
      }

      const stepMs = 185;
      move.steps.forEach((sq, idx) => {
        const t = window.setTimeout(() => {
          setDisplayPositions((prev) => ({ ...prev, [move.playerId]: sq }));
          setHighlightedSquare(sq);
          soundFx.playTokenStep(idx);
        }, idx * stepMs);
        animationTimersRef.current.push(t);
      });

      const stepsDoneAt = move.steps.length * stepMs;

      if (move.transition) {
        const transitionTimer = window.setTimeout(() => {
          if (move.transition?.type === 'ladder') {
            soundFx.playLadderClimb();
          } else {
            soundFx.playSnakeSlide();
          }
          setDisplayPositions((prev) => ({
            ...prev,
            [move.playerId]: move.finalPosition,
          }));
          setHighlightedSquare(move.finalPosition);
        }, stepsDoneAt + 140);
        animationTimersRef.current.push(transitionTimer);

        const finishTimer = window.setTimeout(() => {
          setHighlightedSquare(null);
          setAnimatingMove(false);
          if (move.won) {
            soundFx.playVictoryFanfare();
            setShowVictoryModal(true);
          }
        }, stepsDoneAt + 620);
        animationTimersRef.current.push(finishTimer);
      } else {
        const finishTimer = window.setTimeout(() => {
          setHighlightedSquare(null);
          setAnimatingMove(false);
          if (move.won) {
            soundFx.playVictoryFanfare();
            setShowVictoryModal(true);
          }
        }, stepsDoneAt + 140);
        animationTimersRef.current.push(finishTimer);
      }
    }, 580);

    animationTimersRef.current.push(rollTimer);
  }, [room.lastMove, room.phase, room.players]);

  // Subtle audio cue when turn transitions to you
  useEffect(() => {
    if (
      !animatingMove &&
      room.phase === 'playing' &&
      room.currentTurnPlayerId === myPlayerId &&
      prevTurnPlayerRef.current !== myPlayerId
    ) {
      soundFx.playTurnAlert();
    }
    prevTurnPlayerRef.current = room.currentTurnPlayerId;
  }, [animatingMove, myPlayerId, room.currentTurnPlayerId, room.phase]);

  const toggleSoundMute = () => {
    const next = !sfxMuted;
    setSfxMuted(next);
    soundFx.setMuted(next);
  };

  const handleRollClick = async () => {
    soundFx.unlock();
    await onRollDice();
  };

  const handleRematchClick = async () => {
    setRematchBusy(true);
    try {
      await onRematch();
      setShowVictoryModal(false);
    } finally {
      setRematchBusy(false);
    }
  };

  const opponent = room.players.find((p) => p.playerId !== myPlayerId);
  const activePlayer = room.players.find(
    (p) => p.playerId === room.currentTurnPlayerId
  );
  const winner = room.players.find((p) => p.playerId === room.winnerPlayerId);

  const isMyTurn =
    room.phase === 'playing' && room.currentTurnPlayerId === myPlayerId;
  const diceDisabled =
    !isMyTurn || rolling || animatingMove || room.phase !== 'playing';

  const statusHeadline = (() => {
    if (room.phase === 'finished' && winner) {
      return winner.playerId === myPlayerId
        ? 'Victory! You reached Square 100'
        : `${winner.nickname} reached Square 100`;
    }
    if (animatingMove && room.lastMove) {
      const m = room.lastMove;
      if (m.overshot) {
        return `${m.nickname} rolled ${m.diceValue} — exact ${100 - m.fromPosition} needed`;
      }
      if (m.transition?.type === 'ladder') {
        return `${m.nickname} climbed ladder ${m.transition.from} → ${m.transition.to}!`;
      }
      if (m.transition?.type === 'snake') {
        return `${m.nickname} slid down snake ${m.transition.from} → ${m.transition.to}!`;
      }
      return `${m.nickname} rolled a ${m.diceValue}`;
    }
    if (isMyTurn) {
      return 'Your Turn — Roll the Dice';
    }
    return `Waiting for ${activePlayer?.nickname ?? 'Opponent'} to roll`;
  })();

  const renderPlayerHud = (player: PublicRoomState['players'][number]) => {
    const isMe = player.playerId === myPlayerId;
    const isTurn =
      room.phase === 'playing' && room.currentTurnPlayerId === player.playerId;
    const speaking = isMe ? voice.isSelfSpeaking : voice.isOpponentSpeaking;
    const pos = displayPositions[player.playerId] ?? player.position;

    return (
      <div
        key={player.playerId}
        className={`rounded-2xl border p-3 sm:p-3.5 transition-all flex items-center justify-between gap-3 ${
          isTurn
            ? 'bg-amber-500/10 border-amber-400/60 shadow-[0_0_24px_rgba(245,158,11,0.12)]'
            : 'bg-[#111827]/90 border-slate-800'
        }`}
      >
        <div className="flex items-center gap-3 min-w-0">
          <PlayerAvatar
            avatarId={player.avatarId}
            size="sm"
            speaking={speaking}
            slot={player.slot}
          />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-bold text-white font-display truncate">
                {player.nickname}
              </span>
              {isMe && (
                <span className="text-[11px] font-semibold text-amber-400 shrink-0">
                  (You)
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-[11px] text-slate-400 mt-0.5">
              <span>P{player.slot}</span>
              <span aria-hidden="true">·</span>
              {player.connected ? (
                <span className="inline-flex items-center gap-1 text-emerald-400">
                  <Wifi className="w-3 h-3" />
                  Online
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-amber-400">
                  <WifiOff className="w-3 h-3" />
                  Reconnecting
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="text-right shrink-0">
          <div className="font-mono-code text-lg sm:text-xl font-bold text-white leading-none">
            {pos === 0 ? 'Start' : `${pos}`}
          </div>
          <div className="text-[11px] text-slate-400 mt-0.5">
            {isTurn ? (
              <span className="text-amber-400 font-semibold">Active Turn</span>
            ) : (
              <span>/ 100</span>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen flex flex-col px-3 py-3 sm:px-6 sm:py-4 max-w-7xl mx-auto">
      {/* Compact Header */}
      <header className="flex items-center justify-between gap-3 pb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-amber-500 text-slate-950 flex items-center justify-center shrink-0">
            <Swords className="w-4 h-4" />
          </div>
          <span className="text-lg font-extrabold tracking-tight text-white font-display">
            DUEL
          </span>
          <span aria-hidden="true" className="text-slate-600">·</span>
          <span className="font-mono-code text-xs sm:text-sm font-semibold text-slate-300 tracking-wider">
            {room.roomCode}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={toggleSoundMute}
            aria-label={sfxMuted ? 'Unmute game sounds' : 'Mute game sounds'}
            title={sfxMuted ? 'Unmute game sounds' : 'Mute game sounds'}
            className="min-w-[44px] min-h-[44px] px-3 rounded-xl border border-slate-800 bg-slate-900/80 hover:bg-slate-800 text-slate-200 inline-flex items-center justify-center gap-1.5 text-xs font-medium transition-colors cursor-pointer"
          >
            {sfxMuted ? (
              <VolumeX className="w-4 h-4 text-rose-400" />
            ) : (
              <Volume2 className="w-4 h-4 text-emerald-400" />
            )}
            <span className="hidden sm:inline">
              {sfxMuted ? 'Sound Off' : 'Sound On'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => void onLeaveRoom()}
            className="min-h-[44px] px-3.5 rounded-xl border border-slate-800 bg-slate-900/80 hover:bg-rose-500/15 hover:border-rose-500/40 text-slate-200 hover:text-rose-200 text-xs sm:text-sm font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap cursor-pointer"
          >
            <LogOut className="w-4 h-4" />
            <span>Leave</span>
          </button>
        </div>
      </header>

      {/* Disconnected Opponent Warning Banner */}
      {opponent && !opponent.connected && (
        <div className="mb-3 rounded-xl bg-amber-500/10 border border-amber-500/40 px-4 py-2.5 text-xs sm:text-sm text-amber-200 flex items-center justify-between gap-2">
          <span>
            {opponent.nickname} disconnected. Waiting for them to reconnect...
          </span>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mb-3 rounded-xl bg-rose-500/10 border border-rose-500/30 px-4 py-2.5 text-xs sm:text-sm text-rose-200"
        >
          {error}
        </div>
      )}

      {/* Main Game Grid */}
      <main className="grid grid-cols-1 lg:grid-cols-12 gap-4 lg:gap-6 items-start flex-1">
        {/* Left/Center: Player HUD Strip (mobile) + Board */}
        <div className="lg:col-span-7 space-y-3">
          {/* Mobile HUD Pair */}
          <div className="grid grid-cols-2 gap-2.5 lg:hidden">
            {room.players.map(renderPlayerHud)}
          </div>

          {/* Turn & Event Banner */}
          <div
            className={`rounded-2xl px-4 py-2.5 border text-sm font-semibold flex items-center justify-between gap-3 transition-colors ${
              isMyTurn && !animatingMove
                ? 'bg-amber-500/15 border-amber-400/50 text-amber-200'
                : 'bg-[#111827]/90 border-slate-800 text-slate-200'
            }`}
          >
            <span className="truncate">{statusHeadline}</span>
            <span className="font-mono-code text-xs text-slate-400 shrink-0">
              Turn {room.turnNumber}
            </span>
          </div>

          <SnakeAndLaddersBoard
            players={room.players}
            displayPositions={displayPositions}
            myPlayerId={myPlayerId}
            activePlayerId={room.currentTurnPlayerId}
            highlightedSquare={highlightedSquare}
          />
        </div>

        {/* Right Arena Sidebar (Thumb-zone below board on mobile) */}
        <div className="lg:col-span-5 space-y-4">
          {/* Desktop Player HUD Stack */}
          <div className="hidden lg:grid grid-cols-1 gap-3">
            {room.players.map(renderPlayerHud)}
          </div>

          {/* Dice Rolling Area */}
          <div className="rounded-2xl bg-[#111827]/95 border border-slate-800 p-4 sm:p-5 shadow-xl space-y-3">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span className="font-medium text-slate-300">Dice Arena</span>
              <span>Exact roll needed for 100</span>
            </div>

            <Dice3D
              value={diceValue}
              rolling={rolling}
              disabled={diceDisabled}
              isMyTurn={isMyTurn}
              onRoll={() => void handleRollClick()}
            />

            {room.phase === 'finished' && (
              <button
                type="button"
                onClick={() => void handleRematchClick()}
                disabled={rematchBusy}
                className="w-full min-h-[46px] rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm inline-flex items-center justify-center gap-2 transition-colors cursor-pointer"
              >
                <RotateCcw className="w-4 h-4" />
                <span>{rematchBusy ? 'Starting Rematch...' : 'Play Again'}</span>
              </button>
            )}
          </div>

          {/* Live WebRTC Voice Chat */}
          <VoiceControls
            voice={voice}
            opponentNickname={opponent?.nickname}
            compact
          />

          {/* Room Text Chat */}
          <ChatBox
            messages={room.chatMessages}
            myPlayerId={myPlayerId}
            onSendMessage={onSendMessage}
            compact
          />

          {/* Game History */}
          <div className="rounded-2xl bg-[#111827]/90 border border-slate-800 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <History className="w-4 h-4 text-slate-400" />
                <h2 className="text-sm font-semibold text-slate-100">
                  Move History
                </h2>
              </div>
              <span className="font-mono-code text-xs text-slate-500">
                {room.history.length} moves
              </span>
            </div>

            {room.history.length === 0 ? (
              <p className="text-xs text-slate-500 py-3 text-center">
                Roll the dice to begin the duel.
              </p>
            ) : (
              <ul className="space-y-2 max-h-48 overflow-y-auto pr-1">
                {room.history.map((m) => (
                  <li
                    key={m.id}
                    className="flex items-center justify-between gap-2 text-xs py-1.5 px-2.5 rounded-xl bg-slate-900/70 border border-slate-800/70"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-mono-code text-slate-500 shrink-0">
                        #{m.turnNumber}
                      </span>
                      <span className="font-semibold text-slate-200 truncate">
                        {m.nickname}
                      </span>
                      <span className="text-slate-400 shrink-0">
                        rolled <strong className="text-amber-300">{m.diceValue}</strong>
                      </span>
                    </div>

                    <div className="flex items-center gap-1 shrink-0 font-mono-code">
                      {m.overshot ? (
                        <span className="text-slate-400">Held at {m.fromPosition}</span>
                      ) : m.transition?.type === 'ladder' ? (
                        <span className="inline-flex items-center gap-0.5 text-emerald-400 font-semibold">
                          <ArrowUpRight className="w-3.5 h-3.5" />
                          {m.transition.from}→{m.transition.to}
                        </span>
                      ) : m.transition?.type === 'snake' ? (
                        <span className="inline-flex items-center gap-0.5 text-rose-400 font-semibold">
                          <TrendingDown className="w-3.5 h-3.5" />
                          {m.transition.from}→{m.transition.to}
                        </span>
                      ) : (
                        <span className="text-slate-300">
                          {m.fromPosition}→{m.finalPosition}
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </main>

      {/* Winner Celebration Modal */}
      {showVictoryModal && room.phase === 'finished' && winner && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="winner-title"
        >
          <div className="w-full max-w-md rounded-3xl bg-[#111827] border border-amber-400/40 p-6 sm:p-7 shadow-[0_24px_80px_rgba(245,158,11,0.22)] text-center space-y-5">
            <div className="w-16 h-16 rounded-2xl bg-amber-500/20 border border-amber-400/50 text-amber-400 flex items-center justify-center mx-auto">
              <Trophy className="w-8 h-8" />
            </div>

            <div className="space-y-1.5">
              <p className="text-xs font-semibold uppercase tracking-widest text-amber-400">
                Match Complete
              </p>
              <h2
                id="winner-title"
                className="text-2xl sm:text-3xl font-extrabold text-white font-display"
              >
                {winner.playerId === myPlayerId
                  ? 'You Won the Duel!'
                  : `${winner.nickname} Wins!`}
              </h2>
              <p className="text-sm text-slate-400">
                Reached Square 100 in {room.history.length} total rolls.
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-3 pt-2">
              <button
                type="button"
                onClick={() => void handleRematchClick()}
                disabled={rematchBusy}
                className="flex-1 min-h-[48px] px-4 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm inline-flex items-center justify-center gap-2 transition-colors cursor-pointer"
              >
                <RotateCcw className="w-4 h-4" />
                <span>{rematchBusy ? 'Starting...' : 'Play Again'}</span>
              </button>

              <button
                type="button"
                onClick={() => setShowVictoryModal(false)}
                className="min-h-[48px] px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-sm transition-colors cursor-pointer"
              >
                View Board
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
