import React from 'react';

interface BergLogoProps {
  className?: string;
  showSubtitle?: boolean;
}

export default function BergLogo({ className = "h-8", showSubtitle = true }: BergLogoProps) {
  return (
    <div className={`flex flex-col items-center justify-center ${className}`}>
      <svg 
        viewBox="0 0 400 120" 
        fill="none" 
        xmlns="http://www.w3.org/2000/svg"
        className="w-full h-full"
      >
        {/* B */}
        <path fillRule="evenodd" clipRule="evenodd" d="M20 20H60C78 20 88 32 88 45C88 54 82 61 72 65C82 68 90 77 90 90C90 105 78 115 55 115H20V20ZM38 38V55H58C62 55 68 52 68 46C68 40 62 38 58 38H38ZM38 72V97H60C65 97 70 93 70 85C70 77 65 72 60 72H38Z" fill="#38BDF8" />
        
        {/* E (Styled lines) */}
        <path d="M110 20H185V38H110V20Z" fill="#3B82F6" />
        <path d="M110 58H175V76H110V58Z" fill="#3B82F6" />
        <path d="M110 97H185V115H110V97Z" fill="#3B82F6" />
        
        {/* R */}
        <path fillRule="evenodd" clipRule="evenodd" d="M205 20H245C268 20 280 32 280 48C280 62 268 74 245 74H225V115H205V20ZM225 38V56H245C252 56 260 52 260 48C260 44 252 38 245 38H225Z" fill="#38BDF8" />
        <path d="M250 74L285 115H260L225 74H250Z" fill="#38BDF8" />
        
        {/* G - Re-engineered for perfect balance */}
        <path fillRule="evenodd" clipRule="evenodd" d="M380 45V35C380 20 365 10 340 10C310 10 295 30 295 65V70C295 105 310 120 340 120C365 120 380 105 380 85V65H330V83H358V85C358 95 352 102 340 102C325 102 315 95 315 70V65C315 40 325 28 340 28C355 28 358 35 358 45V50H380V45Z" fill="#38BDF8" />
      </svg>
      {showSubtitle && (
        <div className="text-[10px] font-black tracking-[0.2em] text-[#0F172A] mt-1 whitespace-nowrap uppercase">
          Technologies Pvt. Ltd.
        </div>
      )}
    </div>
  );
}
