import { useState } from 'react';
import { Microscope, LogIn, UserPlus, Loader2, AlertCircle } from 'lucide-react';
import { login, signup } from './api';

/*
 * Login.jsx — the sign-in / sign-up screen shown before the console loads.
 *
 * Styled to match the rest of the Pathology Console ("Pro Workstation" dark
 * navy + indigo theme), rather than reusing the CHC intake app's light
 * split-panel layout — this is a different app with its own established look.
 *
 * Deliberately simpler than the intake app's Login: a pathologist account
 * isn't tied to a CHC, so sign-up only asks for a name, email and password
 * (no CHC field, no "forgot password" flow). Two modes toggled at the bottom:
 *   • 'login'  — email + password.
 *   • 'signup' — also asks the pathologist's name.
 * On success it calls onAuth(user); App.jsx then swaps in the dashboard.
 */
export default function Login({ onAuth }) {
  const [mode, setMode] = useState('login');        // 'login' | 'signup'
  const [form, setForm] = useState({ fullName: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const isSignup = mode === 'signup';
  const go = (m) => { setMode(m); setError(null); };   // switch mode, clear any error

  const submit = async (e) => {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      onAuth(isSignup ? await signup(form) : await login({ email: form.email, password: form.password }));
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    'w-full rounded-[9px] border border-slate-700 bg-slate-800/80 px-3.5 py-2.5 text-sm text-slate-100 ' +
    'placeholder:text-slate-500 focus:bg-slate-800 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 outline-none transition';
  const labelCls = 'block text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-1.5';

  const title = isSignup ? 'Create your account' : 'Welcome back';
  const subtitle = isSignup ? 'Register as a pathologist to review cases.' : 'Sign in to review and report on patient cases.';

  // Full-window dark backdrop (same radial-gradient-over-navy treatment as the
  // CHC intake login's brand panel), with a single centred card — this app
  // has no second "form panel" half, so the whole window is the composition.
  return (
    <div
      className="min-h-[100dvh] w-full flex items-center justify-center p-6 text-white"
      style={{ background: 'radial-gradient(900px circle at 20% 10%, #1e1b4b, transparent 60%), #0b1120' }}
    >
      <div className="w-full max-w-[380px]">
        {/* Brand mark — same badge + wordmark used in the app's own sidebar,
            so this screen reads as the front door of the same product. */}
        <div className="flex items-center gap-3 mb-8 justify-center">
          <div className="w-11 h-11 rounded-xl bg-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-900/60">
            <Microscope className="w-6 h-6 text-white" />
          </div>
          <div className="text-left">
            <div className="text-[17px] font-bold">EPTB Hub</div>
            <div className="mono text-[10px] font-semibold uppercase tracking-[0.16em] text-indigo-300/90 mt-1">Pathology Console</div>
          </div>
        </div>

        <div className="bg-slate-900/70 border border-slate-800 rounded-2xl shadow-2xl p-7 sm:p-8">
          <h2 className="text-xl font-extrabold tracking-tight text-white">{title}</h2>
          <p className="text-sm text-slate-400 mt-1.5 mb-6">{subtitle}</p>

          {error && (
            <div className="mb-4 flex items-start gap-2 rounded-xl bg-red-950/50 text-red-300 ring-1 ring-red-900 px-3.5 py-2.5 text-sm">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={submit} className="space-y-4">
            {isSignup && (
              <div>
                <label className={labelCls}>User Name</label>
                <input className={inputCls} placeholder="e.g. Dr. Rakesh Sharma" required
                  value={form.fullName} onChange={(e) => set('fullName', e.target.value)} />
              </div>
            )}
            <div>
              <label className={labelCls}>Email</label>
              <input type="email" className={`${inputCls} mono`} placeholder="you@example.com" required
                value={form.email} onChange={(e) => set('email', e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>Password</label>
              <input type="password" className={inputCls} placeholder={isSignup ? 'At least 6 characters' : '••••••••'} required
                value={form.password} onChange={(e) => set('password', e.target.value)} />
            </div>

            <button type="submit" disabled={busy}
              className="w-full inline-flex items-center justify-center gap-2 py-3 bg-indigo-600 text-white rounded-[10px] font-semibold text-sm tracking-wide hover:bg-indigo-500 active:scale-[0.99] shadow-md shadow-indigo-900/40 transition-all disabled:opacity-60 disabled:cursor-not-allowed">
              {busy
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Please wait…</>
                : isSignup
                  ? <><UserPlus className="w-4 h-4" /> Create account</>
                  : <><LogIn className="w-4 h-4" /> Sign in</>}
            </button>
          </form>

          <div className="text-sm text-slate-400 text-center mt-5">
            {isSignup ? (
              <p>
                Already have an account?{' '}
                <button onClick={() => go('login')} className="font-semibold text-indigo-400 hover:text-indigo-300">Sign in</button>
              </p>
            ) : (
              <p>
                New here?{' '}
                <button onClick={() => go('signup')} className="font-semibold text-indigo-400 hover:text-indigo-300">Create an account</button>
              </p>
            )}
          </div>
        </div>

        <p className="mono text-[11px] text-slate-600 text-center mt-6">secure · confidential</p>
      </div>
    </div>
  );
}
