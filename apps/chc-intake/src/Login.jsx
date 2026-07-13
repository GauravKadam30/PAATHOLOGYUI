import { useState } from 'react';
import { Building2, LogIn, UserPlus, KeyRound, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { login, signup, resetPassword } from './api';

/*
 * Login.jsx — the sign-in / sign-up / reset screen shown before the intake form.
 *
 * Three modes toggled by links at the bottom:
 *   • 'login'  — email + password.
 *   • 'signup' — also asks the lab attendant's name and CHC name.
 *   • 'reset'  — "forgot password": prove who you are with email + name + CHC,
 *                then set a new password (no email server needed).
 * On a successful login/signup it calls onAuth(user); App.jsx then swaps in the
 * intake screen.
 */
export default function Login({ onAuth }) {
  const [mode, setMode] = useState('login');            // 'login' | 'signup' | 'reset'
  const [form, setForm] = useState({ fullName: '', chcName: '', email: '', password: '', newPassword: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);           // green success message (after a reset)
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const isSignup = mode === 'signup';
  const isReset = mode === 'reset';
  const go = (m) => { setMode(m); setError(null); };     // switch mode, clear any error

  const submit = async (e) => {
    e.preventDefault();
    setError(null); setNotice(null); setBusy(true);
    try {
      if (isReset) {
        await resetPassword({ email: form.email, fullName: form.fullName, chcName: form.chcName, newPassword: form.newPassword });
        setMode('login');                               // back to sign-in with a confirmation
        setNotice('Password updated — please sign in with your new password.');
      } else if (isSignup) {
        onAuth(await signup(form));
      } else {
        onAuth(await login({ email: form.email, password: form.password }));
      }
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    'w-full rounded-xl border border-slate-200 bg-slate-50/60 px-3.5 py-2.5 text-sm text-slate-800 ' +
    'placeholder:text-slate-400 focus:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 outline-none transition';
  const labelCls = 'block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5';

  const title = isReset ? 'Reset your password' : isSignup ? 'Create your account' : 'Welcome back';
  const subtitle = isReset
    ? 'Confirm your details, then choose a new password.'
    : isSignup ? 'Register as a lab attendant to submit cases.' : 'Sign in to submit patient cases.';

  return (
    <div className="min-h-screen bg-slate-100 clinical-bg text-slate-900 flex flex-col items-center justify-center px-4 py-10">
      {/* Logo + product name */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-11 h-11 rounded-xl bg-blue-600 flex items-center justify-center shadow-sm">
          <Building2 className="w-6 h-6 text-white" />
        </div>
        <div>
          <h1 className="text-lg font-bold tracking-tight text-slate-900 leading-tight">CHC Intake Portal</h1>
          <p className="text-xs text-slate-500 font-medium">Telepathology Console · EPTB Hub</p>
        </div>
      </div>

      {/* The card */}
      <div className="w-full max-w-md bg-white rounded-2xl ring-1 ring-slate-200/70 shadow-sm p-6 sm:p-7">
        <h2 className="text-base font-bold text-slate-800">{title}</h2>
        <p className="text-sm text-slate-500 mt-0.5 mb-5">{subtitle}</p>

        {/* Green success banner (after a password reset) */}
        {notice && (
          <div className="mb-4 flex items-start gap-2 rounded-xl bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200 px-3.5 py-2.5 text-sm">
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{notice}</span>
          </div>
        )}
        {/* Red error banner */}
        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-xl bg-red-50 text-red-800 ring-1 ring-red-200 px-3.5 py-2.5 text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={submit} className="space-y-4">
          {/* Name + CHC are needed for sign-up AND for the reset identity check */}
          {(isSignup || isReset) && (
            <>
              <div>
                <label className={labelCls}>Lab Attendant Name</label>
                <input className={inputCls} placeholder="e.g. Anjali Devi" required
                  value={form.fullName} onChange={(e) => set('fullName', e.target.value)} />
              </div>
              <div>
                <label className={labelCls}>CHC Name</label>
                <input className={inputCls} placeholder="e.g. Devipur CHC" required
                  value={form.chcName} onChange={(e) => set('chcName', e.target.value)} />
              </div>
            </>
          )}

          <div>
            <label className={labelCls}>Email</label>
            <input type="email" className={inputCls} placeholder="you@example.com" required
              value={form.email} onChange={(e) => set('email', e.target.value)} />
          </div>

          {/* Login/Signup use "password"; reset uses "newPassword" */}
          {!isReset && (
            <div>
              <label className={labelCls}>Password</label>
              <input type="password" className={inputCls} placeholder={isSignup ? 'At least 6 characters' : '••••••••'} required
                value={form.password} onChange={(e) => set('password', e.target.value)} />
            </div>
          )}
          {isReset && (
            <div>
              <label className={labelCls}>New Password</label>
              <input type="password" className={inputCls} placeholder="At least 6 characters" required
                value={form.newPassword} onChange={(e) => set('newPassword', e.target.value)} />
            </div>
          )}

          <button type="submit" disabled={busy}
            className="w-full inline-flex items-center justify-center gap-2 py-3 bg-blue-600 text-white rounded-xl font-semibold text-sm tracking-wide hover:bg-blue-700 active:scale-[0.99] shadow-md shadow-blue-600/20 transition-all disabled:opacity-60 disabled:cursor-not-allowed">
            {busy
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Please wait…</>
              : isReset
                ? <><KeyRound className="w-4 h-4" /> Update password</>
                : isSignup
                  ? <><UserPlus className="w-4 h-4" /> Create account</>
                  : <><LogIn className="w-4 h-4" /> Sign in</>}
          </button>
        </form>

        {/* Footer links change per mode */}
        <div className="text-sm text-slate-500 text-center mt-5 space-y-1.5">
          {mode === 'login' && (
            <>
              <p>
                <button onClick={() => go('reset')} className="font-semibold text-blue-600 hover:text-blue-700">
                  Forgot password?
                </button>
              </p>
              <p>
                New here?{' '}
                <button onClick={() => go('signup')} className="font-semibold text-blue-600 hover:text-blue-700">
                  Create an account
                </button>
              </p>
            </>
          )}
          {mode === 'signup' && (
            <p>
              Already have an account?{' '}
              <button onClick={() => go('login')} className="font-semibold text-blue-600 hover:text-blue-700">Sign in</button>
            </p>
          )}
          {mode === 'reset' && (
            <p>
              Remembered it?{' '}
              <button onClick={() => go('login')} className="font-semibold text-blue-600 hover:text-blue-700">Back to sign in</button>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
