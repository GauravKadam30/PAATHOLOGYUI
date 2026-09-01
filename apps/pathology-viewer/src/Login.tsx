import { useState } from 'react';
import type { FormEvent } from 'react';
import { Microscope, LogIn, UserPlus, Loader2, AlertCircle, ShieldCheck, KeyRound } from 'lucide-react';
import { login, signup, requestReset, resetPassword, portalRole, type ConsoleRole } from './api';
import type { User } from './types';

/*
 * Login.tsx — the sign-in / sign-up screen shown before the console loads.
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
 * On success it calls onAuth(user); App.tsx then swaps in the dashboard.
 */

type Mode = 'login' | 'signup' | 'reset';

/** The three fields this form can collect. `fullName` is signup-only. */
interface LoginForm {
  fullName: string;
  email: string;
  password: string;
  /** Reset only: the six-digit code, and the password to set. */
  code: string;
  newPassword: string;
}

/**
 * Three screens, not two. 'reset' runs in TWO steps, tracked by `codeSent`:
 * ask for a code, then exchange it for a new password. Splitting it means the
 * user never sees a code box before a code exists.
 */
interface LoginProps {
  /** Called with the signed-in account once auth succeeds. */
  onAuth: (user: User) => void;
}

export default function Login({ onAuth }: LoginProps) {
  const [mode, setMode] = useState<Mode>('login');
  const [form, setForm] = useState<LoginForm>({ fullName: '', email: '', password: '', code: '', newPassword: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Success/instruction text, kept apart from `error` so a reset code being
  // issued never renders in the red error styling.
  const [notice, setNotice] = useState<string | null>(null);
  // Which half of the reset flow we are on.
  const [codeSent, setCodeSent] = useState(false);
  // Seeded from the URL so a /physician link still opens on the right tab, but
  // the toggle below is what actually decides — it is visible and switchable.
  const [role, setRole] = useState<ConsoleRole>(portalRole());

  // `keyof LoginForm` means a typo like set('emial', …) is a compile error
  // rather than silently writing a field nothing ever reads.
  const set = (k: keyof LoginForm, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const isSignup = mode === 'signup';
  const isReset = mode === 'reset';
  const go = (m: Mode) => { setMode(m); setError(null); setNotice(null); setCodeSent(false); };

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null); setNotice(null); setBusy(true);
    try {
      if (isReset) {
        if (!codeSent) {
          // Step 1. Where the code actually GOES depends on the server: emailed
          // when SMTP is configured, otherwise printed to the server console
          // for an operator to read out. The message comes from the server's
          // own reply rather than being assumed here, so it stays correct
          // either way.
          const { message } = await requestReset(form.email, role);
          setCodeSent(true);
          setNotice(message || 'A reset code has been issued. Enter it below.');
        } else {
          // Step 2: trade the code for a new password, then back to sign-in.
          await resetPassword({ email: form.email, code: form.code, newPassword: form.newPassword }, role);
          setMode('login'); setCodeSent(false);
          setNotice('Password updated — please sign in with your new password.');
        }
      } else {
        onAuth(isSignup
          ? await signup(form, role)
          : await login({ email: form.email, password: form.password }, role));
      }
    } catch (err) {
      // `catch` gives `unknown` under strict mode — narrow before reading
      // .message, since a thrown non-Error would otherwise crash the handler.
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    'w-full rounded-[9px] border border-slate-700 bg-slate-800/80 px-3.5 py-2.5 text-sm text-slate-100 ' +
    'placeholder:text-slate-500 focus:bg-slate-800 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 outline-none transition';
  const labelCls = 'block text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-1.5';

  const isPhysician = role === 'physician';

  const title = isReset ? 'Reset your password' : isSignup ? 'Create your account' : 'Welcome back';
  const subtitle = isReset
    ? (codeSent
        ? 'Enter the code you were sent, and choose a new password.'
        : 'Enter your email and we will issue a reset code.')
    : isSignup
    ? (isPhysician
        ? 'Register as a physician to review reports and prescribe.'
        : 'Register as a pathologist to review cases.')
    : (isPhysician
        ? 'Sign in to review findings and prescribe treatment.'
        : 'Sign in to review and report on patient cases.');

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
            <div className="mono text-[10px] font-semibold uppercase tracking-[0.16em] text-indigo-300/90 mt-1">{isPhysician ? 'Physician Review' : 'Pathology Console'}</div>
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

          {/* Progress and success messages. Deliberately NOT the error styling —
              "a code has been sent" in red reads as a failure. */}
          {notice && (
            <div className="mb-4 flex items-start gap-2 rounded-xl bg-emerald-950/40 text-emerald-300 ring-1 ring-emerald-900 px-3.5 py-2.5 text-sm">
              <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{notice}</span>
            </div>
          )}

          <form onSubmit={submit} className="space-y-4">
            {/* Which of the two console roles this is. One app serves both,
                because a pathologist and a physician read the SAME case
                screens — only the halves they may edit differ. Picking here
                rather than from the URL keeps it visible and demonstrable:
                sign out, switch, sign in, and the permissions change. */}
            <div>
              <label className={labelCls}>I am a</label>
              <div className="grid grid-cols-2 gap-2">
                {(['pathologist', 'physician'] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRole(r)}
                    aria-pressed={role === r}
                    className={`py-2.5 rounded-[9px] text-sm font-semibold capitalize transition border ${
                      role === r
                        ? 'bg-indigo-600 text-white border-indigo-500 shadow-md shadow-indigo-900/40'
                        : 'bg-slate-800/80 text-slate-300 border-slate-700 hover:bg-slate-800 hover:text-white'
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
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
            {!isReset && (
              <div>
                <label className={labelCls}>Password</label>
                <input type="password" className={inputCls} placeholder={isSignup ? 'At least 6 characters' : '••••••••'} required
                  value={form.password} onChange={(e) => set('password', e.target.value)} />
              </div>
            )}

            {/* Second half of the reset flow. Shown only once a code exists, so
                nobody is presented with a code box before one has been sent. */}
            {isReset && codeSent && (
              <>
                <div>
                  <label className={labelCls}>Reset code</label>
                  <input className={`${inputCls} mono tracking-[0.3em]`} placeholder="000000" required
                    inputMode="numeric" maxLength={6}
                    value={form.code} onChange={(e) => set('code', e.target.value)} />
                </div>
                <div>
                  <label className={labelCls}>New password</label>
                  <input type="password" className={inputCls} placeholder="At least 6 characters" required
                    value={form.newPassword} onChange={(e) => set('newPassword', e.target.value)} />
                </div>
              </>
            )}

            <button type="submit" disabled={busy}
              className="w-full inline-flex items-center justify-center gap-2 py-3 bg-indigo-600 text-white rounded-[10px] font-semibold text-sm tracking-wide hover:bg-indigo-500 active:scale-[0.99] shadow-md shadow-indigo-900/40 transition-all disabled:opacity-60 disabled:cursor-not-allowed">
              {busy
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Please wait…</>
                : isReset
                  ? <><KeyRound className="w-4 h-4" /> {codeSent ? 'Set new password' : 'Send reset code'}</>
                  : isSignup
                    ? <><UserPlus className="w-4 h-4" /> Create account</>
                    : <><LogIn className="w-4 h-4" /> Sign in</>}
            </button>
          </form>

          <div className="text-sm text-slate-400 text-center mt-5">
            {isReset ? (
              <p>
                Remembered it?{' '}
                <button onClick={() => go('login')} className="font-semibold text-indigo-400 hover:text-indigo-300">Back to sign in</button>
              </p>
            ) : isSignup ? (
              <p>
                Already have an account?{' '}
                <button onClick={() => go('login')} className="font-semibold text-indigo-400 hover:text-indigo-300">Sign in</button>
              </p>
            ) : (
              <>
                <p className="mb-1.5">
                  <button onClick={() => go('reset')} className="font-semibold text-indigo-400 hover:text-indigo-300">Forgot password?</button>
                </p>
                <p>
                  New here?{' '}
                  <button onClick={() => go('signup')} className="font-semibold text-indigo-400 hover:text-indigo-300">Create an account</button>
                </p>
              </>
            )}
          </div>
        </div>

        <p className="mono text-[11px] text-slate-600 text-center mt-6">secure · confidential</p>
      </div>
    </div>
  );
}
