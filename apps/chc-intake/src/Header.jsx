import { Building2 } from 'lucide-react';

// Sticky top bar: facility branding on the left, the logged-in attendant on the right.
export default function Header() {
  return (
    <header className="sticky top-0 z-10 bg-white border-b border-slate-200/80 shadow-sm">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center shadow-sm shrink-0">
          <Building2 className="w-5 h-5 text-white" />
        </div>
        <div className="min-w-0">
          <h1 className="text-base sm:text-lg font-bold tracking-tight text-slate-900 leading-tight">Devipur CHC</h1>
          <p className="text-xs text-slate-500 font-medium">Patient Intake Portal</p>
        </div>

        <div className="ml-auto flex items-center gap-3">
          <div className="hidden sm:block text-right">
            <p className="text-sm font-semibold text-slate-800 leading-tight">Anjali Devi</p>
            <p className="text-[11px] text-slate-500">Lab Attendant</p>
          </div>
          <div className="w-9 h-9 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-bold ring-1 ring-blue-200 shrink-0">
            AD
          </div>
        </div>
      </div>
    </header>
  );
}
