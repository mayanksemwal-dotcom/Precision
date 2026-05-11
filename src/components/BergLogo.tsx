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
        <path d="M20 20H60C80 20 90 35 90 50C90 65 80 80 60 80H40V110H20V20ZM40 60H60C65 60 70 55 70 50C70 45 65 40 60 40H40V60Z" fill="#38BDF8" />
        
        {/* E (Modified styled E) */}
        <path d="M110 20H180V40H110V20Z" fill="#3B82F6" />
        <path d="M110 55H180V75H110V55Z" fill="#3B82F6" />
        <path d="M110 90H180V110H110V90Z" fill="#3B82F6" />
        
        {/* R */}
        <path d="M200 20H240C260 20 270 35 270 50C270 65 260 80 240 80H220V110H200V20ZM220 60H240C245 60 250 55 250 50C250 45 245 40 240 40H220V60Z" fill="#38BDF8" />
        <path d="M245 80L275 110H250L220 80H245Z" fill="#38BDF8" />
        
        {/* G */}
        <path d="M350 50V35C350 25 340 20 325 20C310 20 300 30 300 50V80C300 100 310 110 325 110C340 110 350 100 350 85V70H325V85C325 90 320 95 315 95C310 95 305 90 305 80V50C305 40 310 35 315 35C320 35 325 40 325 50V60H350V50Z" fill="#38BDF8" />
      </svg>
      {showSubtitle && (
        <div className="text-[10px] font-black tracking-[0.2em] text-[#0F172A] mt-1 whitespace-nowrap uppercase">
          Technologies Pvt. Ltd.
        </div>
      )}
    </div>
  );
}
