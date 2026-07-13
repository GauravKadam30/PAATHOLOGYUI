import { useState } from 'react';
import { ChevronDown, UserCog, LogOut, Loader2, X, AlertCircle } from 'lucide-react';
import { updateProfile } from './api';

/*
 * ProfileMenu.jsx — the clickable avatar in the top-right corner.
 *
 * Clicking it opens a small menu with two choices:
 *   • Edit profile — a dialog to change the lab attendant's name and CHC name.
 *   • Log out      — asks "are you sure?" before actually signing out.
 *
 * Props:
 *   user       — the signed-in person { fullName, chcName, ... }
 *   onUpdated  — called with the updated user after a successful profile edit
 *   onLogout   — called when the user confirms logging out
 */

// "Anjali Devi" -> "AD"
const initialsOf = (name = '') =>
  name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || 'U';

export default function ProfileMenu({ user, onUpdated, onLogout }) {
  const [open, setOpen] = useState(false);              // is the little menu showing?
  const [showEdit, setShowEdit] = useState(false);      // is the edit dialog showing?
  const [showLogout, setShowLogout] = useState(false);  // is the log-out confirm showing?
  const [edit, setEdit] = useState({ fullName: user.fullName, chcName: user.chcName });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const openEdit = () => { setEdit({ fullName: user.fullName, chcName: user.chcName }); setError(null); setShowEdit(true); setOpen(false); };
  const openLogout = () => { setShowLogout(true); setOpen(false); };

  const saveProfile = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const updated = await updateProfile({ fullName: edit.fullName, chcName: edit.chcName });
      onUpdated(updated);
      setShowEdit(false);
    } catch (err) {
      setError(err.message || 'Could not update profile.');
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    'w-full rounded-lg border border-gray-300 bg-neutral-50 px-3.5 py-2.5 text-sm text-slate-900 ' +
    'placeholder:text-slate-400 focus:bg-white focus:border-indigo-600 focus:ring-4 focus:ring-indigo-600/10 outline-none transition';
  const labelCls = 'block text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-1.5';

  return (
    <div className="relative">
      {/* The avatar button: name + role on the left, initials circle, chevron.
          Sits on the dark header, so text/hover states use light colours. */}
      <button onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2.5 rounded-full pl-2 pr-1.5 py-1 hover:bg-white/10 transition-colors">
        <div className="hidden sm:block text-right leading-tight">
          <p className="text-sm font-semibold text-slate-100">{user.fullName}</p>
          <p className="text-[11px] text-slate-500">Lab Attendant</p>
        </div>
        <div className="mono w-9 h-9 rounded-lg bg-indigo-900 text-indigo-200 flex items-center justify-center text-xs font-bold shrink-0">
          {initialsOf(user.fullName)}
        </div>
        <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {/* The dropdown menu (floats above the dark header, so it's white/light) */}
      {open && (
        <>
          {/* invisible layer: clicking anywhere else closes the menu */}
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 w-56 bg-white rounded-xl border border-gray-200 shadow-lg z-30 overflow-hidden py-1">
            <div className="px-3.5 py-2.5 border-b border-gray-100">
              <p className="text-sm font-semibold text-slate-900 truncate">{user.fullName}</p>
              <p className="text-xs text-slate-500 truncate">{user.chcName}</p>
            </div>
            <button onClick={openEdit}
              className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-slate-700 hover:bg-gray-50 transition-colors">
              <UserCog className="w-4 h-4 text-slate-500" /> Edit profile
            </button>
            <button onClick={openLogout}
              className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors">
              <LogOut className="w-4 h-4" /> Log out
            </button>
          </div>
        </>
      )}

      {/* Edit-profile dialog */}
      {showEdit && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/60 backdrop-blur-sm p-4"
          onClick={() => !busy && setShowEdit(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm border border-gray-200 overflow-hidden"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2.5 px-5 py-4 border-b border-gray-100">
              <div className="w-8 h-8 rounded-lg bg-indigo-50 flex items-center justify-center">
                <UserCog className="w-4 h-4 text-indigo-600" />
              </div>
              <h3 className="text-sm font-bold text-slate-900">Edit profile</h3>
              <button onClick={() => setShowEdit(false)} className="ml-auto p-1.5 rounded-lg text-slate-400 hover:bg-gray-100">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={saveProfile} className="p-5 space-y-4">
              {error && (
                <div className="flex items-start gap-2 rounded-xl bg-red-50 text-red-800 border border-red-200 px-3.5 py-2.5 text-sm">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /><span>{error}</span>
                </div>
              )}
              <div>
                <label className={labelCls}>Lab Attendant Name</label>
                <input className={inputCls} required placeholder="Lab attendant name" value={edit.fullName}
                  onChange={(e) => setEdit((f) => ({ ...f, fullName: e.target.value }))} />
              </div>
              <div>
                <label className={labelCls}>CHC Name</label>
                <input className={inputCls} required placeholder="CHC name" value={edit.chcName}
                  onChange={(e) => setEdit((f) => ({ ...f, chcName: e.target.value }))} />
              </div>
              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => setShowEdit(false)}
                  className="flex-1 py-2.5 rounded-xl font-semibold text-sm text-slate-600 bg-gray-100 border border-gray-200 hover:bg-gray-200 transition-all">
                  Cancel
                </button>
                <button type="submit" disabled={busy}
                  className="flex-1 inline-flex items-center justify-center gap-2 py-2.5 rounded-xl font-semibold text-sm text-white bg-indigo-600 hover:bg-indigo-700 shadow-md shadow-indigo-600/20 transition-all disabled:opacity-60">
                  {busy ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</> : 'Save changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Log-out confirmation dialog */}
      {showLogout && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/60 backdrop-blur-sm p-4"
          onClick={() => setShowLogout(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 text-center border border-gray-200"
            onClick={(e) => e.stopPropagation()}>
            <div className="mx-auto w-12 h-12 rounded-full bg-red-50 ring-8 ring-red-50/50 flex items-center justify-center mb-4">
              <LogOut className="w-5 h-5 text-red-600" />
            </div>
            <h3 className="text-lg font-bold text-slate-900 tracking-tight">Log out?</h3>
            <p className="text-sm text-slate-500 mt-2 mb-6 leading-relaxed">
              Are you sure you want to log out of the intake portal?
            </p>
            <div className="flex gap-3">
              <button onClick={() => setShowLogout(false)}
                className="flex-1 py-2.5 rounded-xl font-semibold text-sm text-slate-600 bg-gray-100 border border-gray-200 hover:bg-gray-200 transition-all">
                Stay
              </button>
              <button onClick={() => { setShowLogout(false); onLogout(); }}
                className="flex-1 py-2.5 rounded-xl font-semibold text-sm text-white bg-red-600 hover:bg-red-700 shadow-md shadow-red-600/25 transition-all">
                Log out
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
