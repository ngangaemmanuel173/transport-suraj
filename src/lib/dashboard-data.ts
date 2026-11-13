import { supabase } from '@/lib/supabase';
import { dayTotals, parseSources, TRIP_NUMS, type McRate } from '@/lib/mclGrid';

export const DASH_SUBS = ['mcl', 'tarmal', 'csl', 'pn_mashru'] as const;
export type DashSub = (typeof DASH_SUBS)[number];

export const TRIP_TABLE: Record<DashSub, string> = {
  mcl: 'mcl_trips',
  csl: 'csl_trips',
  tarmal: 'tarmal_trips',
  pn_mashru: 'pn_mashru_trips',
};

export interface DashRaw {
  vehicles: { id: string }[];
  drivers: { id: string }[];
  containers: { id: string; vehicle_id: string | null }[];
  trips: { vehicle_id: string | null; driver_id: string | null; count: number; tons: number }[];
  revenue: { vehicle_id: string | null; driver_id: string | null; amount: number }[];
  fuel: { vehicle_id: string | null; driver_id: string | null; amount: number }[];
  mileage: { vehicle_id: string | null; driver_id: string | null; km: number }[];
  maintenance: { vehicle_id: string | null; amount: number }[];
  sparesInStore: { vehicle_id: string | null }[];
  errors: string[];
}

export const monthOf = (d: unknown) => String(d ?? '').slice(0, 7);
export const endOfMonth = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
export const thisMonth = () => new Date().toLocaleDateString('en-CA').slice(0, 7);
export const shiftMonth = (ym: string, delta: number) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
};

/** Reads every page of a query (Supabase returns at most 1000 rows per request). */
async function pagedAll(make: () => any): Promise<{ data: any[]; error?: string }> {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const r = await make().range(from, from + 999);
    if (r.error) return { data: out, error: r.error.message };
    out.push(...(r.data || []));
    if (!r.data || r.data.length < 1000) break;
  }
  return { data: out };
}

const num = (v: unknown) => Number(v) || 0;

export async function loadDashboardRaw(
  sa: DashSub,
  fromMonth: string,
  toMonth: string,
  mclArea?: string | null,
): Promise<DashRaw> {
  const start = `${fromMonth}-01`;
  const end = endOfMonth(toMonth);
  const inRange = (d: unknown) => {
    const s = String(d ?? '').slice(0, 10);
    return !!s && s >= start && s <= end;
  };
  const errors: string[] = [];
  const note = (what: string, e?: string) => { if (e) errors.push(`${what}: ${e}`); };

  const tripTable = TRIP_TABLE[sa];
  const [veh, drv, cont, tripsRes, ratesRes, manualRev, fuelRes, mileRes, sparesRes, tyresRes] = await Promise.all([
    supabase.from('vehicles').select('id').eq('sub_account', sa).eq('status', 'active'),
    supabase.from('drivers').select('id').eq('sub_account', sa).eq('status', 'active'),
    supabase.from('sub_account_containers').select('id, vehicle_id').eq('sub_account', sa).eq('status', 'active'),
    pagedAll(() => {
      let q: any = supabase.from(tripTable).select('*');
      if (sa === 'mcl' && mclArea) q = q.eq('mcl_area_id', mclArea);
      return q.order('id');
    }),
    sa === 'mcl' ? supabase.from('mcl_rates').select('*').eq('sub_account', 'mcl') : Promise.resolve({ data: [] as any[], error: null }),
    supabase.from('truck_revenue').select('vehicle_id, period, amount').eq('sub_account', sa).gte('period', start).lte('period', end),
    pagedAll(() => supabase.from('sub_account_fuel').select('vehicle_id, driver_id, total_cost').eq('sub_account', sa).gte('refuel_date', start).lte('refuel_date', end).order('id')),
    pagedAll(() => supabase.from('driver_mileage').select('vehicle_id, driver_id, km_covered').eq('sub_account', sa).gte('entry_date', start).lte('entry_date', end).order('id')),
    pagedAll(() => supabase.from('spare_parts_v2').select('id, unit_cost, status, current_truck_id, installed_date, purchase_date, created_at').eq('sub_account', sa).order('id')),
    pagedAll(() => supabase.from('tyres_v2').select('id, unit_cost, current_truck_id, fitted_date').eq('sub_account', sa).gte('fitted_date', start).lte('fitted_date', end).order('id')),
  ]);

  note('vehicles', (veh as any).error?.message);
  note('drivers', (drv as any).error?.message);
  note('trips', tripsRes.error);
  note('rates', (ratesRes as any).error?.message);
  note('revenue', (manualRev as any).error?.message);
  note('fuel', fuelRes.error);
  note('mileage', mileRes.error);
  note('spares', sparesRes.error);
  note('tyres', tyresRes.error);

  const rates: McRate[] = ((ratesRes as any).data || []).map((r: any) => ({ ...r, rate_per_ton: num(r.rate_per_ton), fuel_litres: num(r.fuel_litres) }));
  const trips: DashRaw['trips'] = [];
  const revenue: DashRaw['revenue'] = [];
  const autoKeys = new Set<string>();

  for (const t of tripsRes.data) {
    const date = t.trip_date || t.date_loaded || t.date_delivered;
    if (!inRange(date)) continue;
    if (sa === 'mcl') {
      const weights: Record<number, number> = {};
      TRIP_NUMS.forEach(n => { weights[n] = num(t[`trip_${n}`]); });
      const tot = dayTotals({ weights, sources: parseSources(t.notes) }, String(date).slice(0, 10), rates);
      if (!tot.trips) continue;
      trips.push({ vehicle_id: t.vehicle_id, driver_id: t.driver_id ?? null, count: tot.trips, tons: tot.tons });
      revenue.push({ vehicle_id: t.vehicle_id, driver_id: t.driver_id ?? null, amount: tot.revenue });
      autoKeys.add(`${t.vehicle_id}|${monthOf(date)}`);
    } else {
      trips.push({ vehicle_id: t.vehicle_id, driver_id: t.driver_id ?? null, count: 1, tons: num(t.net_tallage) });
      if (sa === 'pn_mashru' && t.trip_amount != null && num(t.trip_amount) > 0) {
        revenue.push({ vehicle_id: t.vehicle_id, driver_id: t.driver_id ?? null, amount: num(t.trip_amount) });
        autoKeys.add(`${t.vehicle_id}|${monthOf(date)}`);
      }
    }
  }

  for (const r of ((manualRev as any).data || []) as any[]) {
    if (autoKeys.has(`${r.vehicle_id}|${monthOf(r.period)}`)) continue;
    revenue.push({ vehicle_id: r.vehicle_id, driver_id: null, amount: num(r.amount) });
  }

  const maintenance: DashRaw['maintenance'] = [];
  for (const p of sparesRes.data) {
    const undatedStore = p.status === 'in_store' && !p.purchase_date;
    const date = p.purchase_date || p.installed_date || (p.created_at ? String(p.created_at).slice(0, 10) : null);
    if (undatedStore || inRange(date)) maintenance.push({ vehicle_id: p.current_truck_id || null, amount: num(p.unit_cost) });
  }
  for (const t of tyresRes.data) maintenance.push({ vehicle_id: t.current_truck_id || null, amount: num(t.unit_cost) });

  return {
    vehicles: (veh as any).data || [],
    drivers: (drv as any).data || [],
    containers: (cont as any).data || [],
    trips,
    revenue,
    fuel: fuelRes.data.map(r => ({ vehicle_id: r.vehicle_id, driver_id: r.driver_id ?? null, amount: num(r.total_cost) })),
    mileage: mileRes.data.map(r => ({ vehicle_id: r.vehicle_id, driver_id: r.driver_id ?? null, km: num(r.km_covered) })),
    maintenance,
    sparesInStore: sparesRes.data.filter(p => p.status === 'in_store').map(p => ({ vehicle_id: p.current_truck_id || null })),
    errors,
  };
}

export interface DashTotals {
  revenue: number;
  distance: number;
  fuel: number;
  maintenance: number;
  trips: number;
  tons: number;
  vehicles: number;
  drivers: number;
  containers: number;
  sparesInStore: number;
}

export function summarize(raw: DashRaw, ok: (vehicleId?: string | null, driverId?: string | null) => boolean): DashTotals {
  const sum = <T,>(rows: T[], pick: (r: T) => number, pass: (r: T) => boolean) => rows.filter(pass).reduce((a, r) => a + pick(r), 0);
  return {
    revenue: sum(raw.revenue, r => r.amount, r => ok(r.vehicle_id, r.driver_id)),
    distance: sum(raw.mileage, r => r.km, r => ok(r.vehicle_id, r.driver_id)),
    fuel: sum(raw.fuel, r => r.amount, r => ok(r.vehicle_id, r.driver_id)),
    maintenance: sum(raw.maintenance, r => r.amount, r => ok(r.vehicle_id, null)),
    trips: sum(raw.trips, r => r.count, r => ok(r.vehicle_id, r.driver_id)),
    tons: sum(raw.trips, r => r.tons, r => ok(r.vehicle_id, r.driver_id)),
    vehicles: raw.vehicles.filter(v => ok(v.id, null)).length,
    drivers: raw.drivers.filter(d => ok(null, d.id)).length,
    containers: raw.containers.filter(c => ok(c.vehicle_id, null)).length,
    sparesInStore: raw.sparesInStore.filter(s => ok(s.vehicle_id, null)).length,
  };
}
