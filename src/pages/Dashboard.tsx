import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Truck, Users, Wrench, Route, Fuel, DollarSign, Package,
  TrendingUp, Calendar, ShieldCheck, ChevronRight, Building2,
} from 'lucide-react';
import { supabase, getSubAccountFilter } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { StatCard } from '@/components/StatCard';
import { LoadingSpinner } from '@/components/Shared';
import { ContainersDueSoonAlert } from '@/components/ContainersDueSoonAlert';
import { MCLArea } from '@/lib/portals';
import { useTruckDriverFilter, TruckDriverBar } from '@/components/TruckDriverFilter';
import {
  DASH_SUBS, DashSub, DashRaw, loadDashboardRaw, summarize, thisMonth, shiftMonth,
} from '@/lib/dashboard-data';

const kes = (n: number) => `KES ${Math.round(n).toLocaleString('en-KE')}`;

type Period = 'this_month' | 'last_month' | 'last_3' | 'this_year' | 'all';
const PERIODS: { id: Period; label: string }[] = [
  { id: 'this_month', label: 'This month' },
  { id: 'last_month', label: 'Last month' },
  { id: 'last_3', label: 'Last 3 months' },
  { id: 'this_year', label: 'This year' },
  { id: 'all', label: 'All time' },
];
function periodRange(p: Period): { from: string; to: string } {
  const now = thisMonth();
  switch (p) {
    case 'last_month': { const m = shiftMonth(now, -1); return { from: m, to: m }; }
    case 'last_3': return { from: shiftMonth(now, -2), to: now };
    case 'this_year': return { from: `${now.slice(0, 4)}-01`, to: now };
    case 'all': return { from: '2000-01', to: now };
    default: return { from: now, to: now };
  }
}

const WATCH_TABLES = [
  'mcl_trips', 'csl_trips', 'tarmal_trips', 'pn_mashru_trips',
  'sub_account_fuel', 'driver_mileage', 'truck_revenue',
  'spare_parts_v2', 'tyres_v2', 'vehicles', 'drivers',
];

export function Dashboard({
  subAccount: subAccountProp,
  mclArea,
  onViewAllContainers,
  onViewCompliance,
}: {
  subAccount?: string;
  mclArea?: MCLArea | null;
  onViewAllContainers?: () => void;
  onViewCompliance?: () => void;
}) {
  const { profile } = useAuth();

  const pathSegments = window.location.pathname.split('/').filter(Boolean);
  let currentSubAccount = subAccountProp;
  if (!currentSubAccount && pathSegments.length >= 2 && pathSegments[0] === 'admin') {
    const potential = pathSegments[1];
    currentSubAccount = (DASH_SUBS as readonly string[]).includes(potential) ? potential : 'master';
  }
  if (!currentSubAccount) currentSubAccount = profile?.sub_account ?? getSubAccountFilter() ?? 'master';
  const isMasterView = currentSubAccount === 'master' || currentSubAccount === 'all';

  const f = useTruckDriverFilter(String(currentSubAccount));
  const [period, setPeriod] = useState<Period>('this_month');
  const [loading, setLoading] = useState(true);
  const [raws, setRaws] = useState<Partial<Record<DashSub, DashRaw>>>({});
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [tick, setTick] = useState(0);
  const reqId = useRef(0);

  const [allAlerts, setAllAlerts] = useState<{ id: string; label: string; type: string; days: number | null; isVehicle: boolean; vehicleId: string | null; driverId: string | null }[]>([]);

  useEffect(() => {
    const id = ++reqId.current;
    (async () => {
      const { from, to } = periodRange(period);
      const subs: DashSub[] = isMasterView ? [...DASH_SUBS] : [currentSubAccount as DashSub];
      const results = await Promise.all(subs.map(sa => loadDashboardRaw(sa, from, to, sa === 'mcl' ? mclArea : null)));
      if (id !== reqId.current) return;
      const next: Partial<Record<DashSub, DashRaw>> = {};
      subs.forEach((sa, i) => { next[sa] = results[i]; });
      setRaws(next);
      setUpdatedAt(new Date());
      setLoading(false);
      results.forEach((r, i) => r.errors.forEach(e => console.warn(`[dashboard:${subs[i]}] ${e}`)));

      if (!isMasterView) {
        const [vcRes, dcRes] = await Promise.all([
          supabase.from('vehicle_compliance_items').select('id, vehicle_id, compliance_type, expiry_date, vehicle:vehicles(plate_number)').eq('sub_account', currentSubAccount).order('expiry_date', { ascending: true, nullsFirst: false }),
          supabase.from('driver_compliance_items').select('id, driver_id, compliance_type, expiry_date, driver:drivers(name)').eq('sub_account', currentSubAccount).order('expiry_date', { ascending: true, nullsFirst: false }),
        ]);
        if (id !== reqId.current) return;
        const now = Date.now();
        const vAlerts = ((vcRes.data as any[]) || []).map((i: any) => ({
          id: i.id, label: i.vehicle?.plate_number || 'Unknown', type: i.compliance_type,
          days: i.expiry_date ? Math.ceil((new Date(i.expiry_date).getTime() - now) / 86400000) : null, isVehicle: true,
          vehicleId: i.vehicle_id || null, driverId: null as string | null,
        }));
        const dAlerts = ((dcRes.data as any[]) || []).map((i: any) => ({
          id: i.id, label: i.driver?.name || 'Unknown', type: i.compliance_type,
          days: i.expiry_date ? Math.ceil((new Date(i.expiry_date).getTime() - now) / 86400000) : null, isVehicle: false,
          vehicleId: null as string | null, driverId: i.driver_id || null,
        }));
        setAllAlerts([...vAlerts, ...dAlerts].filter(a => a.days != null && a.days <= 30).sort((a, b) => (a.days! - b.days!)));
      }
    })();
  }, [currentSubAccount, isMasterView, mclArea, period, tick]);

  const bump = useCallback(() => setTick(t => t + 1), []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => { if (timer) clearTimeout(timer); timer = setTimeout(bump, 800); };
    let channel: any = null;
    try {
      channel = supabase.channel(`dashboard-${String(currentSubAccount)}-${Date.now()}`);
      WATCH_TABLES.forEach(table => channel.on('postgres_changes', { event: '*', schema: 'public', table }, soon));
      channel.subscribe();
    } catch (e) {
      console.warn('[dashboard] realtime unavailable, using 30 s refresh only', e);
    }
    const poll = setInterval(soon, 30000);
    const onVisible = () => { if (document.visibilityState === 'visible') soon(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (timer) clearTimeout(timer);
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
      if (channel) { try { supabase.removeChannel(channel); } catch { /* ignore */ } }
    };
  }, [currentSubAccount, bump]);

  if (loading) return <LoadingSpinner message="Loading dashboard..." />;

  const periodBar = (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={period}
        onChange={e => { setPeriod(e.target.value as Period); setLoading(true); }}
        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-slate-500 min-w-[10rem]"
        aria-label="Period"
      >
        {PERIODS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
      <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
        <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
        Live{updatedAt ? ` · updated ${updatedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : ''}
      </span>
    </div>
  );

  /* ============================ MASTER VIEW ============================ */
  if (isMasterView) {
    const per = DASH_SUBS.map(sa => ({ sa, t: raws[sa] ? summarize(raws[sa]!, f.okRow) : null }));
    const all = per.reduce((a, { t }) => {
      if (!t) return a;
      (Object.keys(t) as (keyof typeof t)[]).forEach(k => { a[k] = (a[k] || 0) + t[k]; });
      return a;
    }, {} as Record<string, number>);

    return (
      <div className="space-y-6 animate-fade-in">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-red-700 text-white shadow-sm"><TrendingUp className="h-6 w-6" /></div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">Master Fleet Summary</h1>
            <p className="text-sm text-slate-500">Overview across all registered sub-account portals</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3"><TruckDriverBar f={f} />{periodBar}</div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Total Group Revenue" value={kes(all.revenue || 0)} icon={<DollarSign className="h-6 w-6" />} color="emerald" />
          <StatCard label="Total Distance Covered" value={`${Math.round(all.distance || 0).toLocaleString()} km`} icon={<Route className="h-6 w-6" />} color="blue" />
          <StatCard label="Total Fuel Spend" value={kes(all.fuel || 0)} icon={<Fuel className="h-6 w-6" />} color="amber" />
          <StatCard label="Total Maintenance" value={kes(all.maintenance || 0)} icon={<Wrench className="h-6 w-6" />} color="rose" />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Total Active Fleet" value={`${all.vehicles || 0} Trucks`} icon={<Truck className="h-6 w-6" />} color="blue" />
          <StatCard label="Total Active Drivers" value={String(all.drivers || 0)} icon={<Users className="h-6 w-6" />} color="emerald" />
          <StatCard label="Trips This Period" value={String(all.trips || 0)} icon={<Calendar className="h-6 w-6" />} color="amber" />
          <StatCard label="Spares In Store" value={String(all.sparesInStore || 0)} icon={<Package className="h-6 w-6" />} color="slate" />
        </div>

        <h2 className="text-base font-bold text-slate-800 pt-2">Sub-Account Breakdowns</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {per.map(({ sa, t }) => t && (
            <div key={sa} className="card p-5 border border-slate-200 space-y-4 hover:shadow-md transition-shadow">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <div className="flex items-center gap-2"><Building2 className="h-5 w-5 text-red-700" /><h3 className="font-bold text-lg text-slate-900">{sa.toUpperCase()} Portal</h3></div>
                <span className="px-2.5 py-1 text-xs font-semibold rounded-full bg-slate-100 text-slate-700">{t.trips} Trips</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div className="bg-slate-50 p-3 rounded-lg"><p className="text-xs text-slate-500">Revenue</p><p className="text-sm font-bold text-emerald-600">{kes(t.revenue)}</p></div>
                <div className="bg-slate-50 p-3 rounded-lg"><p className="text-xs text-slate-500">Fuel Cost</p><p className="text-sm font-bold text-amber-600">{kes(t.fuel)}</p></div>
                <div className="bg-slate-50 p-3 rounded-lg"><p className="text-xs text-slate-500">Maintenance</p><p className="text-sm font-bold text-rose-600">{kes(t.maintenance)}</p></div>
                <div className="bg-slate-50 p-3 rounded-lg"><p className="text-xs text-slate-500">Distance</p><p className="text-sm font-bold text-blue-600">{Math.round(t.distance).toLocaleString()} km</p></div>
                <div className="bg-slate-50 p-3 rounded-lg"><p className="text-xs text-slate-500">Active Trucks</p><p className="text-sm font-bold text-slate-800">{t.vehicles}</p></div>
                <div className="bg-slate-50 p-3 rounded-lg"><p className="text-xs text-slate-500">Active Drivers</p><p className="text-sm font-bold text-slate-800">{t.drivers}</p></div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  /* ======================= SINGLE SUB-ACCOUNT VIEW ======================= */
  const raw = raws[currentSubAccount as DashSub];
  const t = raw ? summarize(raw, f.okRow) : null;
  const complianceAlerts = allAlerts.filter(a => f.okRow(a.vehicleId, a.driverId)).slice(0, 5);

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm"><TrendingUp className="h-6 w-6" /></div>
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-950 uppercase">{currentSubAccount} Portal Dashboard</h1>
          <p className="text-sm text-slate-500">Overview of transport operations for {currentSubAccount.toUpperCase()}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3"><TruckDriverBar f={f} />{periodBar}</div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total Revenue" value={kes(t?.revenue || 0)} icon={<DollarSign className="h-6 w-6" />} color="emerald" />
        <StatCard label="Total Distance" value={`${Math.round(t?.distance || 0).toLocaleString()} km`} icon={<Route className="h-6 w-6" />} color="blue" />
        <StatCard label="Fuel Costs" value={kes(t?.fuel || 0)} icon={<Fuel className="h-6 w-6" />} color="amber" />
        <StatCard label="Maintenance Costs" value={kes(t?.maintenance || 0)} icon={<Wrench className="h-6 w-6" />} color="rose" />
      </div>

      {onViewAllContainers && (
        <ContainersDueSoonAlert mclArea={mclArea ?? null} portalColor="#2563EB" onViewAll={onViewAllContainers} />
      )}

      {complianceAlerts.length > 0 && (
        <div className="card p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-amber-500" /><h3 className="text-base font-semibold text-slate-900">Compliance Alerts</h3></div>
            {onViewCompliance && (
              <button onClick={onViewCompliance} className="flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700">View all <ChevronRight className="h-3.5 w-3.5" /></button>
            )}
          </div>
          <div className="space-y-2">
            {complianceAlerts.map(a => (
              <div key={a.id} className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
                <div className="flex items-center gap-3">
                  {a.isVehicle ? <Truck className="h-4 w-4 text-slate-500" /> : <Users className="h-4 w-4 text-slate-500" />}
                  <div><p className="text-sm font-medium text-slate-800">{a.label}</p><p className="text-xs text-slate-500 capitalize">{a.type.replace(/_/g, ' ')}</p></div>
                </div>
                <span className="text-xs font-semibold text-amber-700">{a.days} days</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Active Vehicles" value={String(t?.vehicles || 0)} icon={<Truck className="h-6 w-6" />} color="blue" />
        <StatCard label="Active Drivers" value={String(t?.drivers || 0)} icon={<Users className="h-6 w-6" />} color="emerald" />
        <StatCard label="Trips This Period" value={String(t?.trips || 0)} icon={<Calendar className="h-6 w-6" />} color="amber" />
        <StatCard label="Spares In Store" value={String(t?.sparesInStore || 0)} icon={<Package className="h-6 w-6" />} color="slate" />
      </div>
    </div>
  );
}
