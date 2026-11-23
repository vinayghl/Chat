import React, { useState } from 'react';
import {
  Check,
  Copy,
  Link2,
  LogOut,
  Play,
  Swords,
  Loader2,
  Wifi,
  WifiOff,
  Mic,
  MicOff,
} from 'lucide-react';
import type { PublicRoomState } from '../shared/gameConstants.ts';
import type { UseWebRTCVoiceReturn } from '../voice/useWebRTCVoice.ts';
import { PlayerAvatar } from './PlayerAvatar.tsx';
import { VoiceControls } from './VoiceControls.tsx';
import { ChatBox } from './ChatBox.tsx';

interface LobbyScreenProps {
  room: PublicRoomState;
  myPlayerId: string;
  voice: UseWebRTCVoiceReturn;
  onToggleReady: () => Promise<void>;
  onStartGame: () => Promise<void>;
  onSendMessage: (text: string) => Promise<void>;
  onLeaveRoom: () => Promise<void>;
  error: string | null;
}

export const LobbyScreen: React.FC<LobbyScreenProps> = ({
  room,
  myPlayerId,
  voice,
  onToggleReady,
  onStartGame,
  onSendMessage,
  onLeaveRoom,
  error,
}) => {
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [busyAction, setBusyAction] = useState<'ready' | 'start' | 'leave' | null>(null);

  const me = room.players.find((p) => p.playerId === myPlayerId);
  const opponent = room.players.find((p) => p.playerId !== myPlayerId);
  const player1 = room.players.find((p) => p.slot === 1);
  const player2 = room.players.find((p) => p.slot === 2);

  const bothConnected =
    room.players.length === 2 && room.players.every((p) => p.connected);
  const bothReady =
    room.players.length === 2 && room.players.every((p) => p.ready);
  const canStart = bothConnected && bothReady;

  const inviteUrl = `${window.location.origin}/?room=${room.roomCode}`;

  const copyText = async (text: string, which: 'code' | 'link') => {
    try {
      await navigator.clipboard.writeText(text);
      if (which === 'code') {
        setCopiedCode(true);
        setTimeout(() => setCopiedCode(false), 1800);
      } else {
        setCopiedLink(true);
        setTimeout(() => setCopiedLink(false), 1800);
      }
    } catch {
      // Clipboard fallback ignored
    }
  };

  const handleReady = async () => {
    setBusyAction('ready');
    try {
      await onToggleReady();
    } finally {
      setBusyAction(null);
    }
  };

  const handleStart = async () => {
    setBusyAction('start');
    try {
      await onStartGame();
    } finally {
      setBusyAction(null);
    }
  };

  const handleLeave = async () => {
    setBusyAction('leave');
    try {
      await onLeaveRoom();
    } finally {
      setBusyAction(null);
    }
  };

  const renderPlayerCard = (
    player: PublicRoomState['players'][number] | undefined,
    slotNumber: 1 | 2
  ) => {
    if (!player) {
      return (
        <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/40 p-5 flex flex-col items-center justify-center text-center min-h-[168px] gap-3">
          <div className="w-12 h-12 rounded-2xl bg-slate-800/80 flex items-center justify-center text-amber-400">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-200">
              Waiting for Player {slotNumber}...
            </p>
            <p className="text-xs text-slate-400 mt-1">
              Share the room code or invite link above
            </p>
          </div>
        </div>
      );
    }

    const isMe = player.playerId === myPlayerId;
    const speaking = isMe ? voice.isSelfSpeaking : voice.isOpponentSpeaking;

    return (
      <div
        className={`rounded-2xl border p-5 transition-colors min-h-[168px] flex flex-col justify-between gap-4 ${
          player.ready
            ? 'bg-emerald-500/[0.06] border-emerald-500/40'
            : 'bg-[#111827]/90 border-slate-800'
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3.5 min-w-0">
            <PlayerAvatar
              avatarId={player.avatarId}
              size="lg"
              speaking={speaking}
              slot={player.slot}
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-slate-400">
                  Player {player.slot}
                </span>
                {isMe && (
                  <span className="text-xs font-semibold text-amber-400">
                    · You
                  </span>
                )}
              </div>
              <h3 className="text-lg font-bold text-white font-display truncate mt-0.5">
                {player.nickname}
              </h3>
              <div className="flex items-center gap-2 text-xs mt-1">
                {player.connected ? (
                  <span className="inline-flex items-center gap-1 text-emerald-400">
                    <Wifi className="w-3.5 h-3.5" />
                    Connected
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-amber-400">
                    <WifiOff className="w-3.5 h-3.5" />
                    Reconnecting...
                  </span>
                )}
                <span aria-hidden="true" className="text-slate-700">·</span>
                {player.micEnabled ? (
                  player.micMuted ? (
                    <span className="inline-flex items-center gap-1 text-amber-300">
                      <MicOff className="w-3.5 h-3.5" />
                      Muted
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-emerald-400">
                      <Mic className="w-3.5 h-3.5" />
                      Mic On
                    </span>
                  )
                ) : (
                  <span className="text-slate-500">Mic Off</span>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between pt-3 border-t border-slate-800/80 text-xs">
          <span className="text-slate-400">Match Status</span>
          <span
            className={`font-semibold ${
              player.ready ? 'text-emerald-400' : 'text-slate-400'
            }`}
          >
            {player.ready ? 'Ready to Battle' : 'Not Ready'}
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen flex flex-col px-4 py-5 sm:px-6 lg:px-8 max-w-5xl mx-auto">
      {/* Top Bar */}
      <header className="flex items-center justify-between gap-4 py-2">
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="w-9 h-9 rounded-xl bg-amber-500 text-slate-950 flex items-center justify-center">
            <Swords className="w-5 h-5" />
          </div>
          <span className="text-xl font-extrabold tracking-tight text-white font-display">
            DUEL
          </span>
        </div>

        <button
          type="button"
          onClick={() => void handleLeave()}
          disabled={busyAction === 'leave'}
          className="min-h-[44px] px-4 rounded-xl border border-slate-700/80 bg-slate-900/70 hover:bg-rose-500/15 hover:border-rose-500/40 text-slate-200 hover:text-rose-200 text-sm font-medium inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <LogOut className="w-4 h-4" />
          <span>Leave Room</span>
        </button>
      </header>

      <main className="my-auto py-6 space-y-6">
        {/* Room Code & Invite Banner */}
        <section className="rounded-3xl bg-[#111827]/90 border border-slate-800 p-5 sm:p-7 shadow-xl flex flex-col md:flex-row md:items-center justify-between gap-5">
          <div>
            <p className="text-xs font-medium text-amber-400 uppercase tracking-wider">
              Private Lobby · {room.players.length}/2 Players
            </p>
            <div className="flex items-center gap-3 mt-1.5">
              <span className="font-mono-code text-3xl sm:text-4xl font-bold tracking-[0.2em] text-white">
                {room.roomCode}
              </span>
              <button
                type="button"
                onClick={() => void copyText(room.roomCode, 'code')}
                aria-label="Copy room code"
                className="min-w-[44px] min-h-[44px] px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium inline-flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                {copiedCode ? (
                  <>
                    <Check className="w-4 h-4 text-emerald-400" />
                    <span className="text-emerald-300">Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-4 h-4" />
                    <span>Code</span>
                  </>
                )}
              </button>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void copyText(inviteUrl, 'link')}
            className="min-h-[48px] px-5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap cursor-pointer"
          >
            {copiedLink ? (
              <>
                <Check className="w-4 h-4" />
                <span>Invitation Link Copied</span>
              </>
            ) : (
              <>
                <Link2 className="w-4 h-4" />
                <span>Copy Invitation Link</span>
              </>
            )}
          </button>
        </section>

        {error && (
          <div
            role="alert"
            className="rounded-xl bg-rose-500/10 border border-rose-500/30 px-4 py-3 text-sm text-rose-200"
          >
            {error}
          </div>
        )}

        {/* Two Players Grid */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {renderPlayerCard(player1, 1)}
          {renderPlayerCard(player2, 2)}
        </section>

        {/* Voice Check & Ready/Start Controls */}
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
          <div className="lg:col-span-6">
            <VoiceControls voice={voice} opponentNickname={opponent?.nickname} />
          </div>

          <div className="lg:col-span-6 rounded-2xl bg-[#111827]/90 border border-slate-800 p-4 sm:p-5 flex flex-col justify-between gap-4">
            <div>
              <h2 className="text-base font-bold text-white font-display">
                Match Readiness
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                {room.players.length < 2
                  ? 'Waiting for your friend to join using the room code.'
                  : !bothReady
                    ? 'Both players need to tap Ready before starting the match.'
                    : 'Both players are ready! Start the match whenever you are set.'}
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-3">
              <button
                type="button"
                onClick={() => void handleReady()}
                disabled={busyAction === 'ready'}
                className={`flex-1 min-h-[48px] px-4 rounded-xl font-bold text-sm inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap cursor-pointer ${
                  me?.ready
                    ? 'bg-emerald-500/15 border border-emerald-400/50 text-emerald-300 hover:bg-emerald-500/25'
                    : 'bg-slate-800 hover:bg-slate-700 text-white border border-slate-700'
                }`}
              >
                <Check className="w-4 h-4" />
                <span>{me?.ready ? 'Ready ✓ (Tap to Cancel)' : 'Mark Ready'}</span>
              </button>

              <button
                type="button"
                onClick={() => void handleStart()}
                disabled={!canStart || busyAction === 'start'}
                className="flex-1 min-h-[48px] px-5 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed text-slate-950 font-bold text-sm inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap cursor-pointer"
              >
                <Play className="w-4 h-4 fill-current" />
                <span>{busyAction === 'start' ? 'Starting...' : 'Start Game'}</span>
              </button>
            </div>
          </div>
        </section>

        {/* Room Text Chat */}
        <section>
          <ChatBox
            messages={room.chatMessages}
            myPlayerId={myPlayerId}
            onSendMessage={onSendMessage}
          />
        </section>
      </main>
    </div>
  );
};
