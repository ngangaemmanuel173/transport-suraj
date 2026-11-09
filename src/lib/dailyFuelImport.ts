import * as XLSX from 'xlsx';

/**
 * Reads the two fuel sheets CSL and Tarmal keep:
 *  - Diesel grid: trucks down the side, days across the top ("1ST", "2ND", ...), litres in the cells.
 *    A "TTL FUEL" row at the bottom is skipped.
 *  - Petrol list: columns DATE ("1ST NOV"), VEHICLE, LITRES.
 * The sheets carry no year, so the caller passes the month and year to use.
 */
export type FuelType = 'diesel' | 'petrol';
export interface ParsedFuelRow { date: string; plate: string; litres: number; note: string | null }
export interface ParsedFuelSheet { kind: 'grid' | 'list'; rows: ParsedFuelRow[]; monthGuess: number | null }

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const monthFrom = (s: unknown): number | null => {
  const t = String(s ?? '').toUpperCase();
  const i = MONTHS.findIndex(m => t.includes(m));
  return i >= 0 ? i + 1 : null;
};
const dayFrom = (s: unknown): number | null => {
  const m = String(s ?? '').trim().match(/^(\d{1,2})\s*(ST|ND|RD|TH)?\b/i);
  if (!m) return null;
  const d = Number(m[1]);
  return d >= 1 && d <= 31 ? d : null;
};
const iso = (y: number, mo: number, d: number) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** A date cell that is a real date, "2026-11-01" or "01/11/2026" (day first). Returns yyyy-mm-dd or null. */
function fullDate(c: unknown): string | null {
  if (c instanceof Date && !isNaN(c.getTime())) return iso(c.getFullYear(), c.getMonth() + 1, c.getDate());
  const t = String(c ?? '').trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = t.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
  if (m) return iso(Number(m[3]), Number(m[2]), Number(m[1]));
  return null;
}

/** "KDW 649W(SURAJ)" -> plate "KDW 649W", note "SURAJ". */
export function splitPlate(raw: unknown): { plate: string; note: string | null } {
  const s = String(raw ?? '').trim();
  const m = s.match(/^(.*?)\s*\((.*)\)\s*$/);
  return m ? { plate: m[1].trim(), note: m[2].trim() || null } : { plate: s, note: null };
}

export function parseFuelWorkbook(data: ArrayBuffer, year: number, monthOverride?: number): ParsedFuelSheet {
  const wb = XLSX.read(data, { type: 'array', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const grid: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });

  // Month named in the title ("NOVEMBER FUEL RECORD") or in the list's dates ("1ST NOV")
  let monthGuess: number | null = null;
  for (const row of grid.slice(0, 3)) for (const c of row) { monthGuess = monthGuess ?? monthFrom(c); }

  const listHead = grid.findIndex(r => r.some(c => /^vehicle$/i.test(String(c ?? '').trim())) && r.some(c => /^litres?$/i.test(String(c ?? '').trim())));
  if (listHead >= 0) {
    const h = grid[listHead].map(c => String(c ?? '').trim().toLowerCase());
    const iDate = h.indexOf('date'), iVeh = h.indexOf('vehicle'), iLit = h.findIndex(x => x.startsWith('litre'));
    const rows: ParsedFuelRow[] = [];
    for (const r of grid.slice(listHead + 1)) {
      const litres = Number(r[iLit]);
      if (!r[iVeh] || !Number.isFinite(litres) || litres <= 0) continue;
      const { plate, note } = splitPlate(r[iVeh]);
      const full = fullDate(r[iDate]);
      if (full) {
        monthGuess = monthGuess ?? Number(full.slice(5, 7));
        rows.push({ date: full, plate, litres, note });
        continue;
      }
      const day = dayFrom(r[iDate]);
      if (!day) continue;
      const mo = monthOverride ?? monthFrom(r[iDate]) ?? monthGuess ?? new Date().getMonth() + 1;
      monthGuess = monthGuess ?? monthFrom(r[iDate]);
      rows.push({ date: iso(year, mo, day), plate, litres, note });
    }
    return { kind: 'list', rows, monthGuess };
  }

  const head = grid.findIndex(r => /^date$/i.test(String(r[0] ?? '').trim()));
  if (head < 0) throw new Error('Could not find the header row. Expected a DATE row (diesel grid) or DATE / VEHICLE / LITRES columns (petrol list).');
  const mo = monthOverride ?? monthGuess ?? new Date().getMonth() + 1;
  const dayCols: { col: number; day: number }[] = [];
  grid[head].forEach((c, col) => { if (col > 0) { const d = dayFrom(c); if (d) dayCols.push({ col, day: d }); } });
  const rows: ParsedFuelRow[] = [];
  for (const r of grid.slice(head + 1)) {
    const label = String(r[0] ?? '').trim();
    if (!label || /^t(o)?t(a)?l/i.test(label)) continue; // blank or the TTL FUEL row
    const { plate, note } = splitPlate(label);
    for (const { col, day } of dayCols) {
      const litres = Number(r[col]);
      if (Number.isFinite(litres) && litres > 0 && r[col] !== null) rows.push({ date: iso(year, mo, day), plate, litres, note });
    }
  }
  return { kind: 'grid', rows, monthGuess };
}

// ---------------------------------------------------------------------------------------------
// Templates

const MONTH_FULL = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
const ordinal = (n: number) => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'TH' : ({ 1: 'ST', 2: 'ND', 3: 'RD' } as Record<number, string>)[n % 10] ?? 'TH';
  return `${n}${s}`;
};

/**
 * Downloads an Excel template that the Import button reads straight back.
 *  - 'grid': the monthly sheet (trucks down, days across, TTL FUEL row) with the given trucks already listed.
 *  - 'list': DATE / VEHICLE / LITRES, one row per fuelling.
 */
export function downloadFuelTemplate(kind: 'grid' | 'list', fuel: FuelType, plates: string[], year: number, month: number): void {
  const monthName = MONTH_FULL[month - 1];
  const days = new Date(year, month, 0).getDate();
  let aoa: any[][];
  let sheetName: string;
  let file: string;

  if (kind === 'grid') {
    const head = ['DATE', ...Array.from({ length: days }, (_, i) => ordinal(i + 1))];
    const trucks = plates.length ? plates : ['KXX 000X'];
    const body = trucks.map(p => [p]);
    const first = 3, last = 2 + trucks.length;
    const col = (i: number) => XLSX.utils.encode_col(i);
    const total = ['TTL FUEL', ...Array.from({ length: days }, (_, i) => ({ t: 'n', f: `SUM(${col(i + 1)}${first}:${col(i + 1)}${last})` }))];
    aoa = [[monthName, fuel.toUpperCase(), 'FUEL RECORD'], head, ...body, total];
    sheetName = 'Fuel record';
    file = `Fuel_Grid_Template_${fuel}_${monthName}.xlsx`;
  } else {
    const d = ordinal(1);
    const mon = monthName.slice(0, 3);
    aoa = [['DATE', 'VEHICLE', 'LITRES'], [`${d} ${mon}`, plates[0] ?? 'KXX 000X', 20], [`${ordinal(3)} ${mon}`, plates[0] ?? 'KXX 000X', 20]];
    sheetName = 'Fuel list';
    file = `Fuel_List_Template_${fuel}.xlsx`;
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 18 }, ...Array.from({ length: kind === 'grid' ? days : 2 }, () => ({ wch: 8 }))];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, file);
}
