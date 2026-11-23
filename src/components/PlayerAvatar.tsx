import React from 'react';
import { AVATAR_OPTIONS } from '../shared/gameConstants.ts';

interface PlayerAvatarProps {
  avatarId: string;
  size?: 'sm' | 'md' | 'lg';
  speaking?: boolean;
  slot?: 1 | 2;
}

export const PlayerAvatar: React.FC<PlayerAvatarProps> = ({
  avatarId,
  size = 'md',
  speaking = false,
  slot,
}) => {
  const option =
    AVATAR_OPTIONS.find((a) => a.id === avatarId) ??
    AVATAR_OPTIONS[slot === 2 ? 1 : 0];

  const dims =
    size === 'sm'
      ? 'w-9 h-9'
      : size === 'lg'
        ? 'w-16 h-16'
        : 'w-11 h-11';

  const iconSize = size === 'sm' ? 18 : size === 'lg' ? 32 : 22;

  return (
    <div className="relative inline-flex items-center justify-center shrink-0">
      {speaking && (
        <span
          aria-hidden="true"
          className="absolute -inset-1 rounded-2xl border-2 border-emerald-400/90 shadow-[0_0_16px_rgba(16,185,129,0.45)] animate-pulse"
        />
      )}
      <div
        className={`${dims} rounded-xl flex items-center justify-center border border-white/15 shadow-inner relative overflow-hidden`}
        style={{
          background: `linear-gradient(135deg, ${option.primary} 0%, ${option.secondary} 100%)`,
        }}
      >
        {option.id === 'crimson-crown' && (
          <svg
            width={iconSize}
            height={iconSize}
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M3 18h18l-1.5-9-4.5 4-3-6-3 6-4.5-4L3 18z"
              fill="rgba(255,255,255,0.92)"
            />
            <rect x="4" y="19.5" width="16" height="2" rx="1" fill="rgba(255,255,255,0.75)" />
          </svg>
        )}
        {option.id === 'emerald-viper' && (
          <svg
            width={iconSize}
            height={iconSize}
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M12 3L4 8v6c0 4.2 3.4 6.8 8 7.8 4.6-1 8-3.6 8-7.8V8l-8-5z"
              fill="rgba(255,255,255,0.22)"
              stroke="rgba(255,255,255,0.92)"
              strokeWidth="1.8"
            />
            <path
              d="M9 10.5l3 3 3-3M12 13.5V17"
              stroke="rgba(255,255,255,0.95)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
        {option.id === 'amber-lion' && (
          <svg
            width={iconSize}
            height={iconSize}
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <polygon
              points="12,3 14.9,8.8 21.2,9.7 16.6,14.1 17.7,20.4 12,17.4 6.3,20.4 7.4,14.1 2.8,9.7 9.1,8.8"
              fill="rgba(255,255,255,0.92)"
            />
          </svg>
        )}
        {option.id === 'cobalt-wolf' && (
          <svg
            width={iconSize}
            height={iconSize}
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M5 5l4.5 3.5h5L19 5l1 7-4 7H8l-4-7 1-7z"
              fill="rgba(255,255,255,0.24)"
              stroke="rgba(255,255,255,0.95)"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
            <circle cx="9.5" cy="12" r="1.2" fill="#fff" />
            <circle cx="14.5" cy="12" r="1.2" fill="#fff" />
          </svg>
        )}
      </div>
    </div>
  );
};
