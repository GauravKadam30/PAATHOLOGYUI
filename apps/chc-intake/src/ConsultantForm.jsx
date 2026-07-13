import { Stethoscope } from 'lucide-react';   // a "stethoscope" icon for the card title

/*
 * ConsultantForm.jsx — the "Consultant" card.
 *
 * Same idea as PatientForm: it holds no data of its own; App.jsx owns the values
 * (in `form`) and passes them in with a `setField` function to update them. This
 * card just collects the referring consultant's name and the OPD prescription /
 * clinical notes, kept in their own section like the Patient Information card.
 */
const inputCls =
  'w-full rounded-xl border border-slate-200 bg-slate-50/60 px-3.5 py-2.5 text-sm text-slate-800 ' +
  'placeholder:text-slate-400 focus:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 outline-none transition';
const labelCls = 'block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5';

export default function ConsultantForm({ form, setField }) {
  return (
    <section className="bg-white rounded-2xl ring-1 ring-slate-200/70 shadow-sm p-5 sm:p-6">
      {/* Card title with an icon badge */}
      <div className="flex items-center gap-2.5 mb-5">
        <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
          <Stethoscope className="w-4 h-4 text-blue-600" />
        </div>
        <div>
          <h2 className="text-sm font-bold text-slate-800">Consultant</h2>
          <p className="text-xs text-slate-400">Referring consultant &amp; OPD notes</p>
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <label className={labelCls}>Consultant Name<span className="text-red-500 ml-0.5">*</span></label>
          <input className={inputCls} placeholder="Referring consultant"
            value={form.consultant} onChange={(e) => setField('consultant', e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>OPD Prescription &amp; Notes<span className="text-red-500 ml-0.5">*</span></label>
          <textarea className={`${inputCls} h-32 resize-none`} placeholder="Enter patient clinical notes…"
            value={form.notes} onChange={(e) => setField('notes', e.target.value)} />
        </div>
      </div>
    </section>
  );
}
