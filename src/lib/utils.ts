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

  // Fallback to native Date for random strings
  try {
    const d = new Date(str);
    if (!isNaN(d.getTime())) {
      return format(d, 'yyyy-MM-dd');
    }
  } catch (e) {}
  
  return str;
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
