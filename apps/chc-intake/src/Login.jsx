import { useState } from 'react';
import {
  Microscope, LogIn, UserPlus, KeyRound, Loader2, AlertCircle, CheckCircle2,
  ShieldCheck, Images, RefreshCw,
} from 'lucide-react';
import { login, signup, resetPassword } from './api';

/*
 * Login.jsx — the sign-in / sign-up / reset screen shown before the intake form.
 *
 * A split layout: a dark brand panel on the left (hidden on phones, where the
 * form panel shows a small logo of its own instead) and the actual form on the
 * right. Three modes toggled by links at the bottom:
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
    'w-full rounded-[9px] border border-gray-300 bg-neutral-50 px-3.5 py-2.5 text-sm text-slate-900 ' +
    'placeholder:text-slate-400 focus:bg-white focus:border-indigo-600 focus:ring-4 focus:ring-indigo-600/10 outline-none transition';
  const labelCls = 'block text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-1.5';

  const title = isReset ? 'Reset your password' : isSignup ? 'Create your account' : 'Welcome back';
  const subtitle = isReset
    ? 'Confirm your details, then choose a new password.'
    : isSignup ? 'Register as a lab attendant to submit cases.' : 'Sign in to submit patient cases.';

  // `min-h-[100dvh] grid lg:grid-cols-[44%_1fr]` — no outer padding or capped
  // width: the split panel itself IS the window, filling it edge to edge at
  // any size. `min-h` (not a fixed `h`) plus `overflow-y-auto` on the form
  // side means a very short window (or the longer sign-up form) scrolls
  // instead of clipping, so it stays safe on small/rotated screens too.
  return (
    <div className="min-h-[100dvh] w-full grid lg:grid-cols-[44%_1fr] bg-white text-slate-900">
      {/* Brand panel — introduces the product; purely descriptive, no inputs.
          Fills the entire left half of the window on large screens; hidden
          below `lg` so the form panel alone fills the screen on phones.
          `justify-center items-center text-center` centers the whole group —
          logo, headline block, and caption — both vertically and horizontally
          as one composition, with `gap-10` giving even spacing between them
          (replacing the old `mt-auto` top/bottom split layout). */}
      <div className="hidden lg:flex flex-col items-center justify-center text-center gap-10 p-10 xl:p-14 text-white"
        style={{ background: 'radial-gradient(900px circle at 20% 10%, #1e1b4b, transparent 60%), #0b1120' }}>
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-900/60">
              <Microscope className="w-6 h-6 text-white" />
            </div>
            <div className="text-left">
              <div className="text-[17px] font-bold">EPTB Hub</div>
              {/* Refined tagline: small caps with generous letter-spacing and a
                  brighter indigo read as a deliberate "eyebrow" label under the
                  wordmark, rather than an afterthought line of plain text. */}
              <div className="mono text-[10px] font-semibold uppercase tracking-[0.16em] text-indigo-300/90 mt-1">Telepathology Console</div>
            </div>
          </div>
          <div className="max-w-[320px]">
            <div className="text-[26px] font-bold tracking-tight leading-snug">Faster FNAC review,<br />from CHC to pathologist.</div>
            <p className="text-[13.5px] text-slate-400 leading-relaxed mt-4">
              Register patients, attach cytology slides, and route them to remote pathologists for annotation and reporting.
            </p>
            <div className="flex flex-col items-center gap-3 mt-6 text-[13px] text-slate-300">
              <div className="flex items-center gap-2.5"><ShieldCheck className="w-4 h-4 text-indigo-400" /> NIKSHAY / ABHA linked records</div>
              <div className="flex items-center gap-2.5"><Images className="w-4 h-4 text-indigo-400" /> Whole-slide image annotation</div>
              <div className="flex items-center gap-2.5"><RefreshCw className="w-4 h-4 text-indigo-400" /> Live sync across sites</div>
            </div>
          </div>
          <div className="mono text-[11px] text-slate-600">secure · confidential</div>
        </div>

      {/* Form panel — fills the right half (or the whole screen, on phones);
          scrolls on its own if a short window can't fit the sign-up form. */}
      <div className="p-8 sm:p-12 flex flex-col justify-center overflow-y-auto">
        <div className="w-full max-w-[340px] mx-auto">
            {/* Small logo shown only on phones, where the brand panel above is hidden. */}
            <div className="flex lg:hidden items-center gap-2.5 mb-6">
              <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center">
                <Microscope className="w-5 h-5 text-white" />
              </div>
              <div>
                <div className="text-base font-bold text-slate-900">EPTB Hub</div>
                <div className="mono text-[11px] text-slate-500">intake portal</div>
              </div>
            </div>

            <h2 className="text-2xl font-extrabold tracking-tight text-slate-900">{title}</h2>
            <p className="text-sm text-slate-500 mt-1.5 mb-7">{subtitle}</p>

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
                <input type="email" className={`${inputCls} mono`} placeholder="you@example.com" required
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
                className="w-full inline-flex items-center justify-center gap-2 py-3 bg-indigo-600 text-white rounded-[10px] font-semibold text-sm tracking-wide hover:bg-indigo-700 active:scale-[0.99] shadow-md shadow-indigo-600/25 transition-all disabled:opacity-60 disabled:cursor-not-allowed">
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
                    <button onClick={() => go('reset')} className="font-semibold text-indigo-600 hover:text-indigo-700">
                      Forgot password?
                    </button>
                  </p>
                  <p>
                    New here?{' '}
                    <button onClick={() => go('signup')} className="font-semibold text-indigo-600 hover:text-indigo-700">
                      Create an account
                    </button>
                  </p>
                </>
              )}
              {mode === 'signup' && (
                <p>
                  Already have an account?{' '}
                  <button onClick={() => go('login')} className="font-semibold text-indigo-600 hover:text-indigo-700">Sign in</button>
                </p>
              )}
              {mode === 'reset' && (
                <p>
                  Remembered it?{' '}
                  <button onClick={() => go('login')} className="font-semibold text-indigo-600 hover:text-indigo-700">Back to sign in</button>
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
  );
}
