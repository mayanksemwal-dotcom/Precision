import React, { useState } from 'react';

interface BergLogoProps {
  className?: string;
  showSubtitle?: boolean;
  scaleClass?: string;
}

export default function BergLogo({ className = "h-8", showSubtitle = true, scaleClass = "scale-[2.2]" }: BergLogoProps) {
  const [imgError, setImgError] = useState(false);

  if (imgError) {
    return (
      <div className={`flex flex-col items-center justify-center select-none font-sans leading-none ${className}`}>
        <div className="flex items-center gap-0.5 tracking-tight font-black text-base">
          <span className="text-[#38BDF8]">B</span>
          <span className="text-[#3B82F6]">E</span>
          <span className="text-[#1D4ED8]">R</span>
          <span className="text-[#0ea5e9]">G</span>
        </div>
        {showSubtitle && (
          <div className="text-[7px] font-bold tracking-[0.15em] text-slate-500 mt-0.5 whitespace-nowrap uppercase">
            TECHNOLOGIES
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`flex items-center justify-center overflow-hidden ${className}`}>
      <img 
        src="/berg_logo.png" 
        alt="Berg Technologies Logo" 
        className={`max-h-full w-auto object-contain select-none transform origin-center ${scaleClass}`}
        onError={() => {
          console.warn("[BergLogo] Falling back to CSS typography due to asset load failure.");
          setImgError(true);
        }}
        referrerPolicy="no-referrer"
      />
    </div>
  );
}

