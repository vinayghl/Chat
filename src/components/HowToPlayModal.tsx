import React from 'react';
import { X, Dices, Mic, ArrowUpRight, AlertTriangle, Trophy } from 'lucide-react';

interface HowToPlayModalProps {
  open: boolean;
  onClose: () => void;
}

export const HowToPlayModal: React.FC<HowToPlayModalProps> = ({
  open,
  onClose,
}) => {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="how-to-play-title"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-lg bg-[#111827] border border-slate-700/70 rounded-t-3xl sm:rounded-2xl p-6 shadow-2xl max-h-[88vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between pb-4 border-b border-slate-800">
          <div>
            <h2
              id="how-to-play-title"
              className="text-xl font-bold text-slate-50 font-display"
            >
              How to Play DUEL
            </h2>
            <p className="text-sm text-slate-400 mt-0.5">
              Private 2-player Snake & Ladders with live voice
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close rules"
            className="min-w-[44px] min-h-[44px] rounded-xl flex items-center justify-center text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="mt-5 space-y-4 text-sm text-slate-300 leading-relaxed">
          <div className="flex items-start gap-3.5">
            <div className="w-9 h-9 rounded-xl bg-amber-500/15 text-amber-400 flex items-center justify-center shrink-0 mt-0.5">
              <Dices className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-semibold text-slate-100">1. Create or Join a Room</h3>
              <p className="text-slate-400 mt-0.5">
                Player 1 creates a temporary room and shares the 6-character code or invite link. Player 2 joins from any phone or computer—no accounts needed.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3.5">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/15 text-emerald-400 flex items-center justify-center shrink-0 mt-0.5">
              <ArrowUpRight className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-semibold text-slate-100">2. Climb Ladders</h3>
              <p className="text-slate-400 mt-0.5">
                Land at the base of any ladder (4, 13, 33, 42, 50, 62, 74) to climb straight up to a higher square.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3.5">
            <div className="w-9 h-9 rounded-xl bg-rose-500/15 text-rose-400 flex items-center justify-center shrink-0 mt-0.5">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-semibold text-slate-100">3. Dodge Snakes</h3>
              <p className="text-slate-400 mt-0.5">
                Land on a snake head (27, 40, 43, 54, 66, 76, 89, 99) and your token slides down to its tail.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3.5">
            <div className="w-9 h-9 rounded-xl bg-amber-500/15 text-amber-300 flex items-center justify-center shrink-0 mt-0.5">
              <Trophy className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-semibold text-slate-100">4. Exact Roll to 100</h3>
              <p className="text-slate-400 mt-0.5">
                You must roll the exact number needed to land on square 100. Rolling higher keeps your token in place until your next turn.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3.5">
            <div className="w-9 h-9 rounded-xl bg-sky-500/15 text-sky-400 flex items-center justify-center shrink-0 mt-0.5">
              <Mic className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-semibold text-slate-100">5. Live Voice Chat</h3>
              <p className="text-slate-400 mt-0.5">
                Tap Enable Microphone in the lobby or during play to talk live over WebRTC peer-to-peer audio. You can mute or disable your mic anytime.
              </p>
            </div>
          </div>
        </div>

        <div className="mt-6 pt-4 border-t border-slate-800">
          <button
            type="button"
            onClick={onClose}
            className="w-full min-h-[44px] rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold text-sm transition-colors cursor-pointer"
          >
            Got It
          </button>
        </div>
      </div>
    </div>
  );
};
