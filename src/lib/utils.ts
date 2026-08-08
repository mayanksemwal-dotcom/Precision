import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { format, parse, isValid } from 'date-fns'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Converts various date formats (Excel serial, strings etc) to YYYY-MM-DD string
 */
export function convertExcelDate(serial: any): string {
  if (!serial) return '';
  
  const str = String(serial).trim();

  // If it's already in YYYY-MM-DD format
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }
  
  // If it's YYYY-MM format (standard month identifier)
  if (/^\d{4}-\d{2}$/.test(str)) {
    return str;
  }

  // Attempt robust parsing for common formats
  const formats = [
    'dd-MM-yyyy',
    'dd/MM/yyyy',
    'd-MMM-yyyy',
    'dd-MMM-yyyy',
    'MMM d, yyyy',
    'MM/dd/yyyy',
    'yyyy/MM/dd',
    'MMM-yyyy',
    'MMM yyyy',
    'MMM yy'
  ];

  for (const f of formats) {
    try {
      const parsed = parse(str, f, new Date());
      if (isValid(parsed)) {
        // If it's just a month format, return YYYY-MM
        if (f.startsWith('MMM')) {
          return format(parsed, 'yyyy-MM');
        }
        return format(parsed, 'yyyy-MM-dd');
      }
    } catch (e) {
      // ignore
    }
  }

  // Check if it's a number (Excel serial)
  const num = Number(serial);
  if (!isNaN(num) && num > 1000) {
    try {
      // Excel base date is Dec 30, 1899. 
      // The number of days between 1899-12-30 and 1970-01-01 is 25569.
      const date = new Date((num - 25569) * 86400 * 1000);
      if (!isNaN(date.getTime())) {
        return format(date, 'yyyy-MM-dd');
      }
    } catch (e) {}
  }
  
  // if all else fails but it contains a date string, maybe try JS Date
  const fallbackDate = new Date(str);
  if (!isNaN(fallbackDate.getTime())) {
      // Check if original string only had month & year (e.g. "June 2026")
      if (/^[a-zA-Z]+\s+\d{4}$/.test(str)) {
          return format(fallbackDate, 'yyyy-MM');
      }
      return format(fallbackDate, 'yyyy-MM-dd');
  }

  return str;
}

/**
 * Validates and sanitizes timestamps before Firestore write.
 */
export function sanitizeTimestamp(d: any): string {
  if (!d) return new Date().toISOString();
  const date = new Date(d);
  if (isNaN(date.getTime())) {
    console.error(`Invalid Date encountered, sanitizing to now:`, d);
    return new Date().toISOString();
  }
  return date.toISOString();
}


/**
 * Parses and returns a period in YYYY-MM-DD format
 */
export function convertExcelPeriod(serial: any): string {
  if (!serial) return '';
  const str = String(serial).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  if (/^\d{4}-\d{2}$/.test(str)) return `${str}-01`;
  
  const formats = [
    'dd/MM/yyyy', 'd-MMM-yyyy', 'dd-MMM-yyyy', 'MMM d, yyyy', 'MM/dd/yyyy', 'yyyy/MM/dd',
    'MMM-yyyy', 'MMM yyyy', 'MMMM yyyy', 'MM-yyyy', 'MM/yyyy', 'M/yyyy', 'MM-yy', 'MMM-yy', 'MMM yy'
  ];
  for (const f of formats) {
    try {
      const parsed = parse(str, f, new Date());
      if (isValid(parsed)) return format(parsed, 'yyyy-MM-dd');
    } catch(e) {}
  }
  
  const num = Number(serial);
  if (!isNaN(num) && num > 1000) {
    const date = new Date((num - 25569) * 86400 * 1000);
    if (!isNaN(date.getTime())) return format(date, 'yyyy-MM-dd');
  }

  const fallback = new Date(str);
  if (!isNaN(fallback.getTime())) return format(fallback, 'yyyy-MM-dd');
  
  return str;
}


/**
 * Robustly formats any period (Excel serial date, ISO string, or custom text) 
 * into standard display form: "June-2026".
 */
export function formatPeriodForDisplay(period: any): string {
  if (period === null || period === undefined) return '-';
  const str = String(period).trim();
  if (!str || str === '-' || str === 'ALL') return str;

  // 1. Try if it is an Excel serial number (e.g. 46174)
  const num = Number(str);
  if (!isNaN(num) && num > 1000) {
    try {
      // Excel base date is Dec 30, 1899. 
      // The number of days between 1899-12-30 and 1970-01-01 is 25569.
      const date = new Date(Math.round((num - 25569) * 86400 * 1000));
      if (!isNaN(date.getTime())) {
        const MONTH_NAMES = [
          "January", "February", "March", "April", "May", "June",
          "July", "August", "September", "October", "November", "December"
        ];
        const year = date.getUTCFullYear();
        const month = MONTH_NAMES[date.getUTCMonth()];
        return `${month}-${year}`;
      }
    } catch (e) {}
  }

  // 2. Try parsing YYYY-MM-DD or YYYY-MM explicitly to avoid timezone shifting
  const ymdMatch = str.match(/^(\d{4})-(\d{2})(-\d{2})?$/);
  if (ymdMatch) {
    const year = parseInt(ymdMatch[1], 10);
    const monthIdx = parseInt(ymdMatch[2], 10) - 1;
    const MONTH_NAMES = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"
    ];
    if (monthIdx >= 0 && monthIdx < 12) {
      return `${MONTH_NAMES[monthIdx]}-${year}`;
    }
  }

  // 3. Try parsing common formats using date-fns
  const formats = [
    'MMM-yyyy', 'MMM yyyy', 'MMMM yyyy', 'MMM-yy', 'MMM yy', 'MMMM yy',
    'MM-yyyy', 'MM/yyyy', 'M/yyyy', 'yyyy-MM', 'yyyy-MM-dd',
    'dd/MM/yyyy', 'MM/dd/yyyy', 'dd-MM-yyyy', 'd-MMM-yyyy', 'dd-MMM-yyyy'
  ];

  for (const f of formats) {
    try {
      const parsed = parse(str, f, new Date());
      if (isValid(parsed)) {
        const MONTH_NAMES = [
          "January", "February", "March", "April", "May", "June",
          "July", "August", "September", "October", "November", "December"
        ];
        return `${MONTH_NAMES[parsed.getMonth()]}-${parsed.getFullYear()}`;
      }
    } catch (e) {}
  }

  // 4. Try parsing as standard JS date string
  try {
    const parsed = new Date(str);
    if (!isNaN(parsed.getTime())) {
      const MONTH_NAMES = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
      ];
      return `${MONTH_NAMES[parsed.getMonth()]}-${parsed.getFullYear()}`;
    }
  } catch (e) {}

  // 5. If it's something like "June-26" or "Jun-26" or "June'26", handle manually
  const hyphenMatch = str.match(/^([a-zA-Z]+)[-'\s](\d{2,4})$/);
  if (hyphenMatch) {
    let monthPart = hyphenMatch[1].toLowerCase();
    let yearPart = hyphenMatch[2];
    
    const MONTH_MAP: Record<string, string> = {
      jan: "January", feb: "February", mar: "March", apr: "April",
      may: "May", jun: "June", jul: "July", aug: "August",
      sep: "September", oct: "October", nov: "November", dec: "December"
    };

    let matchedMonth = "";
    for (const key of Object.keys(MONTH_MAP)) {
      if (monthPart.startsWith(key)) {
        matchedMonth = MONTH_MAP[key];
        break;
      }
    }

    if (matchedMonth) {
      let year = parseInt(yearPart, 10);
      if (yearPart.length === 2) {
        year = year < 50 ? 2000 + year : 1900 + year;
      }
      return `${matchedMonth}-${year}`;
    }
  }

  return str;
}

/**
 * Formats numeric KPI values to 2 decimal places.
 * e.g. 97.52267151 -> "97.52", 40 -> "40.00"
 */
export function formatKpiNumber(val: any, fallback = '-'): string {
  if (val === null || val === undefined || val === '') return fallback;
  const num = typeof val === 'number' ? val : Number(val);
  if (isNaN(num)) return String(val);
  return num.toFixed(2);
}

