import React, { useState } from 'react';
import * as XLSX from 'xlsx';
import { supabase } from '@/lib/supabase';
import { useToast } from '@/components/Toast';
import { Upload, FileSpreadsheet, X, CheckCircle2, Eye } from 'lucide-react';
import { MERGE_RULES, planRecordMerge, applyRecordPlan } from '@/lib/recordMerge';
import { planTripMerge, applyTripPlan } from '@/lib/mergeImport';
import type { ImportPlan } from '@/lib/mergeImport';

interface UploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  tableName: string;
  subAccount: string;
  /** Optional per-row clean-up (e.g. Tyres). May throw an Error describing a bad row, which cancels the upload. */
  transformRow?: (row: Record<string, any>) => Record<string, any>;
  /** Optional custom insert for the cleaned rows (e.g. Tyres: skips existing serials, writes history). Replaces the plain insert. */
  insertRecords?: (records: Record<string, any>[]) => Promise<{ inserted: number; skipped: number; failed: number; firstError?: string }>;
  onSuccess?: () => void;
}

// Trips of CSL, Tarmal and PN Mashru are matched on truck + date + delivery number (see mergeImport.ts).
// Tarmal and PN Mashru keep the trip's day in date_loaded.
const TRIP_DATE_FIELD: Record<string, string> = { csl_trips: 'trip_date', tarmal_trips: 'date_loaded', pn_mashru_trips: 'date_loaded' };
const DEDICATED_TRIP_TABLES = ['mcl_trips', 'csl_trips', 'tarmal_trips', 'pn_mashru_trips'];

const BADGE: Record<ImportPlan['action'], { label: string; cls: string }> = {
  insert: { label: 'New', cls: 'bg-emerald-100 text-emerald-700' },
  update: { label: 'Update', cls: 'bg-sky-100 text-sky-700' },
  unchanged: { label: 'Nothing new', cls: 'bg-slate-100 text-slate-600' },
  infile: { label: 'Combined', cls: 'bg-violet-100 text-violet-700' },
  error: { label: 'Problem', cls: 'bg-red-100 text-red-700' },
};

export function UploadModal({ isOpen, onClose, tableName, subAccount, transformRow, insertRecords, onSuccess }: UploadModalProps) {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  // What would happen to every row of the file. Nothing is saved until the person confirms.
  const [plans, setPlans] = useState<ImportPlan[] | null>(null);
  const [names, setNames] = useState<{ trucks: Record<string, string>; drivers: Record<string, string> }>({ trucks: {}, drivers: {} });
  const { showToast } = useToast();

  if (!isOpen) return null;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setPlans(null);
    }
  };

  const tripDateField = TRIP_DATE_FIELD[tableName];
  const rule = MERGE_RULES[tableName];
  const canMerge = !!tripDateField || !!rule;
  const count = (a: ImportPlan['action']) => (plans || []).filter(p => p.action === a).length;

  // Step 1: read the file and check every row against what is already saved (saves nothing)
  const handlePreview = async () => {
    if (!file) return;
    setUploading(true);
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const workbook = XLSX.read(data, { type: 'array' });
      const rawRows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);

      if (rawRows.length === 0) {
        showToast('The uploaded spreadsheet contains no data rows.', 'error');
        return;
      }

      let preparedRows: Record<string, any>[];
      if (transformRow) {
        try {
          preparedRows = rawRows.map((row: any) => transformRow(row));
        } catch (err: any) {
          showToast(`Nothing can be imported. ${err?.message || 'A row could not be read.'}`, 'error');
          return;
        }
      } else {
        preparedRows = DEDICATED_TRIP_TABLES.includes(tableName)
          ? (rawRows as Record<string, any>[])
          : rawRows.map((row: any) => ({
              ...row,
              sub_account: subAccount,
              created_at: new Date().toISOString()
            }));
      }

      // Truck plates and driver names, so the preview shows them instead of internal ids
      try {
        const [v, d] = await Promise.all([
          supabase.from('vehicles').select('id, plate_number').limit(2000),
          supabase.from('drivers').select('id, name').limit(2000),
        ]);
        setNames({
          trucks: Object.fromEntries((v.data || []).map((x: any) => [x.id, x.plate_number])),
          drivers: Object.fromEntries((d.data || []).map((x: any) => [x.id, x.name])),
        });
      } catch { /* preview still works with fewer names */ }

      const out: ImportPlan[] = [];
      for (let i = 0; i < preparedRows.length; i++) {
        const rec = preparedRows[i];
        const plan = tripDateField
          ? await planTripMerge(tableName, rec, out, tripDateField)
          : rule
          ? await planRecordMerge(rule, tableName, rec, out)
          : { action: 'insert' as const, record: rec };
        out.push({ ...plan, row: i + 2 });
      }
      setPlans(out);
    } catch (err: any) {
      showToast(err?.message || 'Error reading uploaded file.', 'error');
    } finally {
      setUploading(false);
    }
  };

  // Step 2: add the new rows, fill the blanks of existing ones, skip what is already saved
  const handleUpload = async () => {
    if (!plans) return;
    setUploading(true);
    try {
      let inserted = 0, updated = 0, failed = 0;
      let skipped = plans.filter(p => p.action === 'unchanged').length;
      let firstError = plans.find(p => p.action === 'error')?.message || '';
      failed += plans.filter(p => p.action === 'error').length;

      // new rows: custom insert when the page needs one (Tyres), otherwise a plain insert
      const fresh = plans.filter(p => p.action === 'insert').map(p => p.record);
      if (fresh.length > 0) {
        if (insertRecords) {
          const res = await insertRecords(fresh);
          inserted += res.inserted; skipped += res.skipped; failed += res.failed;
          if (!firstError && res.firstError) firstError = res.firstError;
        } else {
          const { error } = await supabase.from(tableName).insert(fresh);
          if (error) { failed += fresh.length; if (!firstError) firstError = error.message; }
          else inserted += fresh.length;
        }
      }

      // existing rows: fill only what is blank
      for (const p of plans.filter(x => x.action === 'update')) {
        const res = tripDateField ? await applyTripPlan(tableName, p) : await applyRecordPlan(tableName, p);
        if (res.ok) updated++;
        else { failed++; if (!firstError) firstError = `Row ${p.row}: ${res.error || 'could not be saved'}`; }
      }

      if (inserted === 0 && updated === 0 && failed > 0) {
        showToast(`Import failed. ${firstError || 'No record could be saved.'}`, 'error');
        return;
      }
      const parts = [`${inserted} new record(s) added`];
      if (updated > 0) parts.push(`${updated} existing record(s) completed with the missing details`);
      if (skipped > 0) parts.push(`${skipped} skipped (already saved)`);
      if (failed > 0) parts.push(`${failed} failed${firstError ? ` (${firstError})` : ''}`);
      showToast(inserted === 0 && updated === 0 && failed === 0 ? `Nothing new to import: all ${skipped} record(s) are already saved.` : `Import finished: ${parts.join(', ')}`, 'success');
      if (onSuccess) onSuccess();
      onClose();
    } catch (err: any) {
      showToast(err.message || 'Failed to parse and insert data records.', 'error');
    } finally {
      setUploading(false);
    }
  };

  const short = (v: any) => { const t = String(v); return t.length > 26 ? t.slice(0, 25) + '…' : t; };
  const pretty = (k: string, v: any): [string, string] => {
    if (k === 'vehicle_id' || k === 'current_truck_id') return ['truck', names.trucks[v] || short(v)];
    if (k === 'driver_id') return ['driver', names.drivers[v] || short(v)];
    return [k.replace(/_/g, ' '), short(v)];
  };
  const HIDDEN = new Set(['sub_account', 'mcl_area_id', 'entered_by', 'created_at', 'documents']);
  const describe = (rec: Record<string, any>) =>
    Object.entries(rec)
      .filter(([k, v]) => !HIDDEN.has(k) && v !== null && v !== undefined && v !== '')
      .slice(0, 6)
      .map(([k, v]) => pretty(k, v).join(': '))
      .join(' · ') || '—';

  const toImport = count('insert') + count('update');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-fade-in">
      <div className={`w-full ${plans ? 'max-w-2xl' : 'max-w-md'} rounded-2xl bg-white p-6 shadow-2xl border border-slate-200 max-h-[90vh] overflow-y-auto`}>
        <div className="flex items-center justify-between border-b border-slate-100 pb-4">
          <h3 className="text-base font-bold text-slate-800 flex items-center gap-2">
            <Upload className="h-5 w-5 text-blue-600" />
            Upload & Auto-Import Data
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 rounded-lg p-1">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="py-6 space-y-4">
          <label className="flex flex-col items-center justify-center w-full h-36 border-2 border-dashed border-slate-300 hover:border-blue-500 rounded-xl cursor-pointer bg-slate-50 hover:bg-slate-100/80 transition-all">
            <FileSpreadsheet className="h-8 w-8 text-blue-500 mb-2" />
            <span className="text-xs font-semibold text-slate-700">
              {file ? file.name : 'Select or drop Excel/CSV file here'}
            </span>
            <span className="text-[10px] text-slate-400 mt-1">Supports .xlsx, .xls, .csv</span>
            <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFileChange} />
          </label>

          {plans && (
            <div className="space-y-2">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-wider block">Check what will change</span>
              <div className="flex flex-wrap gap-3 text-xs font-semibold">
                <span className="text-emerald-700">{count('insert')} new</span>
                {canMerge && <span className="text-sky-700">{count('update')} to update</span>}
                {canMerge && <span className="text-slate-500">{count('unchanged')} nothing new</span>}
                {count('infile') > 0 && <span className="text-violet-700">{count('infile')} combined with an earlier row</span>}
                {count('error') > 0 && <span className="text-red-600">{count('error')} with problems (will be skipped)</span>}
              </div>
              <div className="max-h-64 overflow-auto rounded-lg border border-slate-200">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-slate-500 sticky top-0">
                    <tr><th className="text-left p-2">Row</th><th className="text-left p-2">Record</th><th className="text-left p-2">What happens</th></tr>
                  </thead>
                  <tbody>
                    {plans.slice(0, 300).map((p, i) => (
                      <tr key={i} className="border-t border-slate-100 align-top">
                        <td className="p-2 text-slate-500">{p.row}</td>
                        <td className="p-2 text-slate-700">{describe(p.record)}</td>
                        <td className="p-2 space-y-1">
                          <span className={`inline-block rounded px-1.5 py-0.5 font-semibold ${BADGE[p.action].cls}`}>{BADGE[p.action].label}</span>
                          {p.action === 'update' && p.patch && (
                            <p className="text-slate-600">Fills: {Object.entries(p.patch).map(([k, v]) => pretty(k, v).join(' = ')).join('; ')}</p>
                          )}
                          {p.action === 'unchanged' && <p className="text-slate-500">Everything in this row is already saved.</p>}
                          {(p.action === 'error' || p.action === 'infile') && p.message && <p className={p.action === 'error' ? 'text-red-600' : 'text-slate-500'}>{p.message}</p>}
                          {(p.kept?.length ?? 0) > 0 && (
                            <p className="text-amber-700">Kept saved value: {p.kept!.map(k => `${pretty(k.field, k.saved)[0]} (saved ${pretty(k.field, k.saved)[1]}, file ${pretty(k.field, k.file)[1]})`).join('; ')}</p>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {plans.length > 300 && <p className="p-2 text-[11px] text-slate-400">Showing the first 300 of {plans.length} rows. All rows are imported when you confirm.</p>}
              </div>
              <p className="text-[11px] text-slate-500">
                {canMerge ? 'Records that are already saved are skipped, blanks on them are filled in, and values that are already saved are never overwritten. ' : ''}
                Nothing is saved until you press Confirm Import.
              </p>
            </div>
          )}

          {file && !plans && (
            <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg flex items-center justify-between text-xs text-blue-700">
              <span className="font-mono truncate">{file.name}</span>
              <CheckCircle2 className="h-4 w-4 text-blue-600 shrink-0" />
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-slate-100 pt-4">
          <button onClick={onClose} className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800">
            Cancel
          </button>
          {plans && (
            <button onClick={() => setPlans(null)} disabled={uploading} className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800">
              Back
            </button>
          )}
          <button
            onClick={plans ? handleUpload : handlePreview}
            disabled={!file || uploading || (!!plans && toImport === 0)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-semibold rounded-lg shadow-sm transition-colors flex items-center gap-2"
          >
            {uploading
              ? (plans ? 'Importing...' : 'Checking file...')
              : plans
              ? `Confirm Import (${toImport})`
              : <><Eye className="h-4 w-4" />Preview Changes</>}
          </button>
        </div>
      </div>
    </div>
  );
}
