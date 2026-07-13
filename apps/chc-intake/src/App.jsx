/*
 * App.jsx — the whole intake screen and the brains behind it.
 *
 * It does three things:
 *   1. Remembers what the user typed and which image they picked (this is "state").
 *   2. Lays out the page: a header on top, the patient form on the left, the
 *      slide upload on the right.
 *   3. When "Submit" is pressed, it sends everything to the backend so the new
 *      patient appears in the Pathology Viewer.
 */
import { useState, useEffect } from 'react';                 // React's way to "remember" values
import { CheckCircle2, AlertCircle, X, Loader2 } from 'lucide-react'; // small icons
import Header from './Header';                               // the top bar
import PatientForm from './PatientForm';                     // the patient details card
import ConsultantForm from './ConsultantForm';              // the consultant / OPD notes card
import FileUpload from './FileUpload';                       // the upload box on the right
import Login from './Login';                                 // the sign-in / sign-up screen
import { addCase, getMe, getToken, logout } from './api';    // backend + auth helpers

// The starting (blank) value for every form field.
const EMPTY = { chcId: '', name: '', abha: '', age: '', nikshay: '', gender: '', consultant: '', notes: '' };

// Take the image file the user picked, shrink it to at most 2000 pixels wide/tall,
// and turn it into a piece of text (a "data-URL") that can be stored and sent to
// the server. Shrinking stops the saved image from being unnecessarily huge.
function fileToDataURL(file, maxDim = 2000, quality = 0.9) {
  return new Promise((resolve, reject) => {     // a Promise = "I'll have the answer in a moment"
    const reader = new FileReader();            // a built-in browser tool that reads files
    reader.onerror = reject;
    reader.onload = () => {                      // once the file has been read…
      const img = new Image();                  // …load it as an actual picture
      img.onerror = reject;
      img.onload = () => {                       // once the picture is ready, resize it:
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height)); // shrink factor (never enlarge)
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);          
        const c = document.createElement('canvas'); // a hidden drawing surface
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h); // draw the picture at the smaller size
        resolve(c.toDataURL('image/jpeg', quality));   // hand back the shrunk image as text
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);                 // start reading the chosen file
  });
}

function App() {
  // --- Sign-in state ---
  const [user, setUser] = useState(null);           // the signed-in lab attendant, or null
  const [authChecking, setAuthChecking] = useState(true); // restoring the session on first load?

  // On first load, if we have a saved token, ask the server who we are so the
  // user stays signed in across refreshes. If the token is bad/expired, sign out.
  useEffect(() => {
    if (!getToken()) { setAuthChecking(false); return; }
    getMe()
      .then(setUser)
      .catch(() => logout())
      .finally(() => setAuthChecking(false));
  }, []);

  // --- "State": values the app remembers and re-draws the screen when they change ---
  const [form, setForm] = useState(EMPTY);     // all the typed-in form fields
  const [image, setImage] = useState(null);    // the chosen slide image (as text), or nothing yet
  const [busy, setBusy] = useState(false);     // true while a submit is being sent
  const [toast, setToast] = useState(null);    // the little success/error message, or none

  // Sign out: forget the token and drop back to the login screen.
  const handleLogout = () => { logout(); setUser(null); };

  // Update one form field (e.g. "name") without disturbing the others.
  const setField = (key, value) => setForm(f => ({ ...f, [key]: value }));

  // Runs when the user picks an image: convert it and remember it (or show an error).
  const handleFile = async (file) => {
    if (!file) return;
    try { setImage(await fileToDataURL(file)); }
    catch { setToast({ type: 'error', text: 'Could not read that image — please try another file.' }); }
  };

  // Runs when "Submit Case to EPTB Hub" is pressed.
  const handleSubmit = async () => {
    // All of these are mandatory before a case can be submitted. We collect the
    // list of anything missing and show it, so the user knows exactly what to fill.
    const missing = [];
    if (!form.chcId.trim()) missing.push('CHC Patient ID');
    if (!form.name.trim()) missing.push('Patient Name');
    if (!String(form.age).trim()) missing.push('Age');
    if (!form.gender) missing.push('Gender');
    if (!form.consultant.trim()) missing.push('Consultant Name');
    if (!form.notes.trim()) missing.push('OPD Prescription & Notes');
    if (!image) missing.push('FNAC Slide Image');
    if (missing.length) {
      setToast({ type: 'error', text: `Please fill in: ${missing.join(', ')}.` });
      return;
    }

    setBusy(true);                              // disable the button while sending
    try {
      // Send the patient to the backend (the consultant + notes are now included).
      await addCase({
        patient: form.name.trim(),
        age: form.age,
        gender: form.gender,
        site: 'Lymph Node',
        status: 'Pending',
        date: new Date().toISOString().slice(0, 10), // today's date, e.g. "2026-06-21"
        chcId: form.chcId.trim(),
        abha: form.abha.trim(),
        nikshay: form.nikshay.trim(),
        consultant: form.consultant.trim(),
        notes: form.notes.trim(),
        image,
      });
      setForm(EMPTY);                           // clear the form, ready for the next patient
      setImage(null);
      setToast({ type: 'success', text: 'Case submitted — it now appears in the Pathology Viewer queue.' });
    } catch (err) {
      // Show the server's message; if the session expired, drop back to login.
      const msg = err?.message || 'Submit failed. Make sure the backend (apps/server) is running.';
      setToast({ type: 'error', text: msg });
      if (/sign in|session/i.test(msg)) handleLogout();
    } finally {
      setBusy(false);                           // re-enable the button, whether it worked or not
    }
  };

  // --- What gets drawn on screen ---
  // While we check the saved token, show a brief loader…
  if (authChecking) {
    return (
      <div className="min-h-screen clinical-bg flex items-center justify-center text-slate-400">
        <span className="flex items-center gap-2 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</span>
      </div>
    );
  }
  // …then, if nobody is signed in, show the login screen instead of the form.
  if (!user) return <Login onAuth={setUser} />;

  // (The className="..." text is styling — it sets colours, spacing and layout.)
  // `h-[100dvh] ... overflow-hidden` pins the page to exactly the browser
  // window's height (header/footer fixed, only `main` scrolls if it ever needs
  // to), and `main` has no max-width — the three cards below stretch to fill
  // the FULL window width at any size, not just a capped, centred block.
  return (
    <div className="h-[100dvh] clinical-bg text-slate-900 flex flex-col overflow-hidden">
      <Header user={user} onLogout={handleLogout} onUpdated={setUser} />
      <main className="flex-1 min-h-0 overflow-y-auto flex flex-col w-full px-4 sm:px-8 py-5 sm:py-6">
        {/* Page heading */}
        <div className="mb-5 flex items-end justify-between gap-4 shrink-0">
          <div>
            <h2 className="text-lg sm:text-xl font-extrabold tracking-tight text-slate-900">New Patient Intake</h2>
            <p className="text-sm text-slate-500">Register a patient and attach their FNAC slide for review.</p>
          </div>
          <div className="mono hidden sm:flex items-center gap-2 text-[11px] font-semibold text-indigo-600 bg-indigo-50 border border-indigo-200 rounded-md px-3 py-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> connected · eptb hub
          </div>
        </div>

        {/* The little message bar — only shown when `toast` holds something.
            Green for success, red for an error. The ✕ button dismisses it. */}
        {toast && (
          <div className={`mb-5 flex items-start gap-2.5 rounded-xl px-4 py-3 text-sm ring-1 shrink-0 ${
            toast.type === 'success'
              ? 'bg-emerald-50 text-emerald-800 ring-emerald-200'
              : 'bg-red-50 text-red-800 ring-red-200'
          }`}>
            {toast.type === 'success'
              ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
              : <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />}
            <span className="flex-1">{toast.text}</span>
            <button onClick={() => setToast(null)} className="shrink-0 opacity-60 hover:opacity-100">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Three side-by-side columns spanning the FULL window width on large
            screens (they stack on phones): Patient Information | Consultant |
            FNAC Slide Image. `flex-1` + removing `items-start` (grid's default
            is "stretch") makes all three cards the same height, filling
            whatever vertical space is left in the window too. */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 sm:gap-6 flex-1 min-h-0 pb-1">
          <div className="lg:col-span-5">
            <PatientForm form={form} setField={setField} />
          </div>
          <div className="lg:col-span-4">
            <ConsultantForm form={form} setField={setField} />
          </div>
          <div className="lg:col-span-3">
            <FileUpload image={image} onFile={handleFile} onSubmit={handleSubmit} busy={busy} />
          </div>
        </div>
      </main>

      {/* Footer status bar — anchors the bottom of the page. */}
      <footer className="shrink-0 border-t border-gray-200 bg-white px-4 sm:px-8 py-2.5">
        <div className="w-full flex items-center justify-between text-[11px] font-medium text-slate-400">
          <span className="mono">{user.chcName} · patient intake portal</span>
          <span className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            Connected to EPTB Hub
          </span>
        </div>
      </footer>
    </div>
  );
}

export default App;
