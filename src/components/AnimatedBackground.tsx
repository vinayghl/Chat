import React from 'react';

export const AnimatedBackground: React.FC = () => {
  return (
    <div
      aria-hidden="true"
      className="fixed inset-0 -z-10 overflow-hidden bg-[#0B1120]"
    >
      {/* Subtle tabletop architectural grid */}
      <div
        className="absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            'linear-gradient(to right, rgba(148,163,184,0.5) 1px, transparent 1px), linear-gradient(to bottom, rgba(148,163,184,0.5) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
        }}
      />

      {/* Warm amber & deep emerald atmospheric spotlights */}
      <div
        className="absolute -top-32 -left-24 w-[460px] h-[460px] rounded-full opacity-20 blur-[110px]"
        style={{
          background: 'radial-gradient(circle, #F59E0B 0%, transparent 70%)',
          animation: 'subtleFloat 14s ease-in-out infinite',
        }}
      />
      <div
        className="absolute -bottom-40 -right-24 w-[520px] h-[520px] rounded-full opacity-18 blur-[120px]"
        style={{
          background: 'radial-gradient(circle, #10B981 0%, transparent 70%)',
          animation: 'subtleFloat 18s ease-in-out 2s infinite reverse',
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(circle at 50% 25%, transparent 0%, rgba(11, 17, 32, 0.85) 85%)',
        }}
      />
    </div>
  );
};
