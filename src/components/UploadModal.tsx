import React, { useState } from 'react';
import * as XLSX from 'xlsx';
import { supabase } from '@/lib/supabase';
import { useToast } from '@/components/Toast';
import { Upload, FileSpreadsheet, X, CheckCircle2, Eye } from 'lucide-react';

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

export function UploadModal({ isOpen, onClose, tableName, subAccount, transformRow, insertRecords, onSuccess }: UploadModalProps) {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  // Rows read from the file and cleaned up, shown in the preview. Nothing is saved until the person confirms.
  const [prepared, setPrepared] = useState<Record<string, any>[] | null>(null);
  const { showToast } = useToast();

  if (!isOpen) return null;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setPrepared(null);
    }
  };

  const DEDICATED_TRIP_TABLES = ['mcl_trips', 'csl_trips', 'tarmal_trips', 'pn_mashru_trips'];

  // Step 1: read the file and show what would be imported (saves nothing)
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
      setPrepared(preparedRows);
    } catch (err: any) {
      showToast(err?.message || 'Error reading uploaded file.', 'error');
    } finally {
      setUploading(false);
    }
  };

  // Step 2: save the previewed rows
  const handleUpload = async () => {
    if (!prepared) return;
    setUploading(true);
    try {
      if (insertRecords) {
        const res = await insertRecords(prepared);
        const skippedText = res.skipped > 0 ? `, ${res.skipped} skipped (already exist)` : '';
        if (res.inserted === 0 && res.failed > 0) {
          showToast(`Import failed. ${res.firstError || 'No record could be saved.'}`, 'error');
          return;
        }
        showToast(`Successfully imported ${res.inserted} record(s)${skippedText}${res.failed > 0 ? `, ${res.failed} failed (${res.firstError})` : ''}`, 'success');
        if (onSuccess) onSuccess();
        onClose();
        return;
      }

      const { error } = await supabase.from(tableName).insert(prepared);
      if (error) throw error;

      showToast(`Successfully imported ${prepared.length} records!`, 'success');
      if (onSuccess) onSuccess();
      onClose();
    } catch (err: any) {
      showToast(err.message || 'Failed to parse and insert data records.', 'error');
    } finally {
      setUploading(false);
    }
  };

  // Columns shown in the preview (the first few that hold a value; bookkeeping columns are left out)
  const previewColumns = prepared
    ? Array.from(new Set(prepared.slice(0, 50).flatMap(r => Object.keys(r))))
        .filter(k => !['sub_account', 'created_at'].includes(k) && prepared.slice(0, 50).some(r => r[k] !== null && r[k] !== undefined && r[k] !== ''))
        .slice(0, 6)
    : [];
  const cell = (v: any) => { const t = v === null || v === undefined || v === '' ? '—' : String(v); return t.length > 24 ? t.slice(0, 23) + '…' : t; };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-fade-in">
      <div className={`w-full ${prepared ? 'max-w-2xl' : 'max-w-md'} rounded-2xl bg-white p-6 shadow-2xl border border-slate-200 max-h-[90vh] overflow-y-auto`}>
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

          {prepared && (
            <div className="space-y-2">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-wider block">Check what will be imported</span>
              <p className="text-xs font-semibold text-emerald-700">{prepared.length} new record(s) ready to import into {tableName.replace(/_/g, ' ')}</p>
              <div className="max-h-64 overflow-auto rounded-lg border border-slate-200">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-slate-500 sticky top-0">
                    <tr><th className="text-left p-2">Row</th>{previewColumns.map(c => <th key={c} className="text-left p-2">{c.replace(/_/g, ' ')}</th>)}</tr>
                  </thead>
                  <tbody>
                    {prepared.slice(0, 100).map((r, i) => (
                      <tr key={i} className="border-t border-slate-100">
                        <td className="p-2 text-slate-500">{i + 2}</td>
                        {previewColumns.map(c => <td key={c} className="p-2 text-slate-700">{cell(r[c])}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {prepared.length > 100 && <p className="p-2 text-[11px] text-slate-400">Showing the first 100 of {prepared.length} rows. All rows are imported when you confirm.</p>}
              </div>
              <p className="text-[11px] text-slate-500">Nothing is saved until you press Confirm Import.</p>
            </div>
          )}

          {file && !prepared && (
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
          {prepared && (
            <button onClick={() => setPrepared(null)} disabled={uploading} className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800">
              Back
            </button>
          )}
          <button
            onClick={prepared ? handleUpload : handlePreview}
            disabled={!file || uploading || (!!prepared && prepared.length === 0)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-semibold rounded-lg shadow-sm transition-colors flex items-center gap-2"
          >
            {uploading
              ? (prepared ? 'Importing...' : 'Reading file...')
              : prepared
              ? `Confirm Import (${prepared.length})`
              : <><Eye className="h-4 w-4" />Preview Changes</>}
          </button>
        </div>
      </div>
    </div>
  );
}
