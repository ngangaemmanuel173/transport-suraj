// "Skip what is already there, fill what is missing, add what is new" for every bulk import except trips
// (trips have their own, richer version in mergeImport.ts).
//
// Each import says what makes a row "the same record" as one already saved (MERGE_RULES below):
//   trucks      -> plate number              fuel        -> date + truck (+ litres when there are several)
//   drivers     -> name                      tallies     -> date + truck (+ tallage when there are several)
//   containers  -> container number          allowances  -> date + driver (+ amount)
//   spares/tyres-> serial number             compliance  -> truck/driver + type (+ expiry date, so a renewal is new)
//
// planRecordMerge()  looks at one file row and decides what would happen. It reads the database, writes nothing.
// applyRecordPlan()  carries out one plan once the person has checked the preview.
//
// Rules for a row that matches a saved record:
//   - a value that is already saved is NEVER overwritten (if the file differs, the saved value is kept and the preview says so)
//   - a value that is blank / 0 on the saved record and filled in the file is added
//   - nothing left to add  ->  the row is skipped ("Nothing new")

import { supabase } from '@/lib/supabase';
import type { ImportPlan, PlanResult, MergeResult } from '@/lib/mergeImport';

type KeyKind = 'id' | 'date' | 'text' | 'plate';

export type MergeRule = {
  /** What a person calls one record, used in messages */
  noun: string;
  /** Fields that must all match for a saved row to be "the same record" */
  keys: { field: string; kind: KeyKind }[];
  /** Tells apart several saved records that share the keys (e.g. two refuels of one truck on one day) */
  discriminator?: { field: string; kind: 'number' | 'date' | 'text' };
  /** Only look at records of the sub-account being imported into (default true) */
  scopeSub?: boolean;
  /** A saved record that belongs to a different sub-account is a problem, not a match (trucks) */
  subConflict?: boolean;
  /** If set, only these fields may be filled on an existing record; every other field is left alone */
  only?: string[];
  /** Fields never filled and never reported (defaults the importer adds itself, links, bookkeeping) */
  ignore?: string[];
};

export const MERGE_RULES: Record<string, MergeRule> = {
  vehicles: {
    noun: 'truck', scopeSub: false, subConflict: true,
    keys: [{ field: 'plate_number', kind: 'plate' }],
  },
  drivers: {
    noun: 'driver',
    keys: [{ field: 'name', kind: 'text' }],
  },
  sub_account_fuel: {
    noun: 'fuel record',
    keys: [{ field: 'refuel_date', kind: 'date' }, { field: 'vehicle_id', kind: 'id' }],
    discriminator: { field: 'actual_litres', kind: 'number' },
    ignore: ['mcl_area_id', 'trips_since_refuel', 'trip_id', 'documents'],
  },
  sub_account_tallies: {
    noun: 'tally',
    keys: [{ field: 'tally_date', kind: 'date' }, { field: 'vehicle_id', kind: 'id' }],
    discriminator: { field: 'net_tallage', kind: 'number' },
    ignore: ['mcl_area_id', 'trip_id'],
  },
  sub_account_containers: {
    noun: 'container',
    keys: [{ field: 'container_no', kind: 'plate' }],
    ignore: ['mcl_area_id', 'documents'],
  },
  driver_allowances: {
    noun: 'allowance',
    keys: [{ field: 'allowance_date', kind: 'date' }, { field: 'driver_id', kind: 'id' }],
    discriminator: { field: 'amount', kind: 'number' },
    ignore: ['entered_by', 'trip_id'],
  },
  vehicle_compliance_items: {
    noun: 'truck compliance record',
    keys: [{ field: 'vehicle_id', kind: 'id' }, { field: 'compliance_type', kind: 'text' }],
    discriminator: { field: 'expiry_date', kind: 'date' },
    ignore: ['documents'],
  },
  driver_compliance_items: {
    noun: 'driver compliance record',
    keys: [{ field: 'driver_id', kind: 'id' }, { field: 'compliance_type', kind: 'text' }],
    discriminator: { field: 'expiry_date', kind: 'date' },
    ignore: ['documents'],
  },
  spare_parts_v2: {
    noun: 'spare part',
    keys: [{ field: 'serial_number', kind: 'text' }],
    // The importer fills these with defaults when the file leaves them out, so they are not compared
    ignore: ['status', 'part_type', 'category', 'mcl_area_id', 'documents'],
  },
  tyres_v2: {
    noun: 'tyre',
    keys: [{ field: 'serial_number', kind: 'text' }],
    // Where a tyre is fitted, its status and its history are not changed by an import, only these details are filled
    only: ['brand', 'size', 'supplier', 'invoice_number', 'date_in', 'purchase_date', 'unit_cost', 'notes'],
  },
};

const BASE_IGNORE = ['id', 'created_at', 'updated_at', 'sub_account'];

const tidy = (v: unknown) => String(v ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
const plateNorm = (v: unknown) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const day = (v: unknown) => String(v ?? '').slice(0, 10);
const blank = (v: unknown) => v === null || v === undefined || String(v).trim() === '';
const isEmpty = (v: unknown) => blank(v) || v === 0 || v === '0';
const escapeLike = (v: string) => v.replace(/[\\%_]/g, c => `\\${c}`);

function sameKey(kind: KeyKind, a: unknown, b: unknown): boolean {
  if (kind === 'plate') return plateNorm(a) === plateNorm(b);
  if (kind === 'text') return tidy(a) === tidy(b);
  if (kind === 'date') return day(a) === day(b);
  return String(a ?? '') === String(b ?? '');
}

function sameDisc(kind: 'number' | 'date' | 'text', a: unknown, b: unknown): boolean {
  if (kind === 'number') return Number(a) === Number(b);
  if (kind === 'date') return day(a) === day(b);
  return tidy(a) === tidy(b);
}

// Two values that mean the same thing (so they are not reported as a difference)
function looseSame(a: unknown, b: unknown): boolean {
  const sa = String(a ?? '').trim(), sb = String(b ?? '').trim();
  if (sa !== '' && sb !== '' && isFinite(Number(sa)) && isFinite(Number(sb))) return Number(sa) === Number(sb);
  if (/^\d{4}-\d{2}-\d{2}/.test(sa) && /^\d{4}-\d{2}-\d{2}/.test(sb)) return day(sa) === day(sb);
  return tidy(sa) === tidy(sb);
}

// Saved rows are read once per search and reused for the rows that follow (a 200-row file would otherwise
// ask the database 200 times for the same list of trucks). Cleared whenever something is saved.
const cache = new Map<string, { at: number; rows: any[] }>();
const CACHE_MS = 20000;

async function fetchRows(table: string, filters: [string, string, 'eq' | 'ilike'][]): Promise<{ rows: any[]; error?: string }> {
  const key = `${table}|${JSON.stringify(filters)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return { rows: hit.rows };
  let q = supabase.from(table).select('*');
  for (const [field, value, how] of filters) q = how === 'ilike' ? q.ilike(field, value) : q.eq(field, value);
  const { data, error } = await q.limit(1000);
  if (error) return { rows: [], error: error.message };
  cache.set(key, { at: Date.now(), rows: data || [] });
  return { rows: data || [] };
}

type Candidate = { data: Record<string, any>; inFile: boolean; id?: string; plan?: ImportPlan };

export async function planRecordMerge(
  rule: MergeRule, table: string, rec: Record<string, any>, earlier: ImportPlan[],
): Promise<PlanResult> {
  // Without all the identifying values there is nothing to match on: it is treated as a new record.
  if (rule.keys.some(k => blank(rec[k.field]))) return { action: 'insert', record: rec };

  const filters: [string, string, 'eq' | 'ilike'][] = [];
  if (rule.scopeSub !== false && rec.sub_account) filters.push(['sub_account', String(rec.sub_account), 'eq']);
  for (const k of rule.keys) {
    if (k.kind === 'id') filters.push([k.field, String(rec[k.field]), 'eq']);
    else if (k.kind === 'date') filters.push([k.field, day(rec[k.field]), 'eq']);
    else if (k.kind === 'text') filters.push([k.field, escapeLike(String(rec[k.field]).trim()), 'ilike']);
  }
  const found = await fetchRows(table, filters);
  if (found.error) return { action: 'error', record: rec, message: found.error };

  const sameAll = (d: Record<string, any>) => rule.keys.every(k => sameKey(k.kind, d[k.field], rec[k.field]));

  // Saved records as they will look once the earlier rows of this file are applied,
  // plus the new records that earlier rows of this same file would add.
  const candidates: Candidate[] = found.rows.filter(sameAll).map((t: any) => {
    const filled = Object.assign({}, ...earlier.filter(p => p.action === 'update' && p.matchId === t.id).map(p => p.patch));
    return { data: { ...t, ...filled }, inFile: false, id: t.id };
  });
  for (const p of earlier) {
    if (p.action === 'insert' && sameAll(p.record)) candidates.push({ data: p.record, inFile: true, plan: p as ImportPlan });
  }

  if (rule.subConflict && candidates.length > 0 && !candidates[0].inFile) {
    const savedSub = String(candidates[0].data.sub_account ?? '').toLowerCase();
    const fileSub = String(rec.sub_account ?? '').toLowerCase();
    if (savedSub && fileSub && savedSub !== fileSub) {
      return { action: 'error', record: rec, message: `This ${rule.noun} is already registered under ${savedSub.toUpperCase()}.` };
    }
  }

  // Which saved record is this row?
  let match: Candidate | undefined;
  const disc = rule.discriminator;
  if (disc && !isEmpty(rec[disc.field])) {
    match = candidates.find(c => sameDisc(disc.kind, c.data[disc.field], rec[disc.field]));
    if (!match) {
      // a saved record that has no value yet may be the one this row completes
      const blanks = candidates.filter(c => isEmpty(c.data[disc.field]));
      if (blanks.length === 1) match = blanks[0];
      else if (blanks.length > 1) return { action: 'error', record: rec, message: `Several saved ${rule.noun}s are missing ${disc.field.replace(/_/g, ' ')}. Fill it in the system first.` };
    }
  } else if (candidates.length === 1) {
    match = candidates[0];
  } else if (candidates.length > 1) {
    return {
      action: 'error', record: rec,
      message: disc
        ? `Several ${rule.noun}s match. Add ${disc.field.replace(/_/g, ' ')} to the file so the right one is updated.`
        : `More than one saved ${rule.noun} matches this row.`,
    };
  }

  // Nothing saved yet: it will be added as new
  if (!match) return { action: 'insert', record: rec };

  // Fill only what is blank on the saved record
  const skip = new Set([...BASE_IGNORE, ...(rule.ignore || []), ...rule.keys.map(k => k.field)]);
  const patch: Record<string, any> = {};
  const kept: { field: string; file: any; saved: any }[] = [];
  for (const [k, v] of Object.entries(rec)) {
    if (skip.has(k) || isEmpty(v)) continue;
    if (rule.only && !rule.only.includes(k)) continue;
    if (!match.inFile && !(k in match.data)) continue; // not a column of the saved record
    if (isEmpty(match.data[k])) patch[k] = v;
    else if (!looseSame(match.data[k], v)) kept.push({ field: k, file: v, saved: match.data[k] });
  }

  // Same record as an earlier row of this file: fold the details into it
  if (match.inFile) {
    Object.assign(match.plan!.record, patch);
    return { action: 'infile', record: rec, patch, kept, message: `Same ${rule.noun} as an earlier row in the file; the details were combined.` };
  }
  if (Object.keys(patch).length === 0) return { action: 'unchanged', record: rec, matchId: match.id, kept, message: 'Nothing new to add.' };
  return { action: 'update', record: rec, matchId: match.id, patch, kept };
}

export async function applyRecordPlan(
  table: string, plan: ImportPlan,
  insertNew?: (record: Record<string, any>) => Promise<{ ok: boolean; skipped?: boolean; error?: string }>,
): Promise<MergeResult> {
  cache.clear();
  if (plan.action === 'insert') {
    if (insertNew) return insertNew(plan.record);
    const { error } = await supabase.from(table).insert([plan.record]);
    return error ? { ok: false, error: error.message } : { ok: true };
  }
  if (plan.action === 'update' && plan.matchId && plan.patch) {
    const { error } = await supabase.from(table).update(plan.patch).eq('id', plan.matchId);
    return error ? { ok: false, error: error.message } : { ok: true, updated: true };
  }
  return { ok: false, skipped: true };
}
