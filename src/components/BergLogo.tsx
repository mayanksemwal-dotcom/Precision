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
        <path fill-rule="evenodd" clip-rule="evenodd" d="M20 20H55C75 20 85 32 85 45C85 55 78 63 68 65C80 67 90 75 90 90C90 105 78 115 55 115H20V20ZM38 36V54H55C60 54 65 51 65 45C65 39 60 36 55 36H38ZM38 74V99H58C63 99 68 95 68 87C68 79 63 74 58 74H38Z" fill="#38BDF8" />
        
        {/* E (Styled lines) */}
        <path d="M110 20H180V40H110V20Z" fill="#3B82F6" />
        <path d="M110 52H170V72H110V52Z" fill="#3B82F6" />
        <path d="M110 84H180V104H110V84Z" fill="#3B82F6" />
        
        {/* R */}
        <path fill-rule="evenodd" clip-rule="evenodd" d="M210 20H250C275 20 285 35 285 50C285 65 275 80 250 80H228V110H210V20ZM228 35V65H250C258 65 265 60 265 50C265 40 258 35 250 35H228Z" fill="#38BDF8" />
        <path d="M250 80L285 110H265L230 80H250Z" fill="#38BDF8" />
        
        {/* G - Improved C curve into a G */}
        <path fill-rule="evenodd" clip-rule="evenodd" d="M370 45V35C370 15 350 5 325 5C300 5 280 20 280 55V80C280 110 300 120 325 120C350 120 370 110 370 85V65H320V82H352V85C352 95 345 103 325 103C305 103 298 90 298 80V55C298 30 305 22 325 22C345 22 352 30 352 45V50H370V45Z" fill="#38BDF8" />
      </svg>
      {showSubtitle && (
        <div className="text-[10px] font-black tracking-[0.2em] text-[#0F172A] mt-1 whitespace-nowrap uppercase">
          Technologies Pvt. Ltd.
        </div>
      )}
    </div>
  );
}
