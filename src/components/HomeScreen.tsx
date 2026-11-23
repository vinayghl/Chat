import React, { useState } from 'react';
import { HelpCircle, Plus, LogIn, Swords, Wifi, WifiOff, RefreshCw } from 'lucide-react';
import { AVATAR_OPTIONS } from '../shared/gameConstants.ts';
import { PlayerAvatar } from './PlayerAvatar.tsx';
import { HowToPlayModal } from './HowToPlayModal.tsx';

interface HomeScreenProps {
  socketConnected: boolean;
  connectionError: string | null;
  onRetryConnection: () => void;
  initialRoomCode: string;
  onCreateRoom: (nickname: string, avatarId: string) => Promise<void>;
  onJoinRoom: (roomCode: string, nickname: string, avatarId: string) => Promise<void>;
  error: string | null;
  clearError: () => void;
}

export const HomeScreen: React.FC<HomeScreenProps> = ({
  socketConnected,
  connectionError,
  onRetryConnection,
  initialRoomCode,
  onCreateRoom,
  onJoinRoom,
  error,
  clearError,
}) => {
  const [nickname, setNickname] = useState('');
  const [roomCode, setRoomCode] = useState(initialRoomCode);
  const [avatarId, setAvatarId] = useState<string>(AVATAR_OPTIONS[0].id);
  const [submitting, setSubmitting] = useState<'create' | 'join' | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [showRules, setShowRules] = useState(false);

  const displayedError = localError || error;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();
    setLocalError(null);
    const trimmed = nickname.trim();
    if (!trimmed) {
      setLocalError('Enter your nickname to create a room.');
      return;
    }
    setSubmitting('create');
    try {
      await onCreateRoom(trimmed, avatarId);
    } finally {
      setSubmitting(null);
    }
  };

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();
    setLocalError(null);
    const trimmedNick = nickname.trim();
    const cleanedCode = roomCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!trimmedNick) {
      setLocalError('Enter your nickname before joining.');
      return;
    }
    if (cleanedCode.length !== 6) {
      setLocalError('Enter the 6-character room code from your friend.');
      return;
    }
    setSubmitting('join');
    try {
      await onJoinRoom(cleanedCode, trimmedNick, avatarId);
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <div className="min-h-screen flex flex-col justify-between px-4 py-5 sm:px-6 lg:px-8 max-w-6xl mx-auto">
      {/* 3-Zone Top Bar */}
      <header className="flex items-center justify-between gap-4 py-2">
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="w-9 h-9 rounded-xl bg-amber-500 text-slate-950 flex items-center justify-center shadow-lg shadow-amber-500/20">
            <Swords className="w-5 h-5" />
          </div>
          <span className="text-xl font-extrabold tracking-tight text-white font-display whitespace-nowrap">
            DUEL
          </span>
        </div>

        <div className="flex items-center gap-2 text-xs text-slate-400">
          {socketConnected ? (
            <>
              <Wifi className="w-3.5 h-3.5 text-emerald-400" />
              <span className="hidden sm:inline">Server Ready</span>
            </>
          ) : (
            <button
              type="button"
              onClick={onRetryConnection}
              className="inline-flex items-center gap-1.5 text-amber-300 hover:text-amber-200 cursor-pointer"
            >
              <WifiOff className="w-3.5 h-3.5" />
              <span>Connecting...</span>
              <RefreshCw className="w-3 h-3" />
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={() => setShowRules(true)}
          className="min-h-[44px] px-4 rounded-xl border border-slate-700/80 bg-slate-900/70 hover:bg-slate-800 text-slate-200 text-sm font-medium inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <HelpCircle className="w-4 h-4 text-amber-400" />
          <span>How to Play</span>
        </button>
      </header>

      {/* Main Arena Hero & Controls */}
      <main className="my-auto py-6 sm:py-10">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-10 items-center">
          {/* Brand & Premise Column */}
          <div className="lg:col-span-5 space-y-5">
            <p className="text-sm font-medium text-amber-400 tracking-wide">
              Two Friends. One Battle.
            </p>
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight text-white font-display leading-[1.06] text-balance">
              Classic Snake & Ladders, live with voice.
            </h1>
            <p className="text-base text-slate-300 leading-relaxed max-w-md">
              Open a private two-player board in seconds. Share your 6-character code, turn on your microphone, and race to square 100 in real time.
            </p>

            <div className="pt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-400">
              <span>No accounts</span>
              <span aria-hidden="true">·</span>
              <span>Private 2-player rooms</span>
              <span aria-hidden="true">·</span>
              <span>Live WebRTC audio</span>
            </div>
          </div>

          {/* Interactive Entry Card */}
          <div className="lg:col-span-7">
            <div className="bg-[#111827]/90 backdrop-blur-md border border-slate-800 rounded-3xl p-5 sm:p-7 shadow-2xl space-y-6">
              {/* Nickname + Avatar Identity Setup */}
              <div className="space-y-4">
                <div>
                  <label
                    htmlFor="nickname-input"
                    className="block text-sm font-medium text-slate-200 mb-2"
                  >
                    Enter Your Nickname
                  </label>
                  <input
                    id="nickname-input"
                    type="text"
                    maxLength={18}
                    value={nickname}
                    onChange={(e) => {
                      setNickname(e.target.value);
                      if (displayedError) {
                        setLocalError(null);
                        clearError();
                      }
                    }}
                    placeholder="e.g. Alex"
                    autoComplete="nickname"
                    className="w-full min-h-[48px] px-4 rounded-xl bg-slate-900/90 border border-slate-700 focus:border-amber-400 focus:outline-none text-white placeholder:text-slate-500 text-base transition-colors"
                  />
                </div>

                <div>
                  <span className="block text-xs font-medium text-slate-400 mb-2">
                    Choose Your Emblem
                  </span>
                  <div className="grid grid-cols-4 gap-2.5">
                    {AVATAR_OPTIONS.map((opt) => {
                      const active = avatarId === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => setAvatarId(opt.id)}
                          aria-label={opt.label}
                          aria-pressed={active}
                          className={`min-h-[56px] rounded-xl border flex flex-col items-center justify-center gap-1 p-2 transition-all cursor-pointer ${
                            active
                              ? 'border-amber-400 bg-amber-500/10 shadow-[0_0_0_1px_rgba(245,158,11,0.4)]'
                              : 'border-slate-800 bg-slate-900/60 hover:border-slate-700'
                          }`}
                        >
                          <PlayerAvatar avatarId={opt.id} size="sm" />
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {(displayedError || (!socketConnected && connectionError)) && (
                <div
                  role="alert"
                  className="rounded-xl bg-rose-500/10 border border-rose-500/30 px-4 py-3 text-sm text-rose-200 flex items-center justify-between gap-3"
                >
                  <span>{displayedError || connectionError}</span>
                  {!socketConnected && (
                    <button
                      type="button"
                      onClick={onRetryConnection}
                      className="px-3 py-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-xs font-semibold text-rose-100 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      Retry
                    </button>
                  )}
                </div>
              )}

              {/* Create Room vs Join Room Actions */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-slate-800/80">
                {/* Create Room */}
                <form
                  onSubmit={handleCreate}
                  className="flex flex-col justify-between gap-3 p-4 rounded-2xl bg-slate-900/60 border border-slate-800"
                >
                  <div>
                    <h2 className="text-base font-bold text-white font-display">
                      Create Room
                    </h2>
                    <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                      Start a private match and invite one friend with a 6-character code.
                    </p>
                  </div>
                  <button
                    type="submit"
                    disabled={submitting !== null}
                    className="w-full min-h-[48px] px-4 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-50 disabled:cursor-not-allowed text-slate-950 font-bold text-sm inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap cursor-pointer"
                  >
                    <Plus className="w-4 h-4" />
                    <span>
                      {submitting === 'create' ? 'Creating...' : 'Create Room'}
                    </span>
                  </button>
                </form>

                {/* Join Room */}
                <form
                  onSubmit={handleJoin}
                  className="flex flex-col justify-between gap-3 p-4 rounded-2xl bg-slate-900/60 border border-slate-800"
                >
                  <div className="space-y-2.5">
                    <h2 className="text-base font-bold text-white font-display">
                      Join Room
                    </h2>
                    <div>
                      <label htmlFor="room-code-input" className="sr-only">
                        Enter Room Code
                      </label>
                      <input
                        id="room-code-input"
                        type="text"
                        maxLength={6}
                        value={roomCode}
                        onChange={(e) => {
                          setRoomCode(
                            e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')
                          );
                          if (displayedError) {
                            setLocalError(null);
                            clearError();
                          }
                        }}
                        placeholder="6-CHAR CODE"
                        className="w-full min-h-[44px] px-3.5 rounded-xl bg-slate-950/80 border border-slate-700 focus:border-emerald-400 focus:outline-none text-white placeholder:text-slate-500 font-mono-code text-base tracking-[0.22em] uppercase text-center"
                      />
                    </div>
                  </div>
                  <button
                    type="submit"
                    disabled={submitting !== null}
                    className="w-full min-h-[48px] px-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed text-slate-950 font-bold text-sm inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap cursor-pointer"
                  >
                    <LogIn className="w-4 h-4" />
                    <span>{submitting === 'join' ? 'Joining...' : 'Join Room'}</span>
                  </button>
                </form>
              </div>
            </div>
          </div>
        </div>
      </main>

      <footer className="py-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 border-t border-slate-800/60">
        <span>DUEL · Ephemeral private rooms</span>
        <span>Rooms expire automatically when inactive</span>
      </footer>

      <HowToPlayModal open={showRules} onClose={() => setShowRules(false)} />
    </div>
  );
};
