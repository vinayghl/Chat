import React from 'react';
import { Mic, MicOff, Volume2, AlertCircle, PhoneOff, Radio } from 'lucide-react';
import type { UseWebRTCVoiceReturn } from '../voice/useWebRTCVoice.ts';

interface VoiceControlsProps {
  voice: UseWebRTCVoiceReturn;
  opponentNickname?: string;
  compact?: boolean;
}

export const VoiceControls: React.FC<VoiceControlsProps> = ({
  voice,
  opponentNickname,
  compact = false,
}) => {
  const {
    micEnabled,
    micMuted,
    permissionError,
    voiceStatus,
    isSelfSpeaking,
    isOpponentSpeaking,
    audioPlaybackBlocked,
    enableMicrophone,
    disableMicrophone,
    toggleMute,
    resumeRemoteAudio,
  } = voice;

  const statusMeta = (() => {
    switch (voiceStatus) {
      case 'connected':
        return { label: 'Voice Live', color: 'text-emerald-400', dot: 'bg-emerald-400' };
      case 'connecting':
        return { label: 'Connecting Audio', color: 'text-amber-300', dot: 'bg-amber-400' };
      case 'reconnecting':
        return { label: 'Reconnecting Audio', color: 'text-amber-400', dot: 'bg-amber-400' };
      case 'waiting-peer':
        return { label: 'Waiting for Friend', color: 'text-slate-400', dot: 'bg-slate-500' };
      case 'disconnected':
        return { label: 'Audio Disconnected', color: 'text-rose-400', dot: 'bg-rose-400' };
      default:
        return { label: 'Audio Idle', color: 'text-slate-400', dot: 'bg-slate-500' };
    }
  })();

  return (
    <div
      className={`rounded-2xl bg-[#111827]/90 border border-slate-800 ${
        compact ? 'p-3.5' : 'p-4 sm:p-5'
      } space-y-3`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Radio className={`w-4 h-4 shrink-0 ${statusMeta.color}`} />
          <span className="text-sm font-semibold text-slate-100 truncate">
            Live Voice Chat
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-xs font-medium shrink-0">
          <span className={`w-2 h-2 rounded-full ${statusMeta.dot}`} />
          <span className={statusMeta.color}>{statusMeta.label}</span>
        </div>
      </div>

      {/* Live Speaking Activity Row */}
      <div className="flex items-center justify-between gap-3 text-xs text-slate-400 bg-slate-900/70 rounded-xl px-3 py-2 border border-slate-800/80">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-slate-300 font-medium">You:</span>
          {!micEnabled ? (
            <span>Mic off</span>
          ) : micMuted ? (
            <span className="text-amber-300">Muted</span>
          ) : isSelfSpeaking ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-400 font-medium">
              <span className="inline-flex items-end gap-0.5 h-3">
                <span className="w-0.5 h-full bg-emerald-400 rounded animate-voice-bar-1" />
                <span className="w-0.5 h-full bg-emerald-400 rounded animate-voice-bar-2" />
                <span className="w-0.5 h-full bg-emerald-400 rounded animate-voice-bar-3" />
              </span>
              Speaking
            </span>
          ) : (
            <span className="text-slate-300">Listening</span>
          )}
        </div>

        <span aria-hidden="true" className="text-slate-700">|</span>

        <div className="flex items-center gap-2 min-w-0">
          <span className="text-slate-300 font-medium truncate max-w-[90px]">
            {opponentNickname ?? 'Friend'}:
          </span>
          {isOpponentSpeaking ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-400 font-medium">
              <span className="inline-flex items-end gap-0.5 h-3">
                <span className="w-0.5 h-full bg-emerald-400 rounded animate-voice-bar-1" />
                <span className="w-0.5 h-full bg-emerald-400 rounded animate-voice-bar-2" />
                <span className="w-0.5 h-full bg-emerald-400 rounded animate-voice-bar-3" />
              </span>
              Speaking
            </span>
          ) : (
            <span>{voiceStatus === 'connected' ? 'Quiet' : '—'}</span>
          )}
        </div>
      </div>

      {audioPlaybackBlocked && (
        <button
          type="button"
          onClick={resumeRemoteAudio}
          className="w-full min-h-[44px] px-3 rounded-xl bg-amber-500/15 border border-amber-400/40 text-amber-200 text-xs font-semibold flex items-center justify-center gap-2 hover:bg-amber-500/25 transition-colors cursor-pointer"
        >
          <Volume2 className="w-4 h-4" />
          <span>Tap to Unblock Opponent Audio</span>
        </button>
      )}

      {permissionError && (
        <div className="rounded-xl bg-rose-500/10 border border-rose-500/30 px-3 py-2.5 text-xs text-rose-200 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <span>{permissionError}</span>
        </div>
      )}

      {/* Microphone Action Controls */}
      <div className="flex flex-wrap items-center gap-2">
        {!micEnabled ? (
          <button
            type="button"
            onClick={() => void enableMicrophone()}
            className="flex-1 min-h-[44px] px-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap cursor-pointer"
          >
            <Mic className="w-4 h-4" />
            <span>{permissionError ? 'Retry Microphone' : 'Enable Microphone'}</span>
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={toggleMute}
              aria-pressed={micMuted}
              className={`flex-1 min-h-[44px] px-4 rounded-xl font-semibold text-sm inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap cursor-pointer ${
                micMuted
                  ? 'bg-amber-500 hover:bg-amber-400 text-slate-950'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700'
              }`}
            >
              {micMuted ? (
                <>
                  <MicOff className="w-4 h-4" />
                  <span>Unmute Mic</span>
                </>
              ) : (
                <>
                  <Mic className="w-4 h-4 text-emerald-400" />
                  <span>Mute Mic</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={disableMicrophone}
              aria-label="Turn off microphone"
              className="min-h-[44px] px-3.5 rounded-xl bg-slate-900 hover:bg-rose-500/15 text-slate-300 hover:text-rose-300 border border-slate-700 hover:border-rose-500/40 text-sm font-medium inline-flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap cursor-pointer"
            >
              <PhoneOff className="w-4 h-4" />
              <span>Mic Off</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
};
