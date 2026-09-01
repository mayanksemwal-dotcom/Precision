import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { format, parse, isValid } from 'date-fns'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

const MONTHS_MAP: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12
};

/**
 * Converts various date formats (Excel serial, strings etc) to YYYY-MM-DD string
 * with 100% timezone safety and priority for DD-MM-YYYY standard.
 */
export function convertExcelDate(serial: any): string {
  if (serial === undefined || serial === null || serial === '') return '';

  // 1. JavaScript Date instance
  if (serial instanceof Date || Object.prototype.toString.call(serial) === '[object Date]') {
    if (!isNaN(serial.getTime())) {
      if (serial.getUTCHours() === 0 && serial.getUTCMinutes() === 0 && serial.getUTCSeconds() === 0) {
        const y = serial.getUTCFullYear();
        const m = String(serial.getUTCMonth() + 1).padStart(2, '0');
        const d = String(serial.getUTCDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
      }
      const y = serial.getFullYear();
      const m = String(serial.getMonth() + 1).padStart(2, '0');
      const d = String(serial.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
  }

  // 2. Numeric Excel serial (e.g. 46114 -> 2026-04-01)
  const num = Number(serial);
  if (!isNaN(num) && typeof serial !== 'boolean' && num > 1000) {
    try {
      const days = Math.floor(num) - (num > 60 ? 25569 : 25568);
      const utcMs = days * 86400 * 1000;
      const d = new Date(utcMs);
      if (!isNaN(d.getTime())) {
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
      }
    } catch (e) {}
  }

  const str = String(serial).trim();
  if (!str) return '';

  // 3. ISO / YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = str.match(/^(\d{4})[\s\/\-.]+(\d{1,2})[\s\/\-.]+(\d{1,2})/);
  if (isoMatch) {
    const y = Number(isoMatch[1]);
    const m = Number(isoMatch[2]);
    const d = Number(isoMatch[3]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  // 4. Text Month DD-MMM-YYYY or DD-MMM-YY (e.g. 01-April-2026, 03-Apr-26, 3-Apr-2026, 01/Apr/2026)
  const textMonthDmyMatch = str.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s\/\-.]+([a-zA-Z]+)[\s\/\-.]+(\d{2,4})/);
  if (textMonthDmyMatch) {
    const day = Number(textMonthDmyMatch[1]);
    const monthKey = textMonthDmyMatch[2].toLowerCase();
    const rawYear = Number(textMonthDmyMatch[3]);
    const year = rawYear < 100 ? (rawYear < 50 ? 2000 + rawYear : 1900 + rawYear) : rawYear;
    const month = MONTHS_MAP[monthKey] || MONTHS_MAP[monthKey.substring(0, 3)];
    if (month && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // 5. Text Month First (e.g. April 01, 2026 or Apr 3 2026)
  const textMonthMdyMatch = str.match(/^([a-zA-Z]+)[\s\/\-.]+(\d{1,2})(?:st|nd|rd|th)?(?:,\s*|\s*[\/\-.]\s*)(\d{2,4})/);
  if (textMonthMdyMatch) {
    const monthKey = textMonthMdyMatch[1].toLowerCase();
    const day = Number(textMonthMdyMatch[2]);
    const rawYear = Number(textMonthMdyMatch[3]);
    const year = rawYear < 100 ? (rawYear < 50 ? 2000 + rawYear : 1900 + rawYear) : rawYear;
    const month = MONTHS_MAP[monthKey] || MONTHS_MAP[monthKey.substring(0, 3)];
    if (month && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // 6. DD-MM-YYYY (4-digit year) e.g. 01-04-2026, 03-04-2026, 01/04/2026
  const dmy4Match = str.match(/^(\d{1,2})[\s\/\-.]+(\d{1,2})[\s\/\-.]+(\d{4})/);
  if (dmy4Match) {
    const p1 = Number(dmy4Match[1]);
    const p2 = Number(dmy4Match[2]);
    const year = Number(dmy4Match[3]);
    let day = p1;
    let month = p2;
    if (p1 > 12 && p2 <= 12) {
      day = p1;
      month = p2;
    } else if (p2 > 12 && p1 <= 12) {
      month = p1;
      day = p2;
    }
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // 7. DD-MM-YY (2-digit year) e.g. 01-04-26, 03-04-26, 01/04/26
  const dmy2Match = str.match(/^(\d{1,2})[\s\/\-.]+(\d{1,2})[\s\/\-.]+(\d{2})$/);
  if (dmy2Match) {
    const p1 = Number(dmy2Match[1]);
    const p2 = Number(dmy2Match[2]);
    const rawYear = Number(dmy2Match[3]);
    const year = rawYear < 50 ? 2000 + rawYear : 1900 + rawYear;
    let day = p1;
    let month = p2;
    if (p1 > 12 && p2 <= 12) {
      day = p1;
      month = p2;
    } else if (p2 > 12 && p1 <= 12) {
      month = p1;
      day = p2;
    }
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // 8. Month-Year string (e.g. 2026-04, Apr-2026, April 2026)
  if (/^\d{4}-\d{2}$/.test(str)) {
    return `${str}-01`;
  }
  const textYmMatch = str.match(/^([a-zA-Z]+)[\s\/\-.]+(\d{4})$/);
  if (textYmMatch) {
    const month = MONTHS_MAP[textYmMatch[1].toLowerCase()] || MONTHS_MAP[textYmMatch[1].toLowerCase().substring(0, 3)];
    if (month) {
      return `${textYmMatch[2]}-${String(month).padStart(2, '0')}-01`;
    }
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
  return convertExcelDate(serial);
}


/**
 * Standardizes any date string, JS Date, or Excel serial to YYYY-MM-DD format.
 * Strictly prioritizes DD-MM-YYYY formats (e.g. 01-04-2026 -> 2026-04-01, 01-April-2026 -> 2026-04-01, 03-Apr-26 -> 2026-04-03).
 */
export function standardizeReportingDate(rawVal: any): string {
  if (rawVal === undefined || rawVal === null || rawVal === '') return '';

  // 1. JavaScript Date instance
  if (rawVal instanceof Date || Object.prototype.toString.call(rawVal) === '[object Date]') {
    if (!isNaN(rawVal.getTime())) {
      if (rawVal.getUTCHours() === 0 && rawVal.getUTCMinutes() === 0 && rawVal.getUTCSeconds() === 0) {
        const year = rawVal.getUTCFullYear();
        const month = String(rawVal.getUTCMonth() + 1).padStart(2, '0');
        const day = String(rawVal.getUTCDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      }
      const year = rawVal.getFullYear();
      const month = String(rawVal.getMonth() + 1).padStart(2, '0');
      const day = String(rawVal.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
  }

  // 2. Excel Numeric Serial (e.g. 46114 -> 2026-04-01)
  const num = Number(rawVal);
  if (!isNaN(num) && typeof rawVal !== 'boolean' && num > 1000) {
    try {
      const days = Math.floor(num) - (num > 60 ? 25569 : 25568);
      const utcMs = days * 86400 * 1000;
      const d = new Date(utcMs);
      if (!isNaN(d.getTime())) {
        const year = d.getUTCFullYear();
        const month = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      }
    } catch (e) {}
  }

  // 3. String representations
  const str = String(rawVal).trim();
  if (!str) return '';

  // 3.1 Already YYYY-MM-DD or starts with ISO format
  const isoMatch = str.match(/^(\d{4})[\s\/\-.]+(\d{1,2})[\s\/\-.]+(\d{1,2})/);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // 3.2 Text Month: 01-Apr-2026, 01-April-2026, 03-Apr-26, 3-Apr-26, 01 Apr 2026, 01/Apr/2026, 1st April 2026
  const textMonthDmyMatch = str.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s\/\-.]+([a-zA-Z]+)[\s\/\-.]+(\d{2,4})/);
  if (textMonthDmyMatch) {
    const day = Number(textMonthDmyMatch[1]);
    const monthKey = textMonthDmyMatch[2].toLowerCase();
    const rawYear = Number(textMonthDmyMatch[3]);
    const year = rawYear < 100 ? (rawYear < 50 ? 2000 + rawYear : 1900 + rawYear) : rawYear;
    const month = MONTHS_MAP[monthKey] || MONTHS_MAP[monthKey.substring(0, 3)];
    if (month && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // 3.3 Text Month First: Apr 01, 2026 or April 1 2026 or Apr-01-2026
  const textMonthMdyMatch = str.match(/^([a-zA-Z]+)[\s\/\-.]+(\d{1,2})(?:st|nd|rd|th)?(?:,\s*|\s*[\/\-.]\s*)(\d{2,4})/);
  if (textMonthMdyMatch) {
    const monthKey = textMonthMdyMatch[1].toLowerCase();
    const day = Number(textMonthMdyMatch[2]);
    const rawYear = Number(textMonthMdyMatch[3]);
    const year = rawYear < 100 ? (rawYear < 50 ? 2000 + rawYear : 1900 + rawYear) : rawYear;
    const month = MONTHS_MAP[monthKey] || MONTHS_MAP[monthKey.substring(0, 3)];
    if (month && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // 3.4 DD-MM-YYYY (4-digit year) e.g. 01-04-2026, 03-04-2026, 01/04/2026
  const dmy4Match = str.match(/^(\d{1,2})[\s\/\-.]+(\d{1,2})[\s\/\-.]+(\d{4})/);
  if (dmy4Match) {
    const p1 = Number(dmy4Match[1]);
    const p2 = Number(dmy4Match[2]);
    const year = Number(dmy4Match[3]);
    let day = p1;
    let month = p2;
    if (p1 > 12 && p2 <= 12) {
      day = p1;
      month = p2;
    } else if (p2 > 12 && p1 <= 12) {
      month = p1;
      day = p2;
    }
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // 3.5 DD-MM-YY (2-digit year) e.g. 01-04-26, 03-04-26, 01/04/26
  const dmy2Match = str.match(/^(\d{1,2})[\s\/\-.]+(\d{1,2})[\s\/\-.]+(\d{2})$/);
  if (dmy2Match) {
    const p1 = Number(dmy2Match[1]);
    const p2 = Number(dmy2Match[2]);
    const rawYear = Number(dmy2Match[3]);
    const year = rawYear < 50 ? 2000 + rawYear : 1900 + rawYear;
    let day = p1;
    let month = p2;
    if (p1 > 12 && p2 <= 12) {
      day = p1;
      month = p2;
    } else if (p2 > 12 && p1 <= 12) {
      month = p1;
      day = p2;
    }
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // 3.6 Month-Year string (e.g. 2026-04, Apr-2026, April 2026, Apr-26)
  if (/^\d{4}-\d{2}$/.test(str)) {
    return `${str}-01`;
  }
  const textYmMatch = str.match(/^([a-zA-Z]+)[\s\/\-.]+(\d{2,4})$/);
  if (textYmMatch) {
    const monthKey = textYmMatch[1].toLowerCase();
    const rawYear = Number(textYmMatch[2]);
    const year = rawYear < 100 ? (rawYear < 50 ? 2000 + rawYear : 1900 + rawYear) : rawYear;
    const month = MONTHS_MAP[monthKey] || MONTHS_MAP[monthKey.substring(0, 3)];
    if (month) {
      return `${year}-${String(month).padStart(2, '0')}-01`;
    }
  }

  return str;
}

/**
 * Extracts standard YYYY-MM string from any period text, date string, or date object.
 * e.g. "April-2026" -> "2026-04", "01-04-2026" -> "2026-04", "Apr-26" -> "2026-04", "2026-04-01" -> "2026-04"
 */
export function extractYearMonth(input: any): string {
  if (input === null || input === undefined || input === '') {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  // If already standard YYYY-MM
  const str = String(input).trim();
  if (/^\d{4}-\d{2}$/.test(str)) {
    return str;
  }

  // Try standardizing to YYYY-MM-DD first
  const stdDate = standardizeReportingDate(str);
  if (stdDate && /^\d{4}-\d{2}-\d{2}$/.test(stdDate)) {
    return stdDate.substring(0, 7);
  }

  // Try month-year patterns
  const textYm = str.match(/^([a-zA-Z]+)[\s\/\-.]+(\d{2,4})$/);
  if (textYm) {
    const monthKey = textYm[1].toLowerCase();
    const rawYear = Number(textYm[2]);
    const year = rawYear < 100 ? (rawYear < 50 ? 2000 + rawYear : 1900 + rawYear) : rawYear;
    const month = MONTHS_MAP[monthKey] || MONTHS_MAP[monthKey.substring(0, 3)];
    if (month) {
      return `${year}-${String(month).padStart(2, '0')}`;
    }
  }

  // Fallback to current date
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Robustly formats any period (Excel serial date, ISO string, or custom text) 
 * into standard display form: "June-2026".
 */
export function formatPeriodForDisplay(period: any): string {
  if (period === null || period === undefined) return '-';
  const str = String(period).trim();
  if (!str || str === '-' || str === 'ALL') return str;

  const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  // 1. Try if it is an Excel serial number (e.g. 46174)
  const num = Number(str);
  if (!isNaN(num) && num > 1000) {
    try {
      const date = new Date(Math.round((num - 25569) * 86400 * 1000));
      if (!isNaN(date.getTime())) {
        const year = date.getUTCFullYear();
        const month = MONTH_NAMES[date.getUTCMonth()];
        return `${month}-${year}`;
      }
    } catch (e) {}
  }

  // 2. Direct YYYY-MM or YYYY-MM-DD
  const ymdMatch = str.match(/^(\d{4})-(\d{2})(-\d{2})?$/);
  if (ymdMatch) {
    const year = parseInt(ymdMatch[1], 10);
    const monthIdx = parseInt(ymdMatch[2], 10) - 1;
    if (monthIdx >= 0 && monthIdx < 12) {
      return `${MONTH_NAMES[monthIdx]}-${year}`;
    }
  }

  // 3. Text format: April-2026, Apr-2026, Apr-26, April 2026, May-25, etc.
  const textMatch = str.match(/^([a-zA-Z]+)[\s\/\-.'_]+(\d{2,4})$/);
  if (textMatch) {
    const monthKey = textMatch[1].toLowerCase();
    const rawYear = Number(textMatch[2]);
    const year = rawYear < 100 ? (rawYear < 50 ? 2000 + rawYear : 1900 + rawYear) : rawYear;
    const month = MONTHS_MAP[monthKey] || MONTHS_MAP[monthKey.substring(0, 3)];
    if (month && month >= 1 && month <= 12) {
      return `${MONTH_NAMES[month - 1]}-${year}`;
    }
  }

  // 4. DD-MM-YYYY or DD/MM/YYYY e.g. 01-04-2026
  const std = standardizeReportingDate(str);
  if (std && /^\d{4}-\d{2}-\d{2}$/.test(std)) {
    const parts = std.split('-');
    const year = parseInt(parts[0], 10);
    const monthIdx = parseInt(parts[1], 10) - 1;
    if (monthIdx >= 0 && monthIdx < 12) {
      return `${MONTH_NAMES[monthIdx]}-${year}`;
    }
  }

  // 5. Try parsing common formats using date-fns
  const formats = [
    'MMM-yyyy', 'MMM yyyy', 'MMMM yyyy', 'MMM-yy', 'MMM yy', 'MMMM yy',
    'MM-yyyy', 'MM/yyyy', 'M/yyyy', 'yyyy-MM', 'yyyy-MM-dd',
    'dd/MM/yyyy', 'MM/dd/yyyy', 'dd-MM-yyyy', 'd-MMM-yyyy', 'dd-MMM-yyyy'
  ];

  for (const f of formats) {
    try {
      const parsed = parse(str, f, new Date());
      if (isValid(parsed)) {
        return `${MONTH_NAMES[parsed.getMonth()]}-${parsed.getFullYear()}`;
      }
    } catch (e) {}
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

/**
 * Recursively removes all undefined keys and nested undefined values from an object or array.
 * This is critical for Firestore transactions and writes, which reject undefined values.
 */
export function cleanUndefined<T = any>(obj: T): T {
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    return obj;
  }
  if (obj instanceof Date) {
    return obj as any;
  }
  if (Array.isArray(obj)) {
    return obj
      .filter((item) => item !== undefined)
      .map((item) => cleanUndefined(item)) as any;
  }
  const cleaned: Record<string, any> = {};
  for (const key of Object.keys(obj)) {
    const val = (obj as any)[key];
    if (val !== undefined) {
      cleaned[key] = cleanUndefined(val);
    }
  }
  return cleaned as any;
}

