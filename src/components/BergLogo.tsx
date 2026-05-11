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
        <path fill-rule="evenodd" clip-rule="evenodd" d="M20 20H55C72 20 82 30 82 42C82 50 76 58 68 62C78 65 85 75 85 88C85 102 75 110 55 110H20V20ZM38 35V52H55C58 52 62 50 62 42C62 35 58 35 55 35H38ZM38 68V95H58C62 95 65 92 65 85C65 78 62 68 58 68H38Z" fill="#38BDF8" />
        
        {/* E (Styled lines) */}
        <path d="M105 20H175V38H105V20Z" fill="#3B82F6" />
        <path d="M105 56H165V74H105V56Z" fill="#3B82F6" />
        <path d="M105 92H175V110H105V92Z" fill="#3B82F6" />
        
        {/* R */}
        <path fill-rule="evenodd" clip-rule="evenodd" d="M200 20H240C260 20 270 32 270 45C270 58 260 70 240 70H218V110H200V20ZM218 35V55H240C245 55 250 52 250 45C250 38 245 35 240 35H218Z" fill="#38BDF8" />
        <path d="M240 70L275 110H253L218 70H240Z" fill="#38BDF8" />
        
        {/* G - Resized to match height and width better */}
        <path fill-rule="evenodd" clip-rule="evenodd" d="M365 45V35C365 25 355 20 335 20C315 20 300 30 300 55V75C300 100 315 110 335 110C355 110 365 100 365 85V65H325V82H348V85C348 93 342 95 335 95C320 95 315 88 315 75V55C315 40 320 35 330 35C340 35 348 40 348 50V52H365V45Z" fill="#38BDF8" />
      </svg>
      {showSubtitle && (
        <div className="text-[10px] font-black tracking-[0.2em] text-[#0F172A] mt-1 whitespace-nowrap uppercase">
          Technologies Pvt. Ltd.
        </div>
      )}
    </div>
  );
}
