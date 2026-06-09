import React from 'react';

interface BergLogoProps {
  className?: string;
  showSubtitle?: boolean;
  scaleClass?: string;
}

export default function BergLogo({ className = "h-8", showSubtitle = true, scaleClass = "" }: BergLogoProps) {
  return (
    <div className={`flex items-center justify-center ${className || ''} ${scaleClass || ''} transition-transform duration-300`}>
      <svg 
        viewBox={showSubtitle ? "0 0 420 120" : "0 0 320 120"} 
        fill="none" 
        xmlns="http://www.w3.org/2000/svg"
        className="w-full h-full"
      >
        <defs>
          {/* BERG Text Gradient */}
          <linearGradient id="berg-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#3A83CA" />
            <stop offset="100%" stopColor="#64C4ED" />
          </linearGradient>
        </defs>

        {/* --- MOUNTAIN GRAPHIC --- */}
        <g transform="translate(10, 15)">
          {/* Main Top Light Blue Outline/Base (Connecting them) */}
          <path d="M0,60 L24,30 L40,48 L56,15 L72,48 L86,30 L112,60 Z" fill="#64C4ED" />

          {/* Bottom Dark Blue/Geometric Layer */}
          <path d="M0,63 L34,75 L56,53 L78,75 L112,63 L56,102 Z" fill="#3A83CA" />
          
          {/* Center bottom downward peak (Darkest Blue for depth) */}
          <polygon points="34,75 56,102 56,53" fill="#2464A8" />
          <polygon points="78,75 56,102 56,53" fill="#4B95DB" />
        </g>
        
        {/* --- TEXT SECTION --- */}
        <text 
          x="130" 
          y="78" 
          fontFamily="Inter, system-ui, sans-serif" 
          fontWeight="900" 
          fontSize="68" 
          fill="url(#berg-gradient)"
          letterSpacing="0.01em"
        >
          BERG
        </text>
        
        {/* Subtitle respects dark mode (black in light mode, white in dark mode) */}
        {showSubtitle && (
          <text 
            x="135" 
            y="104" 
            fontFamily="Inter, system-ui, sans-serif" 
            fontWeight="700" 
            fontSize="14" 
            className="fill-slate-900 dark:fill-white"
            letterSpacing="0.08em"
          >
            TECHNOLOGIES PVT. LTD.
          </text>
        )}
      </svg>
    </div>
  );
}
