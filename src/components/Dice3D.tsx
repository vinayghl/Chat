import React from 'react';

interface Dice3DProps {
  value: number;
  rolling: boolean;
  disabled: boolean;
  isMyTurn: boolean;
  onRoll: () => void;
}

const PIP_LAYOUTS: Record<number, number[]> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

function getTargetRotation(value: number): string {
  switch (value) {
    case 1:
      return 'rotateX(0deg) rotateY(0deg)';
    case 2:
      return 'rotateX(0deg) rotateY(-90deg)';
    case 3:
      return 'rotateX(-90deg) rotateY(0deg)';
    case 4:
      return 'rotateX(90deg) rotateY(0deg)';
    case 5:
      return 'rotateX(0deg) rotateY(90deg)';
    case 6:
      return 'rotateX(0deg) rotateY(180deg)';
    default:
      return 'rotateX(0deg) rotateY(0deg)';
  }
}

export const Dice3D: React.FC<Dice3DProps> = ({
  value,
  rolling,
  disabled,
  isMyTurn,
  onRoll,
}) => {
  const renderFace = (faceNumber: number) => {
    const activePips = PIP_LAYOUTS[faceNumber] ?? [4];
    const isOne = faceNumber === 1;
    return (
      <div
        key={faceNumber}
        className={`dice-face dice-face-${faceNumber} grid grid-cols-3 grid-rows-3 p-2.5 place-items-center`}
      >
        {Array.from({ length: 9 }, (_, idx) => {
          const hasPip = activePips.includes(idx);
          return (
            <span
              key={idx}
              className={`rounded-full transition-opacity ${
                hasPip
                  ? isOne
                    ? 'w-3.5 h-3.5 bg-rose-600 shadow-inner'
                    : 'w-2.5 h-2.5 bg-slate-900 shadow-inner'
                  : 'w-2.5 h-2.5 opacity-0'
              }`}
            />
          );
        })}
      </div>
    );
  };

  return (
    <div className="flex items-center gap-4">
      <div className="dice-scene w-[68px] h-[68px] shrink-0">
        <div
          className={`dice-cube ${rolling ? 'rolling' : ''}`}
          style={!rolling ? { transform: getTargetRotation(value) } : undefined}
        >
          {[1, 2, 3, 4, 5, 6].map(renderFace)}
        </div>
      </div>

      <button
        type="button"
        onClick={onRoll}
        disabled={disabled}
        className={`flex-1 min-h-[54px] px-5 rounded-2xl font-bold text-base transition-all whitespace-nowrap cursor-pointer ${
          !disabled
            ? 'bg-amber-500 hover:bg-amber-400 active:scale-[0.98] text-slate-950 shadow-lg shadow-amber-500/20'
            : 'bg-slate-800/80 text-slate-400 border border-slate-700/70 cursor-not-allowed'
        }`}
      >
        {rolling
          ? 'Rolling...'
          : isMyTurn
            ? 'Roll Dice'
            : 'Opponent Turn'}
      </button>
    </div>
  );
};
