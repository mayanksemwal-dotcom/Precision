import React from 'react';

interface BergLogoProps {
  className?: string;
  showSubtitle?: boolean;
  scaleClass?: string;
}

export default function BergLogo({ className = "h-8", showSubtitle = true, scaleClass = "scale-100" }: BergLogoProps) {
  return (
    <div className={`flex items-center justify-center overflow-hidden h-14 ${className} ${scaleClass}`}>
      <svg 
        className="w-full h-full object-contain select-none" 
        viewBox="0 0 175 48" 
        fill="none" 
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Gradients */}
        <defs>
          {/* Light-blue gradient for top mountain peaks and 'RG' text */}
          <linearGradient id="bergLightCyan" x1="0" y1="5" x2="35" y2="35" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#60CDFF" />
            <stop offset="100%" stopColor="#0EA5E9" />
          </linearGradient>
          {/* Royal blue gradient for bottom chevrons and 'BE' text */}
          <linearGradient id="bergRoyalBlue" x1="0" y1="15" x2="40" y2="40" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#3B82F6" />
            <stop offset="100%" stopColor="#1E40AF" />
          </linearGradient>
        </defs>

        {/* 1. MOUNTAIN LOGO GRAPHIC MARK (Left Side) */}
        <g transform="translate(2, 2)">
          {/* Back left peak */}
          <path 
            d="M5 29 L18 13 L23 29" 
            stroke="#60CDFF" 
            strokeWidth="1.5" 
            strokeLinejoin="round" 
            fill="url(#bergLightCyan)" 
            opacity="0.85"
          />
          {/* Central high peak */}
          <path 
            d="M13 29 L24 6 L33 29" 
            stroke="#60CDFF" 
            strokeWidth="2" 
            strokeLinejoin="round" 
            fill="url(#bergLightCyan)"
          />
          {/* Back right peak */}
          <path 
            d="M23 29 M23 29 L32 12 L41 29" 
            stroke="#60CDFF" 
            strokeWidth="1.5" 
            strokeLinejoin="round" 
            fill="url(#bergLightCyan)" 
            opacity="0.85"
          />

          {/* Bottom overlapping geometric dark blue facets */}
          {/* Left diamond facet fold */}
          <path 
            d="M5 29 L18 38 L23 20 Z" 
            fill="url(#bergRoyalBlue)" 
            stroke="#1D4ED8" 
            strokeWidth="1" 
            strokeLinejoin="round" 
          />
          {/* Right diamond facet fold */}
          <path 
            d="M23 20 L27 38 L41 29 Z" 
            fill="url(#bergRoyalBlue)" 
            stroke="#1E40AF" 
            strokeWidth="1" 
            strokeLinejoin="round" 
          />
          {/* Center key line separation */}
          <path 
            d="M18 38 L23 20 L27 38" 
            stroke="#FFFFFF" 
            strokeWidth="1" 
            strokeLinejoin="round" 
            opacity="0.9"
          />
        </g>

        {/* 2. BRAND TEXT TYPOGRAPHY (Right Side) */}
        <g transform="translate(48, 2)">
          {/* "BE" in Royal Blue, "RG" in Cyan Blue */}
          <text 
            x="0" 
            y="26" 
            fontFamily="system-ui, -apple-system, sans-serif" 
            fontWeight="900" 
            fontSize="26" 
            letterSpacing="-0.02em"
          >
            <tspan fill="url(#bergRoyalBlue)">BE</tspan>
            <tspan fill="url(#bergLightCyan)">RG</tspan>
          </text>
          
          {/* Subtitle "TECHNOLOGIES PVT. LTD." in bold black */}
          {showSubtitle ? (
            <text 
              x="0.5" 
              y="37" 
              fontFamily="system-ui, -apple-system, sans-serif" 
              fontWeight="800" 
              fontSize="7.2" 
              fill="#000000" 
              letterSpacing="0.04em"
            >
              TECHNOLOGIES PVT. LTD.
            </text>
          ) : (
            <text 
              x="0.5" 
              y="37" 
              fontFamily="system-ui, -apple-system, sans-serif" 
              fontWeight="800" 
              fontSize="6.2" 
              fill="#64748B" 
              letterSpacing="0.04em"
            >
              TECHNOLOGIES
            </text>
          )}
        </g>
      </svg>
    </div>
  );
}
