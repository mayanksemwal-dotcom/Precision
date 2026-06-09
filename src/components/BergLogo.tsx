import React from 'react';

interface BergLogoProps {
  className?: string;
  showSubtitle?: boolean;
  scaleClass?: string;
}

export default function BergLogo({ className = "h-8", showSubtitle = true, scaleClass = "" }: BergLogoProps) {
  return (
    <div className={`flex items-center justify-center bg-white rounded-lg p-1 ${className || ''} ${scaleClass || ''} transition-all duration-300 shadow-sm overflow-hidden`}>
      <img 
        src="/berg_logo.png" 
        alt="Berg Technologies" 
        className="h-full w-auto object-contain"
        referrerPolicy="no-referrer"
      />
    </div>
  );
}
