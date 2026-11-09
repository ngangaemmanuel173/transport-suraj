import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  Fuel as FuelIcon, ChevronLeft, ChevronRight, Save, Upload, Download, Search, CalendarDays, Table2, X,
} from 'lucide-react';
import { supabase, activeSubAccount } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { PageHeader } from '@/components/PageHeader';
import { Modal } from '@/components/Modal';
import { LoadingSpinner } from '@/components/Shared';
import { useToast } from '@/components/Toast';
import { parseFuelWorkbook, ParsedFuelRow, FuelType } from '@/lib/dailyFuelImport';

/**
 * Fuel page for CSL and Tarmal.
 * Fuel is not given after each trip, so it is recorded once at the end of the day: how many litres
 * each truck was given. No expected / actual litres, no trip link, no variance.
 */

const normPlate = (s: unknown) => String(s ?? '').toUpperCase().replace(/\s+/g, '');
const pad = (n: number) => String(n).padStart(2, '0');
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const daysInMonth = (ym: string) => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };
const shiftMonth = (ym: string, by: number) => { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m - 1 + by, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const monthLabel = (ym: string) => { const [y, m] = ym.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' }); };
const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });
const FUEL_LABEL: Record<FuelType, string> = { diesel: 'Diesel', petrol: 'Petrol' };

interface Rec { id: string; vehicle_id: string | null; refuel_date: string; actual_litres: number | null; cost_per_litre: number | null; total_cost: number | null; fuel_type: FuelType | null; notes: string | null }

export function DailyFuel({ portalColor }: { portalColor: string }) {
  const { showToast } = useToast();
  const { profile } = useAuth();
  const subAccount = activeSubAccount(profile?.sub_account, 'master');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [records, setRecords] = useState<Rec[]>([]);
  const [view, setView] = useState<'entry' | 'sheet'>('entry');
  const [fuelType, setFuelType] = useState<FuelType>('diesel');
  const [date, setDate] = useState(localToday());
  const [month, setMonth] = useState(localToday().slice(0, 7));
  const [search, setSearch] = useState('');
  const [price, setPrice] = useState('');
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [showAllTrucks, setShowAllTrucks] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [typesOpen, setTypesOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const start = `${month}-01`;
    const end = `${month}-${pad(daysInMonth(month))}`;
    const [veh, fuel] = await Promise.all([
      supabase.from('vehicles').select('id, plate_number, fuel_type').order('plate_number'),
      supabase.from('sub_account_fuel')
        .select('id, vehicle_id, refuel_date, actual_litres, cost_per_litre, total_cost, fuel_type, notes')
        .gte('refuel_date', start).lte('refuel_date', end).order('refuel_date'),
    ]);
    if (veh.error) showToast('Could not load trucks: ' + veh.error.message, 'error');
    if (fuel.error) showToast('Could not load fuel records: ' + fuel.error.message, 'error');
    setVehicles(veh.data || []);
    setRecords(((fuel.data as any[]) || []).map(r => ({ ...r, fuel_type: (r.fuel_type || 'diesel') as FuelType })));
    setLoading(false);
  }, [month, showToast]);

  useEffect(() => { load(); }, [load]);

  const changeDate = (d: string) => { if (!d) return; setDate(d); setMonth(d.slice(0, 7)); };
  const changeMonth = (ym: string) => { setMonth(ym); setDate(ym === localToday().slice(0, 7) ? localToday() : `${ym}-01`); };

  // Each truck uses diesel or petrol; only the trucks of the selected fuel are listed
  const typeVehicles = useMemo(() => vehicles.filter(v => (v.fuel_type || 'diesel') === fuelType), [vehicles, fuelType]);

  // ---------- Daily entry ----------
  const dayRecs = useMemo(() => {
    const m = new Map<string, Rec[]>();
    for (const r of records) {
      if (r.refuel_date !== date || r.fuel_type !== fuelType || !r.vehicle_id) continue;
      m.set(r.vehicle_id, [...(m.get(r.vehicle_id) ?? []), r]);
    }
    return m;
  }, [records, date, fuelType]);

  // Reset the boxes whenever the day, fuel type or saved data changes
  useEffect(() => {
    const next: Record<string, string> = {};
    dayRecs.forEach((list, vid) => { next[vid] = String(list.reduce((s, r) => s + (r.actual_litres ?? 0), 0)); });
    setInputs(next);
  }, [dayRecs]);

  const originalFor = (vid: string) => {
    const list = dayRecs.get(vid);
    return list ? String(list.reduce((s, r) => s + (r.actual_litres ?? 0), 0)) : '';
  };
  const isLocked = (vid: string) => (dayRecs.get(vid)?.length ?? 0) > 1; // several entries for one day: edit them in the database, not here
  const dirtyIds = typeVehicles.filter(v => !isLocked(v.id) && (inputs[v.id] ?? '') !== originalFor(v.id)).map(v => v.id);

  const entryTotal = typeVehicles.reduce((s, v) => s + (Number(inputs[v.id]) || 0), 0);
  const visibleVehicles = typeVehicles.filter(v => !search.trim() || normPlate(v.plate_number).includes(normPlate(search)));

  const saveDay = async () => {
    const bad = dirtyIds.find(id => { const t = (inputs[id] ?? '').trim(); return t !== '' && !(Number(t) > 0); });
    if (bad) { showToast(`Litres for ${vehicles.find(v => v.id === bad)?.plate_number} must be a number above 0`, 'error'); return; }
    const pricePerL = price.trim() === '' ? null : Number(price);
    if (pricePerL !== null && !(pricePerL >= 0)) { showToast('Price per litre must be a number', 'error'); return; }

    setSaving(true);
    try {
      const inserts: any[] = [];
      for (const vid of dirtyIds) {
        const text = (inputs[vid] ?? '').trim();
        const existing = dayRecs.get(vid)?.[0];
        if (text === '') {
          if (existing) { const { error } = await supabase.from('sub_account_fuel').delete().eq('id', existing.id); if (error) throw error; }
          continue;
        }
        const litres = Number(text);
        if (existing) {
          const p = pricePerL ?? existing.cost_per_litre;
          const { error } = await supabase.from('sub_account_fuel').update({
            actual_litres: litres, cost_per_litre: p, total_cost: p != null ? Number((litres * p).toFixed(2)) : null,
          }).eq('id', existing.id);
          if (error) throw error;
        } else {
          inserts.push({
            sub_account: subAccount, vehicle_id: vid, refuel_date: date, fuel_type: fuelType, actual_litres: litres,
            cost_per_litre: pricePerL, total_cost: pricePerL != null ? Number((litres * pricePerL).toFixed(2)) : null,
          });
        }
      }
      if (inserts.length) { const { error } = await supabase.from('sub_account_fuel').insert(inserts); if (error) throw error; }
      showToast(`Saved ${FUEL_LABEL[fuelType].toLowerCase()} for ${date}`, 'success');
      await load();
    } catch (e: any) {
      showToast('Failed to save: ' + (e?.message ?? e), 'error');
    }
    setSaving(false);
  };

  // ---------- Month sheet ----------
  const monthDays = useMemo(() => Array.from({ length: daysInMonth(month) }, (_, i) => i + 1), [month]);
  const sheet = useMemo(() => {
    const byVeh = new Map<string, Map<number, number>>();
    const dayTotals = new Map<number, number>();
    for (const r of records) {
      if (r.fuel_type !== fuelType || !r.vehicle_id) continue;
      const d = Number(r.refuel_date.slice(8, 10));
      const l = r.actual_litres ?? 0;
      const row = byVeh.get(r.vehicle_id) ?? new Map<number, number>();
      row.set(d, (row.get(d) ?? 0) + l);
      byVeh.set(r.vehicle_id, row);
      dayTotals.set(d, (dayTotals.get(d) ?? 0) + l);
    }
    const grand = Array.from(dayTotals.values()).reduce((a, b) => a + b, 0);
    return { byVeh, dayTotals, grand };
  }, [records, fuelType]);
  const sheetVehicles = vehicles.filter(v => sheet.byVeh.has(v.id) || (showAllTrucks && (v.fuel_type || 'diesel') === fuelType));
  const monthCost = records.filter(r => r.fuel_type === fuelType).reduce((s, r) => s + (r.total_cost ?? 0), 0);

  const exportCsv = () => {
    const head = ['Truck', ...monthDays.map(d => `${d}`), 'Total'];
    const lines = [head.join(',')];
    for (const v of sheetVehicles) {
      const row = sheet.byVeh.get(v.id);
      const cells = monthDays.map(d => row?.get(d) ?? '');
      lines.push([`"${v.plate_number}"`, ...cells, row ? Array.from(row.values()).reduce((a, b) => a + b, 0) : 0].join(','));
    }
    lines.push(['TTL FUEL', ...monthDays.map(d => sheet.dayTotals.get(d) ?? ''), sheet.grand].join(','));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${subAccount}_${fuelType}_fuel_${month}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const tabBtn = (active: boolean) => `flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold rounded-lg transition-colors ${active ? 'text-white shadow-sm' : 'text-slate-600 bg-white border border-slate-200 hover:bg-slate-50'}`;

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <PageHeader
          title="Fuel Record"
          subtitle="Record the litres given to each truck at the end of the day"
          icon={<FuelIcon className="h-6 w-6" />}
          iconColor={portalColor}
        />
        <button
          onClick={() => setImportOpen(true)}
          className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg shadow-sm hover:bg-slate-50 transition-colors"
        >
          <Upload className="h-4 w-4 text-slate-500" /> Import Excel
        </button>
      </div>

      <div className="card flex flex-wrap items-center gap-3 py-3 px-4">
        <button className={tabBtn(view === 'entry')} style={view === 'entry' ? { background: portalColor } : undefined} onClick={() => setView('entry')}>
          <CalendarDays className="h-4 w-4" /> Daily Entry
        </button>
        <button className={tabBtn(view === 'sheet')} style={view === 'sheet' ? { background: portalColor } : undefined} onClick={() => setView('sheet')}>
          <Table2 className="h-4 w-4" /> Month Sheet
        </button>
        <div className="flex rounded-lg border border-slate-200 overflow-hidden ml-auto">
          {(['diesel', 'petrol'] as FuelType[]).map(t => (
            <button key={t} onClick={() => setFuelType(t)}
              className={`px-4 py-2 text-sm font-semibold ${fuelType === t ? 'text-white' : 'text-slate-600 bg-white hover:bg-slate-50'}`}
              style={fuelType === t ? { background: portalColor } : undefined}>
              {FUEL_LABEL[t]}
            </button>
          ))}
        </div>
      </div>

      {loading ? <LoadingSpinner message="Loading fuel records..." /> : view === 'entry' ? (
        <div className="card p-4 space-y-4">
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label className="label">Date</label>
              <input type="date" className="input" value={date} onChange={e => changeDate(e.target.value)} />
            </div>
            <div>
              <label className="label">Price per litre (KES, optional)</label>
              <input type="number" step="0.01" min="0" className="input w-48" placeholder="for cost reports" value={price} onChange={e => setPrice(e.target.value)} />
            </div>
            <div className="relative">
              <label className="label">Find truck</label>
              <Search className="absolute left-2.5 top-[2.15rem] h-4 w-4 text-slate-400" />
              <input className="input pl-8 w-44" placeholder="e.g. KDA 255M" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <button className="btn-secondary text-sm" onClick={() => setTypesOpen(true)}>Set truck fuel types</button>
            <div className="ml-auto text-right">
              <p className="text-xs text-slate-400">{FUEL_LABEL[fuelType]} total for {date}</p>
              <p className="text-2xl font-bold text-slate-800">{fmt(entryTotal)} L</p>
            </div>
          </div>

          {typeVehicles.length === 0 ? (
            <p className="text-sm text-slate-500 py-6 text-center">
              No {FUEL_LABEL[fuelType].toLowerCase()} trucks yet. Use "Set truck fuel types" to choose which trucks use {FUEL_LABEL[fuelType].toLowerCase()}, or add trucks on the Trucks / Vehicles page first.
            </p>
          ) : (
            <div className="table-wrapper overflow-x-auto">
              <table className="data-table">
                <thead><tr><th>Truck</th><th className="w-48">Litres given</th><th></th></tr></thead>
                <tbody>
                  {visibleVehicles.map(v => {
                    const locked = isLocked(v.id);
                    const changed = !locked && (inputs[v.id] ?? '') !== originalFor(v.id);
                    return (
                      <tr key={v.id}>
                        <td className="font-semibold text-slate-800 whitespace-nowrap">{v.plate_number}</td>
                        <td>
                          <input type="number" min="0" step="0.1" disabled={locked}
                            className={`input py-1.5 ${changed ? 'border-amber-400 bg-amber-50' : ''}`}
                            value={inputs[v.id] ?? ''} onChange={e => setInputs(p => ({ ...p, [v.id]: e.target.value }))} />
                        </td>
                        <td className="text-xs text-slate-400">{locked ? 'Several entries for this day' : ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex items-center justify-end gap-3">
            {dirtyIds.length > 0 && <span className="text-sm text-amber-600">{dirtyIds.length} unsaved</span>}
            <button className="btn-primary flex items-center gap-2" disabled={saving || dirtyIds.length === 0} onClick={saveDay}>
              <Save className="h-4 w-4" /> {saving ? 'Saving...' : 'Save day'}
            </button>
          </div>
        </div>
      ) : (
        <div className="card p-4 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn-secondary p-2" onClick={() => changeMonth(shiftMonth(month, -1))} aria-label="Previous month"><ChevronLeft className="h-4 w-4" /></button>
            <h2 className="text-lg font-bold text-slate-800 min-w-[10rem] text-center">{monthLabel(month)}</h2>
            <button className="btn-secondary p-2" onClick={() => changeMonth(shiftMonth(month, 1))} aria-label="Next month"><ChevronRight className="h-4 w-4" /></button>
            <label className="flex items-center gap-2 text-sm text-slate-600 ml-4 cursor-pointer">
              <input type="checkbox" checked={showAllTrucks} onChange={e => setShowAllTrucks(e.target.checked)} className="h-4 w-4 rounded border-slate-300" style={{ accentColor: portalColor }} />
              Show trucks with no fuel
            </label>
            <div className="ml-auto flex items-center gap-4">
              <div className="text-right">
                <p className="text-xs text-slate-400">{FUEL_LABEL[fuelType]} this month</p>
                <p className="text-xl font-bold text-slate-800">{fmt(sheet.grand)} L{monthCost > 0 ? <span className="text-sm font-medium text-slate-500"> · KES {monthCost.toLocaleString()}</span> : null}</p>
              </div>
              <button className="btn-secondary flex items-center gap-2" onClick={exportCsv}><Download className="h-4 w-4" /> CSV</button>
            </div>
          </div>

          {sheetVehicles.length === 0 ? (
            <p className="text-sm text-slate-500 py-8 text-center">No {FUEL_LABEL[fuelType].toLowerCase()} recorded in {monthLabel(month)}.</p>
          ) : (
            <div className="overflow-x-auto border border-slate-200 rounded-lg">
              <table className="text-sm border-collapse min-w-full">
                <thead>
                  <tr className="bg-slate-50 text-slate-600">
                    <th className="sticky left-0 bg-slate-50 text-left px-3 py-2 border-b border-slate-200 z-10">Truck</th>
                    {monthDays.map(d => <th key={d} className="px-2 py-2 border-b border-l border-slate-100 font-semibold text-center">{d}</th>)}
                    <th className="px-3 py-2 border-b border-l border-slate-200 text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {sheetVehicles.map(v => {
                    const row = sheet.byVeh.get(v.id);
                    const tot = row ? Array.from(row.values()).reduce((a, b) => a + b, 0) : 0;
                    return (
                      <tr key={v.id} className="hover:bg-slate-50">
                        <td className="sticky left-0 bg-white px-3 py-1.5 font-semibold text-slate-800 whitespace-nowrap border-b border-slate-100">{v.plate_number}</td>
                        {monthDays.map(d => {
                          const l = row?.get(d);
                          return (
                            <td key={d} onClick={() => { setDate(`${month}-${pad(d)}`); setView('entry'); }}
                              className="px-2 py-1.5 text-center border-b border-l border-slate-100 cursor-pointer hover:bg-amber-50 text-slate-700"
                              title="Open this day">
                              {l ? fmt(l) : ''}
                            </td>
                          );
                        })}
                        <td className="px-3 py-1.5 text-right font-semibold border-b border-l border-slate-200">{fmt(tot)}</td>
                      </tr>
                    );
                  })}
                  <tr className="bg-slate-100 font-bold text-slate-800">
                    <td className="sticky left-0 bg-slate-100 px-3 py-2">TTL FUEL</td>
                    {monthDays.map(d => <td key={d} className="px-2 py-2 text-center border-l border-slate-200">{sheet.dayTotals.get(d) ? fmt(sheet.dayTotals.get(d)!) : ''}</td>)}
                    <td className="px-3 py-2 text-right border-l border-slate-200">{fmt(sheet.grand)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <TruckTypesModal open={typesOpen} onClose={() => setTypesOpen(false)} vehicles={vehicles} onSaved={load} />

      <ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        vehicles={vehicles}
        subAccount={subAccount}
        defaultType={fuelType}
        portalColor={portalColor}
        onDone={(ym) => { if (ym) changeMonth(ym); else load(); }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function ImportModal({ open, onClose, vehicles, subAccount, defaultType, portalColor, onDone }: {
  open: boolean; onClose: () => void; vehicles: any[]; subAccount: string; defaultType: FuelType; portalColor: string; onDone: (ym: string | null) => void;
}) {
  const { showToast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [type, setType] = useState<FuelType>(defaultType);
  const [year, setYear] = useState(new Date().getFullYear());
  const [monthNum, setMonthNum] = useState<number | ''>(''); // '' = read it from the sheet
  const [parsed, setParsed] = useState<ParsedFuelRow[] | null>(null);
  const [monthUsed, setMonthUsed] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [duplicates, setDuplicates] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const reset = () => { setFileName(''); setBuffer(null); setParsed(null); setError(''); setMonthNum(''); setDuplicates(new Set()); if (fileRef.current) fileRef.current.value = ''; };
  const close = () => { reset(); onClose(); };

  const plateMap = useMemo(() => new Map(vehicles.map(v => [normPlate(v.plate_number), v.id as string])), [vehicles]);
  const key = (vid: string, date: string, litres: number) => `${vid}|${date}|${litres}`;

  // Parse whenever the file, year or month choice changes, then look for rows already saved
  useEffect(() => {
    if (!buffer) { setParsed(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = parseFuelWorkbook(buffer, year, monthNum === '' ? undefined : monthNum);
        const mo = monthNum === '' ? res.monthGuess ?? new Date().getMonth() + 1 : monthNum;
        if (cancelled) return;
        setError(''); setParsed(res.rows); setMonthUsed(mo);
        if (res.rows.length) {
          const dates = res.rows.map(r => r.date).sort();
          const { data } = await supabase.from('sub_account_fuel').select('vehicle_id, refuel_date, actual_litres, fuel_type')
            .gte('refuel_date', dates[0]).lte('refuel_date', dates[dates.length - 1]);
          if (cancelled) return;
          setDuplicates(new Set((data || []).filter((d: any) => (d.fuel_type || 'diesel') === type).map((d: any) => key(d.vehicle_id, String(d.refuel_date).slice(0, 10), Number(d.actual_litres)))));
        }
      } catch (e: any) {
        if (!cancelled) { setParsed(null); setError(e?.message ?? 'Could not read the file'); }
      }
    })();
    return () => { cancelled = true; };
  }, [buffer, year, monthNum, type]);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setFileName(f.name);
    if (/petrol/i.test(f.name)) setType('petrol');
    else if (/diesel/i.test(f.name)) setType('diesel');
    setBuffer(await f.arrayBuffer());
  };

  const summary = useMemo(() => {
    if (!parsed) return null;
    const ok: (ParsedFuelRow & { vid: string })[] = [];
    const missing = new Map<string, number>();
    let dup = 0;
    for (const r of parsed) {
      const vid = plateMap.get(normPlate(r.plate));
      if (!vid) { missing.set(r.plate, (missing.get(r.plate) ?? 0) + 1); continue; }
      if (duplicates.has(key(vid, r.date, r.litres))) { dup++; continue; }
      ok.push({ ...r, vid });
    }
    return { ok, missing, dup, litres: ok.reduce((s, r) => s + r.litres, 0) };
  }, [parsed, plateMap, duplicates]);

  const run = async () => {
    if (!summary || summary.ok.length === 0) return;
    setBusy(true);
    const rows = summary.ok.map(r => ({
      sub_account: subAccount, vehicle_id: r.vid, refuel_date: r.date, fuel_type: type, actual_litres: r.litres, notes: r.note,
    }));
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await supabase.from('sub_account_fuel').insert(rows.slice(i, i + 200));
      if (error) { showToast('Import failed: ' + error.message, 'error'); setBusy(false); return; }
    }
    // The trucks on a petrol sheet are petrol trucks (and the same for diesel), so the fuel page lists them under the right fuel
    const toSwitch = Array.from(new Set(summary.ok.map(r => r.vid))).filter(id => (vehicles.find(v => v.id === id)?.fuel_type || 'diesel') !== type);
    if (toSwitch.length) {
      const { error: vErr } = await supabase.from('vehicles').update({ fuel_type: type }).in('id', toSwitch);
      if (vErr) showToast('Entries imported, but could not set truck fuel types: ' + vErr.message, 'error');
    }
    showToast(`Imported ${rows.length} fuel entries (${summary.litres.toLocaleString()} L)`, 'success');
    setBusy(false);
    const ym = rows[0].refuel_date.slice(0, 7);
    reset(); onClose(); onDone(ym);
  };

  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  return (
    <Modal open={open} onClose={close} title="Import fuel record from Excel" size="lg">
      <div className="space-y-4">
        <p className="text-sm text-slate-500">
          Use the same sheets you already keep: the <b>diesel grid</b> (trucks down, days across, with a TTL FUEL row) or the <b>petrol list</b> (DATE, VEHICLE, LITRES).
          Importing the same file twice is safe: entries already saved are skipped.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={e => onFile(e.target.files?.[0])} />
          <button className="btn-secondary flex items-center gap-2" onClick={() => fileRef.current?.click()}><Upload className="h-4 w-4" /> Choose file</button>
          {fileName && <span className="text-sm text-slate-600 flex items-center gap-1">{fileName}<button onClick={reset} aria-label="Clear file"><X className="h-3.5 w-3.5 text-slate-400" /></button></span>}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="label">Fuel type</label>
            <select className="input" value={type} onChange={e => setType(e.target.value as FuelType)}>
              <option value="diesel">Diesel</option><option value="petrol">Petrol</option>
            </select>
          </div>
          <div>
            <label className="label">Month</label>
            <select className="input" value={monthNum} onChange={e => setMonthNum(e.target.value === '' ? '' : Number(e.target.value))}>
              <option value="">Read from the sheet{monthUsed && monthNum === '' ? ` (${MONTH_NAMES[monthUsed - 1]})` : ''}</option>
              {MONTH_NAMES.map((n, i) => <option key={n} value={i + 1}>{n}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Year</label>
            <input type="number" className="input" value={year} onChange={e => setYear(Number(e.target.value) || new Date().getFullYear())} />
          </div>
        </div>

        {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">{error}</p>}

        {summary && (
          <div className="rounded-lg border border-slate-200 p-3 space-y-2 text-sm">
            <p className="text-slate-800"><b>{summary.ok.length}</b> new entries to import · <b>{summary.litres.toLocaleString()} L</b> of {FUEL_LABEL[type].toLowerCase()}</p>
            {summary.ok.some(r => (vehicles.find(v => v.id === r.vid)?.fuel_type || 'diesel') !== type) && (
              <p className="text-slate-500">Trucks in this file that are not yet {FUEL_LABEL[type].toLowerCase()} trucks will be set to {FUEL_LABEL[type].toLowerCase()}.</p>
            )}
            {summary.dup > 0 && <p className="text-slate-500">{summary.dup} already saved, will be skipped.</p>}
            {summary.missing.size > 0 && (
              <div className="text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-2">
                Not in the Trucks list, so these are left out: {Array.from(summary.missing.entries()).map(([p, n]) => `${p} (${n})`).join(', ')}.
                Add the truck(s) on the Trucks page, then import the file again and only the missing entries will be added.
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={close}>Cancel</button>
          <button className="btn-primary" style={{ background: portalColor }} disabled={busy || !summary || summary.ok.length === 0} onClick={run}>
            {busy ? 'Importing...' : `Import ${summary?.ok.length ?? 0} entries`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------

function TruckTypesModal({ open, onClose, vehicles, onSaved }: { open: boolean; onClose: () => void; vehicles: any[]; onSaved: () => void }) {
  const { showToast } = useToast();
  const [choice, setChoice] = useState<Record<string, FuelType>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setChoice(Object.fromEntries(vehicles.map(v => [v.id, (v.fuel_type || 'diesel') as FuelType])));
  }, [open, vehicles]);

  const save = async () => {
    setSaving(true);
    for (const t of ['diesel', 'petrol'] as FuelType[]) {
      const ids = vehicles.filter(v => choice[v.id] === t && (v.fuel_type || 'diesel') !== t).map(v => v.id);
      if (!ids.length) continue;
      const { error } = await supabase.from('vehicles').update({ fuel_type: t }).in('id', ids);
      if (error) { showToast('Failed to save: ' + error.message, 'error'); setSaving(false); return; }
    }
    showToast('Truck fuel types saved', 'success');
    setSaving(false);
    onClose();
    onSaved();
  };

  return (
    <Modal open={open} onClose={onClose} title="Set truck fuel types" size="md">
      <div className="space-y-3">
        <p className="text-sm text-slate-500">Choose the fuel each truck uses. The Daily Entry and Month Sheet only list the trucks of the fuel you have selected.</p>
        <div className="max-h-96 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
          {vehicles.map(v => (
            <div key={v.id} className="flex items-center justify-between px-3 py-2">
              <span className="font-semibold text-slate-800">{v.plate_number}</span>
              <select className="input py-1 w-32" value={choice[v.id] ?? 'diesel'} onChange={e => setChoice(p => ({ ...p, [v.id]: e.target.value as FuelType }))}>
                <option value="diesel">Diesel</option><option value="petrol">Petrol</option>
              </select>
            </div>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </div>
    </Modal>
  );
}
