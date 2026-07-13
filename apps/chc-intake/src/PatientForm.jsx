import { ClipboardList } from 'lucide-react';   // a "clipboard" icon for the card title

/*
 * PatientForm.jsx — the card on the left containing all the patient detail boxes.
 *
 * It is a "controlled" form: it does NOT keep its own values. Instead App.jsx
 * holds the values (in `form`) and passes them in, along with a `setField`
 * function this form calls whenever the user types. That keeps every value in
 * one place (App.jsx), which is what lets the Submit button send them all.
 */

// These long strings are styling (Tailwind classes) shared by every input box and
// every label, so they all look identical. Kept here so we don't repeat them.
const inputCls =
  "w-full rounded-xl border border-slate-200 bg-slate-50/60 px-3.5 py-2.5 text-sm text-slate-800 " +
  "placeholder:text-slate-400 focus:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 outline-none transition";
const labelCls = "block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5";

// A small reusable "label + box" wrapper. `span={2}` stretches across both
// columns; `required` shows a red asterisk on the label.
function Field({ label, span = 1, required = false, children }) {
  return (
    <div className={span === 2 ? 'sm:col-span-2' : ''}>
      <label className={labelCls}>
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}

// The form card. `form` = the current values; `setField` = update one of them.
export default function PatientForm({ form, setField }) {
  return (
    <section className="bg-white rounded-2xl ring-1 ring-slate-200/70 shadow-sm p-5 sm:p-6">
      {/* Card title with an icon badge */}
      <div className="flex items-center gap-2.5 mb-5">
        <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
          <ClipboardList className="w-4 h-4 text-blue-600" />
        </div>
        <div>
          <h2 className="text-sm font-bold text-slate-800">Patient Information</h2>
          <p className="text-xs text-slate-400">NIKSHAY / ABHA registration details</p>
        </div>
      </div>

      {/* The fields, laid out in two columns (one column on phones).
          For every box:
            value={form.X}   → shows what's currently stored
            onChange=...      → on each keystroke, save the new text back to App
          (e.target.value is whatever the user just typed.) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="CHC Patient ID" required>
          <input className={inputCls} placeholder="e.g. 123456789012"
            value={form.chcId} onChange={(e) => setField('chcId', e.target.value)} />
        </Field>
        <Field label="Patient Name" required>
          <input className={inputCls} placeholder="Full name"
            value={form.name} onChange={(e) => setField('name', e.target.value)} />
        </Field>

        <Field label="ABHA ID">
          <input className={inputCls} placeholder="00-0000-0000-0000"
            value={form.abha} onChange={(e) => setField('abha', e.target.value)} />
        </Field>
        <Field label="Age" required>
          <input type="number" className={inputCls} placeholder="Years"
            value={form.age} onChange={(e) => setField('age', e.target.value)} />
        </Field>

        <Field label="Nikshay ID">
          <input className={inputCls} placeholder="e.g. NK-000000"
            value={form.nikshay} onChange={(e) => setField('nikshay', e.target.value)} />
        </Field>
        <Field label="Gender" required>
          {/* The values are "F"/"M"/"Other" to match how the Pathology Viewer
              shows gender for the other patients. */}
          <select className={`${inputCls} appearance-none bg-white`}
            value={form.gender} onChange={(e) => setField('gender', e.target.value)}>
            <option value="" disabled>Select gender</option>
            <option value="F">Female</option>
            <option value="M">Male</option>
            <option value="Other">Other</option>
          </select>
        </Field>
        {/* Consultant Name and OPD Prescription & Notes now live in their own
            "Consultant" card (see ConsultantForm.jsx). */}
      </div>
    </section>
  );
}
