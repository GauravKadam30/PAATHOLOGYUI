import { Stethoscope } from 'lucide-react';   // a "stethoscope" icon for the card title

/*
 * ConsultantForm.jsx — the "Consultant" card ("Pro Workstation" styling).
 *
 * Same idea as PatientForm: it holds no data of its own; App.jsx owns the values
 * (in `form`) and passes them in with a `setField` function to update them. This
 * card just collects the referring consultant's name and the OPD prescription /
 * clinical notes, kept in their own section like the Patient Information card.
 */
const inputCls =
  'w-full rounded-lg border border-gray-300 bg-neutral-50 px-3.5 py-2.5 text-sm text-slate-900 ' +
  'placeholder:text-slate-400 focus:bg-white focus:border-indigo-600 focus:ring-4 focus:ring-indigo-600/10 outline-none transition';
const labelCls = 'block text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-1.5';

// `h-full flex flex-col` matches PatientForm/FileUpload so all three cards
// share the same height; the OPD notes box then grows (`flex-1`) to fill
// whatever extra vertical space that leaves, instead of staying a fixed size.
export default function ConsultantForm({ form, setField }) {
  return (
    <section className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 sm:p-6 h-full flex flex-col">
      {/* Card title with an icon badge */}
      <div className="flex items-center gap-2.5 mb-5 shrink-0">
        <div className="w-8 h-8 rounded-lg bg-indigo-50 flex items-center justify-center shrink-0">
          <Stethoscope className="w-4 h-4 text-indigo-600" />
        </div>
        <div>
          <h2 className="text-sm font-bold text-slate-900">Consultant</h2>
          <p className="text-xs text-slate-400">Referring consultant &amp; OPD notes</p>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col gap-4">
        <div className="shrink-0">
          <label className={labelCls}>Consultant Name<span className="text-red-500 ml-0.5">*</span></label>
          <input className={inputCls} placeholder="Referring consultant"
            value={form.consultant} onChange={(e) => setField('consultant', e.target.value)} />
        </div>
        <div className="flex-1 min-h-0 flex flex-col">
          <label className={labelCls}>OPD Prescription &amp; Notes<span className="text-red-500 ml-0.5">*</span></label>
          <textarea className={`${inputCls} flex-1 min-h-[8rem] resize-none`} placeholder="Enter patient clinical notes…"
            value={form.notes} onChange={(e) => setField('notes', e.target.value)} />
        </div>
      </div>
    </section>
  );
}
