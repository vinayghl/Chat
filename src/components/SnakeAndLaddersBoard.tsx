import React, { useMemo } from 'react';
import {
  AVATAR_OPTIONS,
  LADDERS,
  SNAKES,
  getSquareCoords,
  type PlayerState,
} from '../shared/gameConstants.ts';

interface SnakeAndLaddersBoardProps {
  players: PlayerState[];
  displayPositions: Record<string, number>;
  myPlayerId: string;
  activePlayerId: string | null;
  highlightedSquare: number | null;
}

interface BoardTile {
  square: number;
  row: number;
  col: number;
}

const SNAKE_PALETTES = [
  { body: '#E11D48', belly: '#FDA4AF', eye: '#FFF1F2' }, // Crimson
  { body: '#7C3AED', belly: '#C4B5FD', eye: '#F5F3FF' }, // Violet
  { body: '#0284C7', belly: '#7DD3FC', eye: '#F0F9FF' }, // Ocean
  { body: '#D97706', belly: '#FDE68A', eye: '#FFFBEB' }, // Ochre
];

function buildBoardTiles(): BoardTile[] {
  const tiles: BoardTile[] = [];
  for (let row = 0; row < 10; row += 1) {
    const rowFromBottom = 9 - row;
    for (let col = 0; col < 10; col += 1) {
      const offsetInRow = rowFromBottom % 2 === 0 ? col : 9 - col;
      const square = rowFromBottom * 10 + offsetInRow + 1;
      tiles.push({ square, row, col });
    }
  }
  return tiles;
}

function getTileColors(square: number, row: number, col: number): string {
  if (square === 100) {
    return 'bg-amber-300 text-slate-950';
  }
  if (square === 1) {
    return 'bg-emerald-200 text-slate-950';
  }
  const paletteIndex = (row + col) % 4;
  switch (paletteIndex) {
    case 0:
      return 'bg-[#F8FAFC] text-slate-800';
    case 1:
      return 'bg-[#FEF3C7] text-slate-800';
    case 2:
      return 'bg-[#E2E8F0] text-slate-800';
    default:
      return 'bg-[#DCFCE7] text-slate-800';
  }
}

export const SnakeAndLaddersBoard: React.FC<SnakeAndLaddersBoardProps> = ({
  players,
  displayPositions,
  myPlayerId,
  activePlayerId,
  highlightedSquare,
}) => {
  const tiles = useMemo(() => buildBoardTiles(), []);

  const ladderEntries = useMemo(
    () =>
      Object.entries(LADDERS).map(([fromStr, to]) => {
        const from = Number(fromStr);
        const start = getSquareCoords(from);
        const end = getSquareCoords(to);
        const x1 = start.col * 100 + 50;
        const y1 = start.row * 100 + 50;
        const x2 = end.col * 100 + 50;
        const y2 = end.row * 100 + 50;

        const dx = x2 - x1;
        const dy = y2 - y1;
        const length = Math.hypot(dx, dy);
        const nx = (-dy / length) * 14;
        const ny = (dx / length) * 14;

        const rungCount = Math.max(4, Math.floor(length / 36));
        const rungs = Array.from({ length: rungCount }, (_, idx) => {
          const t = (idx + 1) / (rungCount + 1);
          const cx = x1 + dx * t;
          const cy = y1 + dy * t;
          return {
            rx1: cx - nx,
            ry1: cy - ny,
            rx2: cx + nx,
            ry2: cy + ny,
          };
        });

        return { from, to, x1, y1, x2, y2, nx, ny, rungs };
      }),
    []
  );

  const snakeEntries = useMemo(
    () =>
      Object.entries(SNAKES).map(([fromStr, to], index) => {
        const from = Number(fromStr);
        const start = getSquareCoords(from); // head
        const end = getSquareCoords(to);     // tail
        const x1 = start.col * 100 + 50;
        const y1 = start.row * 100 + 50;
        const x2 = end.col * 100 + 50;
        const y2 = end.row * 100 + 50;

        const dx = x2 - x1;
        const dy = y2 - y1;
        const length = Math.hypot(dx, dy);
        const perpX = -dy / length;
        const perpY = dx / length;
        const waveAmp = Math.min(48, Math.max(26, length * 0.16));

        // Build smooth 2-wave S-curve path
        const mid1x = x1 + dx * 0.25 + perpX * waveAmp;
        const mid1y = y1 + dy * 0.25 + perpY * waveAmp;
        const mid2x = x1 + dx * 0.5;
        const mid2y = y1 + dy * 0.5;
        const mid3x = x1 + dx * 0.75 - perpX * waveAmp;
        const mid3y = y1 + dy * 0.75 - perpY * waveAmp;

        const pathD = `M ${x1} ${y1} Q ${mid1x} ${mid1y} ${mid2x} ${mid2y} T ${x2} ${y2}`;
        const palette = SNAKE_PALETTES[index % SNAKE_PALETTES.length];
        const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;

        return { from, to, x1, y1, x2, y2, pathD, palette, angleDeg };
      }),
    []
  );

  const getTokenPositionStyle = (player: PlayerState, sameSquareCount: number, indexInSquare: number) => {
    const pos = displayPositions[player.playerId] ?? player.position;
    let xPct = 5;
    let yPct = 95;

    if (pos <= 0) {
      // Staging dock at bottom-left corner of square 1
      xPct = player.slot === 1 ? 3.2 : 7.2;
      yPct = 97.6;
    } else {
      const coords = getSquareCoords(pos);
      xPct = coords.xPct;
      yPct = coords.yPct;
      if (sameSquareCount > 1) {
        const offset = indexInSquare === 0 ? -1.8 : 1.8;
        xPct += offset;
        yPct += indexInSquare === 0 ? -1.2 : 1.2;
      }
    }

    return {
      left: `${xPct}%`,
      top: `${yPct}%`,
    };
  };

  return (
    <div className="w-full max-w-[600px] mx-auto">
      <div className="relative aspect-square w-full rounded-2xl sm:rounded-3xl p-1.5 sm:p-2.5 bg-gradient-to-br from-slate-800 via-slate-900 to-slate-950 border border-slate-700/80 shadow-[0_24px_60px_rgba(0,0,0,0.55)]">
        {/* Inner 10x10 Board Surface */}
        <div className="relative w-full h-full rounded-xl sm:rounded-2xl overflow-hidden border border-slate-900/60">
          <div className="grid grid-cols-10 grid-rows-10 w-full h-full">
            {tiles.map((tile) => {
              const isLadderBase = LADDERS[tile.square] !== undefined;
              const isSnakeHead = SNAKES[tile.square] !== undefined;
              const isHighlighted = highlightedSquare === tile.square;
              return (
                <div
                  key={tile.square}
                  className={`relative border-[0.5px] border-slate-900/15 flex flex-col justify-between p-0.5 sm:p-1 select-none transition-colors ${getTileColors(
                    tile.square,
                    tile.row,
                    tile.col
                  )} ${
                    isHighlighted
                      ? 'ring-2 ring-inset ring-amber-500 bg-amber-200/90'
                      : ''
                  }`}
                >
                  <span
                    className={`font-mono-code leading-none font-bold text-[9px] sm:text-[11px] md:text-xs ${
                      tile.square === 100
                        ? 'text-amber-950'
                        : tile.square === 1
                          ? 'text-emerald-950'
                          : 'text-slate-700/90'
                    }`}
                  >
                    {tile.square}
                  </span>

                  {tile.square === 100 && (
                    <span className="self-end text-[9px] sm:text-[10px] font-extrabold text-amber-900 leading-none">
                      WIN
                    </span>
                  )}
                  {tile.square === 1 && (
                    <span className="self-end text-[8px] sm:text-[9px] font-bold text-emerald-900 leading-none">
                      GO
                    </span>
                  )}
                  {isLadderBase && (
                    <span className="self-end text-[8px] sm:text-[9px] font-bold text-amber-700/80 leading-none">
                      ↑{LADDERS[tile.square]}
                    </span>
                  )}
                  {isSnakeHead && (
                    <span className="self-end text-[8px] sm:text-[9px] font-bold text-rose-700/80 leading-none">
                      ↓{SNAKES[tile.square]}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {/* SVG Ladders & Snakes Overlay */}
          <svg
            viewBox="0 0 1000 1000"
            className="absolute inset-0 w-full h-full pointer-events-none"
            aria-hidden="true"
          >
            <defs>
              <filter id="boardShadow" x="-15%" y="-15%" width="130%" height="130%">
                <feDropShadow dx="0" dy="4" stdDeviation="4" floodColor="#0F172A" floodOpacity="0.32" />
              </filter>
            </defs>

            {/* Ladders */}
            <g filter="url(#boardShadow)" opacity="0.93">
              {ladderEntries.map((ladder) => (
                <g key={`ladder-${ladder.from}`}>
                  {ladder.rungs.map((rung, idx) => (
                    <line
                      key={idx}
                      x1={rung.rx1}
                      y1={rung.ry1}
                      x2={rung.rx2}
                      y2={rung.ry2}
                      stroke="#92400E"
                      strokeWidth="7"
                      strokeLinecap="round"
                    />
                  ))}
                  {ladder.rungs.map((rung, idx) => (
                    <line
                      key={`hi-${idx}`}
                      x1={rung.rx1}
                      y1={rung.ry1}
                      x2={rung.rx2}
                      y2={rung.ry2}
                      stroke="#FBBF24"
                      strokeWidth="3"
                      strokeLinecap="round"
                    />
                  ))}
                  {/* Side Rails */}
                  <line
                    x1={ladder.x1 - ladder.nx}
                    y1={ladder.y1 - ladder.ny}
                    x2={ladder.x2 - ladder.nx}
                    y2={ladder.y2 - ladder.ny}
                    stroke="#78350F"
                    strokeWidth="9"
                    strokeLinecap="round"
                  />
                  <line
                    x1={ladder.x1 - ladder.nx}
                    y1={ladder.y1 - ladder.ny}
                    x2={ladder.x2 - ladder.nx}
                    y2={ladder.y2 - ladder.ny}
                    stroke="#F59E0B"
                    strokeWidth="4"
                    strokeLinecap="round"
                  />
                  <line
                    x1={ladder.x1 + ladder.nx}
                    y1={ladder.y1 + ladder.ny}
                    x2={ladder.x2 + ladder.nx}
                    y2={ladder.y2 + ladder.ny}
                    stroke="#78350F"
                    strokeWidth="9"
                    strokeLinecap="round"
                  />
                  <line
                    x1={ladder.x1 + ladder.nx}
                    y1={ladder.y1 + ladder.ny}
                    x2={ladder.x2 + ladder.nx}
                    y2={ladder.y2 + ladder.ny}
                    stroke="#F59E0B"
                    strokeWidth="4"
                    strokeLinecap="round"
                  />
                </g>
              ))}
            </g>

            {/* Snakes */}
            <g filter="url(#boardShadow)" opacity="0.92">
              {snakeEntries.map((snake) => (
                <g key={`snake-${snake.from}`}>
                  {/* Outer Snake Body */}
                  <path
                    d={snake.pathD}
                    fill="none"
                    stroke={snake.palette.body}
                    strokeWidth="18"
                    strokeLinecap="round"
                  />
                  {/* Patterned Belly Stripe */}
                  <path
                    d={snake.pathD}
                    fill="none"
                    stroke={snake.palette.belly}
                    strokeWidth="6"
                    strokeDasharray="10 14"
                    strokeLinecap="round"
                  />
                  {/* Tail Tip */}
                  <circle
                    cx={snake.x2}
                    cy={snake.y2}
                    r="6"
                    fill={snake.palette.body}
                  />
                  {/* Serpent Head */}
                  <g transform={`translate(${snake.x1}, ${snake.y1}) rotate(${snake.angleDeg})`}>
                    <ellipse
                      cx="0"
                      cy="0"
                      rx="16"
                      ry="13"
                      fill={snake.palette.body}
                      stroke="#0F172A"
                      strokeWidth="2"
                    />
                    {/* Eyes */}
                    <circle cx="-4" cy="-6" r="3.5" fill={snake.palette.eye} />
                    <circle cx="-4" cy="6" r="3.5" fill={snake.palette.eye} />
                    <circle cx="-5" cy="-6" r="1.6" fill="#0F172A" />
                    <circle cx="-5" cy="6" r="1.6" fill="#0F172A" />
                  </g>
                </g>
              ))}
            </g>
          </svg>

          {/* Animated Player Tokens */}
          {players.map((player) => {
            const myPos = displayPositions[player.playerId] ?? player.position;
            const sharingPlayers = players.filter(
              (p) => (displayPositions[p.playerId] ?? p.position) === myPos
            );
            const idxInSquare = sharingPlayers.findIndex(
              (p) => p.playerId === player.playerId
            );
            const posStyle = getTokenPositionStyle(
              player,
              sharingPlayers.length,
              idxInSquare
            );

            const avatar =
              AVATAR_OPTIONS.find((a) => a.id === player.avatarId) ??
              AVATAR_OPTIONS[player.slot === 1 ? 0 : 1];
            const isActive = activePlayerId === player.playerId;
            const isMe = player.playerId === myPlayerId;

            return (
              <div
                key={player.playerId}
                style={{
                  ...posStyle,
                  transition:
                    'left 185ms cubic-bezier(0.22, 1, 0.36, 1), top 185ms cubic-bezier(0.22, 1, 0.36, 1)',
                }}
                className="absolute -translate-x-1/2 -translate-y-1/2 z-20 pointer-events-none"
              >
                <div
                  className={`relative w-6 h-6 sm:w-8 sm:h-8 rounded-full border-2 border-white shadow-[0_4px_12px_rgba(0,0,0,0.55)] flex items-center justify-center text-[10px] sm:text-xs font-extrabold text-white transition-transform ${
                    isActive ? 'scale-110 ring-4 ring-amber-400/70' : ''
                  }`}
                  style={{
                    background: `linear-gradient(135deg, ${avatar.primary} 0%, ${avatar.secondary} 100%)`,
                  }}
                >
                  <span>P{player.slot}</span>
                  {isMe && (
                    <span
                      aria-hidden="true"
                      className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-amber-400 border border-slate-950"
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
