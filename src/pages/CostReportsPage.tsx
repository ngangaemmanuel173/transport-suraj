import { useTruckDriverFilter, TruckDriverBar } from '@/components/TruckDriverFilter';
import { useEffect, useState, useCallback, useMemo, type ReactNode } from 'react';
import { FileText, Plus, Trash2, Download, Upload } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { LoadingSpinner } from '@/components/Shared';
import { useToast } from '@/components/Toast';
import { SubAccount } from '@/lib/portals';
import { BulkImportModal } from '@/components/BulkImportModal';
import { resolveNamesToIds } from '@/lib/importLookups';
import { REVENUE_COLUMNS, TRUCK_COST_COLUMNS, COST_ENTRY_COLUMNS, SALARY_COLUMNS } from '@/lib/importColumns';
import { downloadTemplate, type TemplateName } from '@/lib/templates';
import { withVat, VAT_MULTIPLIER } from '@/lib/vat';

/* ------------------------------------------------------------------ */
/* Reports & Costs                                                     */
/* Truck summary (revenue - all expenditure = profit), the three cost  */
/* reports (maintenance & truck, financial, employment) and overhead.  */
/* Used by: reports clerk + corporate admin (all sub-accounts) and by  */
/* managers (locked to their own sub-account).                         */
/* ------------------------------------------------------------------ */

const SUBS: { value: SubAccount; label: string }[] = [
  { value: 'mcl', label: 'MCL' }, { value: 'csl', label: 'CSL' },
  { value: 'pn_mashru', label: 'PN Mashru' }, { value: 'tarmal', label: 'Tarmal' },
];
const subLabel = (v: string) => SUBS.find(s => s.value === v)?.label || v;

type CostType = 'financial' | 'employment' | 'overhead' | 'miscellaneous';
const CATEGORIES: Record<CostType, { title: string; hint: string; items: string[] }> = {
  financial: { title: 'Financial Cost', hint: 'Insurance, loan and leasing (figures from the accountant)', items: ['insurance', 'loan', 'leasing'] },
  employment: { title: 'Employment Cost', hint: 'Labour and consultancy (from the accountant) plus driver salaries', items: ['labour', 'consultancy'] },
  overhead: { title: 'Overhead Cost', hint: 'Rent, internet, electricity and water', items: ['rent', 'internet', 'electricity', 'water'] },
  miscellaneous: { title: 'Miscellaneous Expenses', hint: 'Anything that does not fit another category. Pick a truck and it is deducted from that truck\'s profit.', items: ['fines', 'tolls', 'parking', 'permits', 'accommodation', 'general'] },
};

const inputCls = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-slate-500';
const labelCls = 'block text-xs font-semibold text-slate-600 mb-1';
const kes = (n: number) => `KES ${Math.round(n).toLocaleString('en-KE')}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const thisMonth = () => new Date().toLocaleDateString('en-CA').slice(0, 7);
const monthLabel = (d: string) => new Date(d).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
const endOfMonth = (ym: string) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

const vatPct = Math.round((VAT_MULTIPLIER - 1) * 100);

/** Accepts 2026-10, 2026/10, 10/2026, 01/10/2026 or Oct-26 / October 2026 and returns YYYY-MM */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const parseMonth = (v: unknown): string => {
  const s = String(v ?? '').trim();
  let y = '', m = '', hit: RegExpMatchArray | null;
  if ((hit = s.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?$/))) { y = hit[1]; m = hit[2]; }
  else if ((hit = s.match(/^(\d{1,2})[-/.](\d{4})$/))) { m = hit[1]; y = hit[2]; }
  else if ((hit = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) { m = hit[2]; y = hit[3]; }
  else if ((hit = s.match(/^([A-Za-z]{3,9})[\s\-/.]+(\d{2}|\d{4})$/))) {
    const idx = MONTHS.indexOf(hit[1].slice(0, 3).toLowerCase());
    if (idx >= 0) { m = String(idx + 1); y = hit[2].length === 2 ? `20${hit[2]}` : hit[2]; }
  }
  const mn = Number(m);
  if (!y || mn < 1 || mn > 12) throw new Error(`Month "${s}" is not valid. Use YYYY-MM, for example 2026-10`);
  return `${y}-${String(mn).padStart(2, '0')}`;
};
/** blank = 0; otherwise a number (commas and "KES" are ignored) */
const parseAmt = (v: unknown, label = 'Amount'): number => {
  if (v === undefined || v === null || String(v).trim() === '') return 0;
  const n = Number(String(v).replace(/kes/i, '').replace(/[,\s]/g, ''));
  if (Number.isNaN(n) || n < 0) throw new Error(`${label} "${v}" is not a valid amount`);
  return n;
};

type View = 'summary' | 'revenue' | 'truckcosts' | 'maintenance' | 'financial' | 'employment' | 'overhead' | 'miscellaneous';

function EntryForm({ children, onSave, saving, color, note }: { children: ReactNode; onSave: () => void; saving: boolean; color: string; note?: ReactNode }) {
  return (
    <div className="card p-4 space-y-3">
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3 items-end">{children}
        <button onClick={onSave} disabled={saving} className="flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" style={{ background: color }}>
          <Plus className="h-4 w-4" /> {saving ? 'Saving...' : 'Add'}
        </button>
      </div>
      {note && <p className="text-xs text-slate-500">{note}</p>}
    </div>
  );
}

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return <div className="card table-wrapper overflow-x-auto"><table className="data-table"><thead><tr>{head.map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;
}

function ImportBar({ template, onImport, label = 'Bulk Import' }: { template: TemplateName; onImport: () => void; label?: string }) {
  const btn = 'flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50';
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <button onClick={() => downloadTemplate(template)} className={btn}><Download className="h-4 w-4" /> Download Template</button>
      <button onClick={onImport} className={btn}><Upload className="h-4 w-4" /> {label}</button>
    </div>
  );
}

function Num({ v, bold }: { v: number; bold?: boolean }) {
  return <td className={`text-right tabular-nums ${bold ? 'font-bold' : ''}`}>{kes(v)}</td>;
}

export function CostReportsPage({ portalColor, lockedSubAccount }: { portalColor: string; lockedSubAccount?: SubAccount }) {
  const { showToast } = useToast();
  const { profile } = useAuth();
  const toast = useCallback((m: string, t: 'success' | 'error' = 'success') => (showToast as any)(m, t), [showToast]);
  const who = (profile as any)?.full_name || (profile as any)?.email || 'Unknown';

  const [view, setView] = useState<View>('summary');
  const [sub, setSub] = useState<string>(lockedSubAccount ?? 'all');
  const [fromM, setFromM] = useState(thisMonth());
  const [toM, setToM] = useState(thisMonth());
  const [truck, setTruck] = useState('all');
  const [loading, setLoading] = useState(true);
  const [d, setD] = useState<any>({ vehicles: [], drivers: [], fuel: [], hist: [], parts: [], tyres: [], revenue: [], costs: [], salaries: [], truckCosts: [] });

  const effSub = lockedSubAccount ?? sub;
  const tdf = useTruckDriverFilter(effSub);

  const load = useCallback(async () => {
    setLoading(true);
    const start = `${fromM}-01`, end = endOfMonth(toM);
    const scope = (q: any) => (effSub !== 'all' ? q.eq('sub_account', effSub) : q);
    const [veh, drv, fuel, hist, parts, tyres, rev, costs, sal, tcs] = await Promise.all([
      scope(supabase.from('vehicles').select('id, plate_number, sub_account').order('plate_number')),
      supabase.from('drivers').select('id, name'),
      scope(supabase.from('sub_account_fuel').select('vehicle_id, total_cost, refuel_date, sub_account').gte('refuel_date', start).lte('refuel_date', end)),
      supabase.from('spare_part_history').select('spare_part_id, action, action_date, truck_id').eq('action', 'installed').gte('action_date', start).lte('action_date', end),
      scope(supabase.from('spare_parts_v2').select('id, part_name, unit_cost, sub_account')),
      scope(supabase.from('tyres_v2').select('id, serial_number, brand, unit_cost, fitted_date, current_truck_id, sub_account').gte('fitted_date', start).lte('fitted_date', end)),
      scope(supabase.from('truck_revenue').select('*').gte('period', start).lte('period', end)),
      scope(supabase.from('cost_entries').select('*').gte('period', start).lte('period', end).order('period', { ascending: false })),
      scope(supabase.from('driver_salaries').select('*').gte('period', start).lte('period', end).order('period', { ascending: false })),
      scope(supabase.from('truck_costs').select('*').gte('period', start).lte('period', end).order('period', { ascending: false })),
    ]);
    const firstErr = [veh, fuel, hist, parts, tyres, rev, costs, sal, tcs].find((r: any) => r.error) as any;
    if (firstErr) toast(`Some data could not load: ${firstErr.error.message}`, 'error');
    setD({
      vehicles: veh.data || [], drivers: drv.data || [], fuel: fuel.data || [], hist: hist.data || [], parts: parts.data || [],
      tyres: tyres.data || [], revenue: rev.data || [], costs: costs.data || [], salaries: sal.data || [], truckCosts: tcs.data || [],
    });
    setLoading(false);
  }, [effSub, fromM, toM, toast]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setTruck('all'); }, [effSub]);

  const plate = useMemo(() => Object.fromEntries(d.vehicles.map((v: any) => [v.id, v.plate_number])), [d.vehicles]);
  const vehSub = useMemo(() => Object.fromEntries(d.vehicles.map((v: any) => [v.id, v.sub_account])), [d.vehicles]);
  const driverName = useMemo(() => Object.fromEntries(d.drivers.map((x: any) => [x.id, x.name])), [d.drivers]);
  const partMap = useMemo(() => Object.fromEntries(d.parts.map((p: any) => [p.id, p])), [d.parts]);

  // Spares cost = unit cost of each part installed in the period, charged to the truck it went on
  const spareItems = useMemo(() => d.hist
    .filter((h: any) => partMap[h.spare_part_id])
    .map((h: any) => ({ date: h.action_date, truck: h.truck_id, name: partMap[h.spare_part_id].part_name, cost: Number(partMap[h.spare_part_id].unit_cost || 0), sub: partMap[h.spare_part_id].sub_account })), [d.hist, partMap]);
  const tyreItems = useMemo(() => d.tyres.map((t: any) => ({ date: t.fitted_date, truck: t.current_truck_id, name: `${t.brand || 'Tyre'} ${t.serial_number || ''}`.trim(), cost: Number(t.unit_cost || 0), sub: t.sub_account })), [d.tyres]);

  const salariesF = useMemo(() => (tdf.driver === 'all' ? d.salaries : d.salaries.filter((x: any) => x.driver_id === tdf.driver)), [d.salaries, tdf.driver]);

  const rows = useMemo(() => {
    const trucks = d.vehicles.filter((v: any) => (truck === 'all' || v.id === truck) && tdf.okRow(v.id, null));
    const sum = (arr: any[], key: string, id: string, f: string) => arr.filter(x => x[key] === id).reduce((a, x) => a + Number(x[f] || 0), 0);
    return trucks.map((v: any) => {
      const revenue = sum(d.revenue, 'vehicle_id', v.id, 'amount');
      const fuel = sum(d.fuel, 'vehicle_id', v.id, 'total_cost');
      const spares = sum(spareItems, 'truck', v.id, 'cost');
      const tyres = sum(tyreItems, 'truck', v.id, 'cost');
      const salaries = sum(salariesF, 'vehicle_id', v.id, 'amount');
      const other = sum(d.costs, 'vehicle_id', v.id, 'amount');
      const insurance = sum(d.truckCosts, 'vehicle_id', v.id, 'insurance');
      const loans = sum(d.truckCosts, 'vehicle_id', v.id, 'loan');
      const allowance = sum(d.truckCosts, 'vehicle_id', v.id, 'driver_allowance');
      const cost = fuel + spares + tyres + salaries + other + insurance + loans + allowance;
      return { id: v.id, plate: v.plate_number, sub: v.sub_account, revenue, fuel, spares, tyres, salaries, insurance, loans, allowance, other, cost, profit: revenue - cost };
    });
  }, [d, truck, spareItems, tyreItems, salariesF, tdf.okRow]);

  const tot = rows.reduce((a: any, r: any) => {
    for (const k of ['revenue', 'fuel', 'spares', 'tyres', 'salaries', 'insurance', 'loans', 'allowance', 'other', 'cost', 'profit']) a[k] = (a[k] || 0) + r[k];
    return a;
  }, {} as any);
  const unallocated = d.costs.filter((c: any) => !c.vehicle_id).reduce((a: number, c: any) => a + Number(c.amount || 0), 0)
    + salariesF.filter((c: any) => !c.vehicle_id).reduce((a: number, c: any) => a + Number(c.amount || 0), 0);

  const exportCsv = () => {
    const head = ['Truck', 'Sub-account', 'Revenue', 'Fuel', 'Spares', 'Tyres', 'Driver salaries', 'Insurance', 'Loans', 'Driver allowance', 'Other truck costs', 'Total cost', 'Profit'];
    const lines = rows.map((r: any) => [r.plate, subLabel(r.sub), r.revenue, r.fuel, r.spares, r.tyres, r.salaries, r.insurance, r.loans, r.allowance, r.other, r.cost, r.profit].join(','));
    const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `truck-profit-${fromM}_to_${toM}.csv`; a.click();
  };

  /* ---------------- generic entry panel (financial / employment / overhead) ---------------- */
  const remove = async (table: string, id: string) => {
    if (!confirm('Delete this entry?')) return;
    const { error } = await supabase.from(table).delete().eq('id', id);
    if (error) return toast(error.message, 'error');
    load();
  };

  const [ef, setEf] = useState({ sub: lockedSubAccount ?? 'mcl', month: thisMonth(), category: '', truck: '', amount: '', notes: '', driver: '' });
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (effSub !== 'all') setEf(f => ({ ...f, sub: effSub })); }, [effSub]);
  const formTrucks = d.vehicles.filter((v: any) => v.sub_account === ef.sub);

  const SubPick = () => lockedSubAccount ? null : (
    <div><label className={labelCls}>Sub-account</label>
      <select value={ef.sub} onChange={e => setEf({ ...ef, sub: e.target.value, truck: '' })} className={inputCls}>{SUBS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}</select></div>
  );
  const TruckPick = (optionalLabel: string) => (
    <div><label className={labelCls}>Truck</label>
      <select value={ef.truck} onChange={e => setEf({ ...ef, truck: e.target.value })} className={inputCls}><option value="">{optionalLabel}</option>{formTrucks.map((v: any) => <option key={v.id} value={v.id}>{v.plate_number}</option>)}</select></div>
  );

  const saveCost = async (type: CostType) => {
    const amount = Number(ef.amount);
    if (!ef.category) return toast('Choose the cost category', 'error');
    if (!amount || amount <= 0) return toast('Enter the amount', 'error');
    setSaving(true);
    const { error } = await supabase.from('cost_entries').insert({
      sub_account: ef.sub, vehicle_id: ef.truck || null, report_type: type, category: ef.category,
      period: `${ef.month}-01`, amount, notes: ef.notes.trim() || null, entered_by: who,
    });
    setSaving(false);
    if (error) return toast(error.message, 'error');
    toast('Saved'); setEf({ ...ef, amount: '', notes: '' }); load();
  };

  const saveSalary = async () => {
    const amount = Number(ef.amount);
    if (!ef.driver) return toast('Choose the driver', 'error');
    if (!amount || amount <= 0) return toast('Enter the salary amount', 'error');
    setSaving(true);
    const { error } = await supabase.from('driver_salaries').insert({
      sub_account: ef.sub, driver_id: ef.driver, vehicle_id: ef.truck || null, period: `${ef.month}-01`, amount, notes: ef.notes.trim() || null, entered_by: who,
    });
    setSaving(false);
    if (error) return toast(error.message, 'error');
    toast('Salary saved'); setEf({ ...ef, amount: '', notes: '' }); load();
  };

  /* ---------------- revenue + per-truck costs: x116%, then ADDED to what is already saved ---------------- */
  const subOfTruck = (vehicleId: string, fallback: string) => vehSub[vehicleId] || fallback;

  const addRevenue = async (sub: string, vehicleId: string, ym: string, amount: number, notes?: string | null) => {
    const { error } = await supabase.rpc('add_truck_revenue', {
      p_sub_account: sub, p_vehicle_id: vehicleId, p_period: `${ym}-01`, p_amount: withVat(amount), p_notes: notes || null, p_entered_by: who,
    });
    return error;
  };
  const addTruckCosts = async (sub: string, vehicleId: string, ym: string, c: { insurance: number; loan: number; driver_allowance: number }) => {
    const { error } = await supabase.rpc('add_truck_costs', {
      p_sub_account: sub, p_vehicle_id: vehicleId, p_period: `${ym}-01`,
      p_insurance: withVat(c.insurance), p_loan: withVat(c.loan), p_driver_allowance: withVat(c.driver_allowance), p_entered_by: who,
    });
    return error;
  };

  const saveRevenue = async () => {
    const amount = Number(ef.amount);
    if (!ef.truck) return toast('Choose the truck', 'error');
    if (!(amount > 0)) return toast('Enter the revenue', 'error');
    setSaving(true);
    const error = await addRevenue(subOfTruck(ef.truck, ef.sub), ef.truck, ef.month, amount, ef.notes.trim());
    setSaving(false);
    if (error) return toast(error.message, 'error');
    toast(`Added ${kes(withVat(amount))} (incl. ${vatPct}% tax) to the truck's revenue`); setEf({ ...ef, amount: '', notes: '' }); load();
  };

  // Insurance / Loans / Driver allowance grid: one row per truck for the chosen month
  const [grid, setGrid] = useState<Record<string, { insurance: string; loan: string; driver_allowance: string }>>({});
  const [saved, setSaved] = useState<Record<string, any>>({});
  const loadSaved = useCallback(async () => {
    let q = supabase.from('truck_costs').select('*').eq('period', `${ef.month}-01`);
    if (effSub !== 'all') q = q.eq('sub_account', effSub);
    const { data } = await q;
    setSaved(Object.fromEntries((data || []).map((r: any) => [r.vehicle_id, r])));
  }, [ef.month, effSub]);
  useEffect(() => { loadSaved(); }, [loadSaved]);
  const setCell = (id: string, k: 'insurance' | 'loan' | 'driver_allowance', v: string) =>
    setGrid(g => ({ ...g, [id]: { insurance: '', loan: '', driver_allowance: '', ...g[id], [k]: v } }));

  const saveTruckCosts = async () => {
    const entries = Object.entries(grid)
      .map(([id, g]) => ({ id, insurance: Number(g.insurance) || 0, loan: Number(g.loan) || 0, driver_allowance: Number(g.driver_allowance) || 0 }))
      .filter(e => e.insurance > 0 || e.loan > 0 || e.driver_allowance > 0);
    if (!entries.length) return toast('Type an amount for at least one truck', 'error');
    setSaving(true);
    let failed = '';
    const done: string[] = [];
    for (const e of entries) {
      const err = await addTruckCosts(subOfTruck(e.id, ef.sub), e.id, ef.month, e);
      if (err) { failed = err.message; break; }
      done.push(e.id);
    }
    setSaving(false);
    // clear only what was saved so a failed row is not lost or double-added
    setGrid(g => { const n = { ...g }; done.forEach(id => delete n[id]); return n; });
    if (failed) toast(`${done.length} truck(s) saved, then an error: ${failed}`, 'error');
    else toast(`Saved for ${done.length} truck(s) (incl. ${vatPct}% tax, added to the existing figures)`);
    load(); loadSaved();
  };

  /* ---------------- bulk import (same columns as each tab's form) ---------------- */
  const [bulk, setBulk] = useState<null | 'revenue' | 'truckcosts' | 'costs' | 'salaries'>(null);
  const costType: CostType | null = (['financial', 'employment', 'overhead', 'miscellaneous'] as string[]).includes(view) ? (view as CostType) : null;
  const sampleTruck = d.vehicles[0]?.plate_number || 'KDG 123A';
  const sampleDriver = d.drivers[0]?.name || 'John Kamau';
  const sampleMonth = thisMonth();

  const truckOf = (rec: Record<string, any>, required: boolean) => {
    const r = resolveNamesToIds(rec, d.vehicles, d.drivers);
    if (required && !r.vehicle_id) throw new Error('Truck is required');
    return r;
  };
  const wrap = (fn: (rec: Record<string, any>) => Promise<string | null | undefined>) => async (rec: Record<string, any>) => {
    try { const err = await fn(rec); return err ? { ok: false, error: err } : { ok: true }; }
    catch (e: any) { return { ok: false, error: e?.message || 'could not be saved' }; }
  };

  const importRevenue = wrap(async rec => {
    const r = truckOf(rec, true); const ym = parseMonth(rec.month); const amt = parseAmt(rec.amount, 'Revenue');
    if (!(amt > 0)) throw new Error('Revenue is required');
    return (await addRevenue(subOfTruck(r.vehicle_id, rec.sub_account), r.vehicle_id, ym, amt, rec.notes))?.message;
  });
  const importTruckCosts = wrap(async rec => {
    const r = truckOf(rec, true); const ym = parseMonth(rec.month);
    const c = { insurance: parseAmt(rec.insurance, 'Insurance'), loan: parseAmt(rec.loan, 'Loan'), driver_allowance: parseAmt(rec.driver_allowance, 'Driver allowance') };
    if (!(c.insurance > 0 || c.loan > 0 || c.driver_allowance > 0)) throw new Error('Enter insurance, loan or driver allowance');
    return (await addTruckCosts(subOfTruck(r.vehicle_id, rec.sub_account), r.vehicle_id, ym, c))?.message;
  });
  const importCosts = (type: CostType) => wrap(async rec => {
    const r = truckOf(rec, false); const ym = parseMonth(rec.month); const amt = parseAmt(rec.amount);
    const category = String(rec.category || '').trim().toLowerCase();
    const allowed = [...CATEGORIES[type].items, 'other'];
    if (!allowed.includes(category)) throw new Error(`Category "${rec.category ?? ''}" must be one of: ${allowed.join(', ')}`);
    if (!(amt > 0)) throw new Error('Amount is required');
    const { error } = await supabase.from('cost_entries').insert({
      sub_account: r.vehicle_id ? subOfTruck(r.vehicle_id, rec.sub_account) : rec.sub_account, vehicle_id: r.vehicle_id || null, report_type: type, category,
      period: `${ym}-01`, amount: amt, notes: rec.notes || null, entered_by: who,
    });
    return error?.message;
  });
  const importSalaries = wrap(async rec => {
    const r = truckOf(rec, false); const ym = parseMonth(rec.month); const amt = parseAmt(rec.amount, 'Salary');
    if (!r.driver_id) throw new Error('Driver is required');
    if (!(amt > 0)) throw new Error('Salary amount is required');
    const { error } = await supabase.from('driver_salaries').insert({
      sub_account: r.vehicle_id ? subOfTruck(r.vehicle_id, rec.sub_account) : rec.sub_account, driver_id: r.driver_id, vehicle_id: r.vehicle_id || null,
      period: `${ym}-01`, amount: amt, notes: rec.notes || null, entered_by: who,
    });
    return error?.message;
  });

  const bulkCfg = bulk === 'revenue' ? { table: 'truck_revenue', cols: REVENUE_COLUMNS, sample: [sampleMonth, sampleTruck, '100000', ''], insert: importRevenue }
    : bulk === 'truckcosts' ? { table: 'truck_costs', cols: TRUCK_COST_COLUMNS, sample: [sampleMonth, sampleTruck, '25000', '40000', '15000'], insert: importTruckCosts }
    : bulk === 'salaries' ? { table: 'driver_salaries', cols: SALARY_COLUMNS, sample: [sampleMonth, sampleDriver, sampleTruck, '35000', ''], insert: importSalaries }
    : bulk === 'costs' && costType ? { table: 'cost_entries', cols: COST_ENTRY_COLUMNS, sample: [sampleMonth, CATEGORIES[costType].items[0], '', '10000', ''], insert: importCosts(costType) }
    : null;

  /* ---------------- views ---------------- */
  const costPanel = (type: CostType) => {
    const cfg = CATEGORIES[type];
    const list = d.costs.filter((c: any) => c.report_type === type && (truck === 'all' || c.vehicle_id === truck));
    const salList = type === 'employment' ? salariesF.filter((s: any) => truck === 'all' || s.vehicle_id === truck) : [];
    const byCat: Record<string, number> = {};
    list.forEach((c: any) => { byCat[c.category] = (byCat[c.category] || 0) + Number(c.amount || 0); });
    if (type === 'employment') byCat['driver salaries'] = salList.reduce((a: number, s: any) => a + Number(s.amount || 0), 0);
    const total = Object.values(byCat).reduce((a, b) => a + b, 0);
    return (
      <div className="space-y-4">
        <p className="text-sm text-slate-500">{cfg.hint}</p>
        <ImportBar template="cost_entries" onImport={() => setBulk('costs')} label={type === 'employment' ? 'Bulk Import Costs' : 'Bulk Import'} />
        <EntryForm color={portalColor} onSave={() => saveCost(type)} saving={saving}>
          {SubPick()}
          <div><label className={labelCls}>Month</label><input type="month" value={ef.month} onChange={e => setEf({ ...ef, month: e.target.value })} className={inputCls} /></div>
          <div><label className={labelCls}>Category</label>
            <select value={ef.category} onChange={e => setEf({ ...ef, category: e.target.value })} className={inputCls}><option value="">—</option>{cfg.items.map(i => <option key={i} value={i}>{cap(i)}</option>)}<option value="other">Other</option></select></div>
          {TruckPick('Whole sub-account')}
          <div><label className={labelCls}>Amount (KES)</label><input type="number" value={ef.amount} onChange={e => setEf({ ...ef, amount: e.target.value })} className={inputCls} /></div>
        </EntryForm>
        {type === 'employment' && (
          <>
          <ImportBar template="driver_salaries" onImport={() => setBulk('salaries')} label="Bulk Import Salaries" />
          <EntryForm color={portalColor} onSave={saveSalary} saving={saving}>
            {SubPick()}
            <div><label className={labelCls}>Driver salary — month</label><input type="month" value={ef.month} onChange={e => setEf({ ...ef, month: e.target.value })} className={inputCls} /></div>
            <div><label className={labelCls}>Driver</label>
              <select value={ef.driver} onChange={e => setEf({ ...ef, driver: e.target.value })} className={inputCls}><option value="">—</option>{d.drivers.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
            {TruckPick('No truck (unallocated)')}
            <div><label className={labelCls}>Salary (KES)</label><input type="number" value={ef.amount} onChange={e => setEf({ ...ef, amount: e.target.value })} className={inputCls} /></div>
          </EntryForm>
          </>
        )}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="card p-4"><p className="text-xs font-semibold text-slate-500">Total {cfg.title.toLowerCase()}</p><p className="text-xl font-bold">{kes(total)}</p></div>
          {Object.entries(byCat).map(([k, v]) => <div key={k} className="card p-4"><p className="text-xs font-semibold text-slate-500">{cap(k)}</p><p className="text-lg font-bold">{kes(v)}</p></div>)}
        </div>
        <Table head={['Month', 'Sub-account', 'Category', 'Truck', 'Driver', 'Amount', '']}>
          {[...list.map((c: any) => ({ ...c, _t: 'cost_entries', _cat: c.category })), ...salList.map((s: any) => ({ ...s, _t: 'driver_salaries', _cat: 'driver salary' }))].map((c: any) => (
            <tr key={c._t + c.id}><td>{monthLabel(c.period)}</td><td>{subLabel(c.sub_account)}</td><td>{cap(c._cat)}</td><td>{plate[c.vehicle_id] || '—'}</td><td>{driverName[c.driver_id] || '—'}</td><Num v={Number(c.amount)} bold />
              <td><button onClick={() => remove(c._t, c.id)} className="text-slate-400 hover:text-red-600" aria-label="Delete"><Trash2 className="h-4 w-4" /></button></td></tr>
          ))}
        </Table>
      </div>
    );
  };

  const tabs: { key: View; label: string }[] = [
    { key: 'summary', label: 'Truck Summary' }, { key: 'revenue', label: 'Revenue' }, { key: 'truckcosts', label: 'Insurance, Loans & Allowance' }, { key: 'maintenance', label: 'Maintenance & Truck Cost' },
    { key: 'financial', label: 'Financial Cost' }, { key: 'employment', label: 'Employment Cost' }, { key: 'overhead', label: 'Overhead Cost' }, { key: 'miscellaneous', label: 'Miscellaneous' },
  ];

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex items-center gap-3 bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl text-white" style={{ background: portalColor }}><FileText className="h-6 w-6" /></div>
        <div><h2 className="text-lg font-bold text-slate-800">Reports &amp; Costs</h2><p className="text-sm text-slate-500">Profit per truck = revenue minus all expenditure</p></div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        {!lockedSubAccount && (
          <div><label className={labelCls}>Sub-account</label>
            <select value={sub} onChange={e => setSub(e.target.value)} className={inputCls}><option value="all">All sub-accounts</option>{SUBS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}</select></div>
        )}
        <div><label className={labelCls}>From month</label><input type="month" value={fromM} onChange={e => setFromM(e.target.value)} className={inputCls} /></div>
        <div><label className={labelCls}>To month</label><input type="month" value={toM} onChange={e => setToM(e.target.value)} className={inputCls} /></div>
        <div><label className={labelCls}>Driver</label>
          <select value={tdf.driver} onChange={e => tdf.setDriver(e.target.value)} className={inputCls}><option value="all">All drivers</option>{tdf.drivers.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
        <div><label className={labelCls}>Truck</label>
          <select value={truck} onChange={e => setTruck(e.target.value)} className={inputCls}><option value="all">All trucks</option>{d.vehicles.map((v: any) => <option key={v.id} value={v.id}>{v.plate_number}{effSub === 'all' ? ` (${subLabel(v.sub_account)})` : ''}</option>)}</select></div>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-slate-200">
        {tabs.map(t => (
          <button key={t.key} onClick={() => setView(t.key)} className="px-4 py-2.5 text-sm font-semibold -mb-px border-b-2 transition-colors"
            style={{ borderColor: view === t.key ? portalColor : 'transparent', color: view === t.key ? portalColor : '#64748b' }}>{t.label}</button>
        ))}
      </div>

      {loading ? <LoadingSpinner message="Loading reports..." /> : (
        <>
          {view === 'summary' && (
            <div className="space-y-3">
              <div className="flex justify-end"><button onClick={exportCsv} className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700"><Download className="h-4 w-4" /> Export CSV</button></div>
              <Table head={['Truck', ...(effSub === 'all' ? ['Sub-account'] : []), 'Revenue', 'Fuel', 'Spares', 'Tyres', 'Driver salaries', 'Insurance', 'Loans', 'Driver allowance', 'Other costs', 'Total cost', 'Profit']}>
                {rows.map((r: any) => (
                  <tr key={r.id}><td className="font-bold">{r.plate}</td>{effSub === 'all' && <td>{subLabel(r.sub)}</td>}
                    <Num v={r.revenue} /><Num v={r.fuel} /><Num v={r.spares} /><Num v={r.tyres} /><Num v={r.salaries} /><Num v={r.insurance} /><Num v={r.loans} /><Num v={r.allowance} /><Num v={r.other} /><Num v={r.cost} bold />
                    <td className={`text-right tabular-nums font-bold ${r.profit < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{kes(r.profit)}</td></tr>
                ))}
                <tr className="bg-slate-50 font-bold"><td>TOTAL</td>{effSub === 'all' && <td />}<Num v={tot.revenue || 0} bold /><Num v={tot.fuel || 0} bold /><Num v={tot.spares || 0} bold /><Num v={tot.tyres || 0} bold /><Num v={tot.salaries || 0} bold /><Num v={tot.insurance || 0} bold /><Num v={tot.loans || 0} bold /><Num v={tot.allowance || 0} bold /><Num v={tot.other || 0} bold /><Num v={tot.cost || 0} bold />
                  <td className={`text-right tabular-nums ${(tot.profit || 0) < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{kes(tot.profit || 0)}</td></tr>
              </Table>
              <p className="text-xs text-slate-500">
                Costs not tied to a truck (whole sub-account overheads, financial and employment costs, unallocated salaries): <b>{kes(unallocated)}</b>.
                Profit after these: <b>{kes((tot.profit || 0) - (truck === 'all' ? unallocated : 0))}</b>{truck !== 'all' && ' (shown for all trucks only)'}.
                Spares are counted when installed; tyres when fitted; fuel from the Fuel page; revenue from the Revenue tab; insurance, loans and driver allowance from the Insurance, Loans &amp; Allowance tab.
              </p>
            </div>
          )}

          {view === 'revenue' && (
            <div className="space-y-4">
              <ImportBar template="truck_revenue" onImport={() => setBulk('revenue')} />
              <EntryForm color={portalColor} onSave={saveRevenue} saving={saving} note={(() => {
                const amt = Number(ef.amount);
                const cur = d.revenue.find((r: any) => r.vehicle_id === ef.truck && String(r.period).slice(0, 7) === ef.month);
                if (!(amt > 0)) return `Each amount is multiplied by ${Math.round(VAT_MULTIPLIER * 100)}% (tax inclusive) and added to the revenue already saved for that truck and month.`;
                return `${kes(amt)} × ${Math.round(VAT_MULTIPLIER * 100)}% = ${kes(withVat(amt))} will be added${cur ? ` to ${kes(Number(cur.amount))} → new total ${kes(Number(cur.amount) + withVat(amt))}` : ' to the truck and month'}.`;
              })()}>
                {SubPick()}
                <div><label className={labelCls}>Month</label><input type="month" value={ef.month} onChange={e => setEf({ ...ef, month: e.target.value })} className={inputCls} /></div>
                {TruckPick('— Select truck —')}
                <div><label className={labelCls}>Revenue (KES)</label><input type="number" value={ef.amount} onChange={e => setEf({ ...ef, amount: e.target.value })} className={inputCls} /></div>
                <div><label className={labelCls}>Notes</label><input value={ef.notes} onChange={e => setEf({ ...ef, notes: e.target.value })} className={inputCls} /></div>
              </EntryForm>
              <Table head={['Month', 'Truck', 'Sub-account', 'Revenue', 'Notes', '']}>
                {d.revenue.filter((r: any) => truck === 'all' || r.vehicle_id === truck).map((r: any) => (
                  <tr key={r.id}><td>{monthLabel(r.period)}</td><td className="font-bold">{plate[r.vehicle_id] || '—'}</td><td>{subLabel(r.sub_account)}</td><Num v={Number(r.amount)} bold /><td>{r.notes || '—'}</td>
                    <td><button onClick={() => remove('truck_revenue', r.id)} className="text-slate-400 hover:text-red-600" aria-label="Delete"><Trash2 className="h-4 w-4" /></button></td></tr>
                ))}
              </Table>
              <p className="text-xs text-slate-500">Saving again for the same truck and month adds to the earlier figure. To correct a mistake, delete the row and enter the right total.</p>
            </div>
          )}

          {view === 'truckcosts' && (
            <div className="space-y-4">
              <ImportBar template="truck_costs" onImport={() => setBulk('truckcosts')} />
              <div className="card p-4 space-y-3">
                <div className="flex flex-wrap items-end gap-3">
                  <div><label className={labelCls}>Month</label><input type="month" value={ef.month} onChange={e => setEf({ ...ef, month: e.target.value })} className={inputCls} /></div>
                  <button onClick={saveTruckCosts} disabled={saving} className="flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" style={{ background: portalColor }}>
                    <Plus className="h-4 w-4" /> {saving ? 'Saving...' : 'Save all'}
                  </button>
                  <p className="text-xs text-slate-500 flex-1 min-w-[16rem]">Type the figures under each truck. Every amount is multiplied by {Math.round(VAT_MULTIPLIER * 100)}% (tax inclusive) and added to what is already saved for that truck in {monthLabel(`${ef.month}-01`)}. Leave a box empty to skip it.</p>
                </div>
                <div className="table-wrapper overflow-x-auto">
                  <table className="data-table">
                    <thead><tr><th>Truck</th>{effSub === 'all' && <th>Sub-account</th>}<th>Insurance (KES)</th><th>Loans (KES)</th><th>Driver allowance (KES)</th><th className="text-right">Saved this month</th></tr></thead>
                    <tbody>
                      {d.vehicles.filter((v: any) => (truck === 'all' || v.id === truck) && tdf.okRow(v.id, null)).map((v: any) => {
                        const g = grid[v.id] || { insurance: '', loan: '', driver_allowance: '' };
                        const sv = saved[v.id];
                        const cell = (k: 'insurance' | 'loan' | 'driver_allowance') => (
                          <td><input type="number" min="0" value={g[k]} onChange={e => setCell(v.id, k, e.target.value)} className={`${inputCls} min-w-[7rem]`} />
                            {sv && <span className="block text-[11px] text-slate-400 mt-0.5">saved {kes(Number(sv[k] || 0))}</span>}</td>
                        );
                        return (
                          <tr key={v.id}><td className="font-bold">{v.plate_number}</td>{effSub === 'all' && <td>{subLabel(v.sub_account)}</td>}
                            {cell('insurance')}{cell('loan')}{cell('driver_allowance')}
                            <Num v={sv ? Number(sv.insurance || 0) + Number(sv.loan || 0) + Number(sv.driver_allowance || 0) : 0} bold /></tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
              <h3 className="text-sm font-bold text-slate-700">Saved figures ({monthLabel(`${fromM}-01`)} – {monthLabel(`${toM}-01`)})</h3>
              <Table head={['Month', 'Truck', 'Sub-account', 'Insurance', 'Loans', 'Driver allowance', 'Total', '']}>
                {d.truckCosts.filter((r: any) => (truck === 'all' || r.vehicle_id === truck) && tdf.okRow(r.vehicle_id, null)).map((r: any) => (
                  <tr key={r.id}><td>{monthLabel(r.period)}</td><td className="font-bold">{plate[r.vehicle_id] || '—'}</td><td>{subLabel(r.sub_account)}</td>
                    <Num v={Number(r.insurance)} /><Num v={Number(r.loan)} /><Num v={Number(r.driver_allowance)} /><Num v={Number(r.insurance) + Number(r.loan) + Number(r.driver_allowance)} bold />
                    <td><button onClick={async () => { await remove('truck_costs', r.id); loadSaved(); }} className="text-slate-400 hover:text-red-600" aria-label="Delete"><Trash2 className="h-4 w-4" /></button></td></tr>
                ))}
              </Table>
              <p className="text-xs text-slate-500">To correct a mistake, delete the row and enter the right totals.</p>
            </div>
          )}

          {view === 'maintenance' && (
            <div className="space-y-4">
              <p className="text-sm text-slate-500">Spares, tyres and fuel per truck.</p>
              <Table head={['Truck', 'Spares', 'Tyres', 'Fuel', 'Total']}>
                {rows.map((r: any) => <tr key={r.id}><td className="font-bold">{r.plate}</td><Num v={r.spares} /><Num v={r.tyres} /><Num v={r.fuel} /><Num v={r.spares + r.tyres + r.fuel} bold /></tr>)}
                <tr className="bg-slate-50 font-bold"><td>TOTAL</td><Num v={tot.spares || 0} bold /><Num v={tot.tyres || 0} bold /><Num v={tot.fuel || 0} bold /><Num v={(tot.spares || 0) + (tot.tyres || 0) + (tot.fuel || 0)} bold /></tr>
              </Table>
              <h3 className="text-sm font-bold text-slate-700">Spares and tyres detail</h3>
              <Table head={['Date', 'Type', 'Item', 'Truck', 'Sub-account', 'Cost']}>
                {[...spareItems.map((i: any) => ({ ...i, type: 'Spare' })), ...tyreItems.map((i: any) => ({ ...i, type: 'Tyre' }))]
                  .filter((i: any) => truck === 'all' || i.truck === truck)
                  .sort((a: any, b: any) => String(b.date).localeCompare(String(a.date)))
                  .map((i: any, n: number) => <tr key={n}><td>{i.date}</td><td>{i.type}</td><td>{i.name}</td><td>{plate[i.truck] || '—'}</td><td>{subLabel(i.sub || vehSub[i.truck] || '')}</td><Num v={i.cost} /></tr>)}
              </Table>
            </div>
          )}

          {view === 'financial' && costPanel('financial')}
          {view === 'employment' && costPanel('employment')}
          {view === 'overhead' && costPanel('overhead')}
          {view === 'miscellaneous' && costPanel('miscellaneous')}
        </>
      )}

      {bulkCfg && (
        <BulkImportModal
          open
          onClose={() => setBulk(null)}
          tableName={bulkCfg.table}
          portalColor={portalColor}
          subAccount={(effSub !== 'all' ? effSub : ef.sub) as SubAccount}
          sampleColumns={bulkCfg.cols}
          sampleRow={bulkCfg.sample}
          insertRecord={bulkCfg.insert}
          onSuccess={() => { load(); loadSaved(); }}
        />
      )}
    </div>
  );
}
