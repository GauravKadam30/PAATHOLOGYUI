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
import { useState } from 'react';                            // React's way to "remember" values
import { CheckCircle2, AlertCircle, X } from 'lucide-react'; // small icons (tick, warning, close)
import Header from './Header';                               // the top bar
import PatientForm from './PatientForm';                     // the form on the left
import FileUpload from './FileUpload';                       // the upload box on the right
import { addCase } from './api';                             // function that sends data to the backend

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
  // --- "State": values the app remembers and re-draws the screen when they change ---
  const [form, setForm] = useState(EMPTY);     // all the typed-in form fields
  const [image, setImage] = useState(null);    // the chosen slide image (as text), or nothing yet
  const [busy, setBusy] = useState(false);     // true while a submit is being sent
  const [toast, setToast] = useState(null);    // the little success/error message, or none

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
    // Make sure the essentials are filled in first.
    if (!form.name.trim() || !image) {
      setToast({ type: 'error', text: 'Please enter the patient name and upload a slide image first.' });
      return;
    }
    setBusy(true);                              // disable the button while sending
    try {
      // Send the patient to the backend, shaped exactly how the Pathology Viewer expects.
      await addCase({
        patient: form.name.trim(),
        age: form.age || '—',
        gender: form.gender || '—',
        site: 'Lymph Node',
        status: 'Pending',
        date: new Date().toISOString().slice(0, 10), // today's date, e.g. "2026-06-21"
        image,
      });
      setForm(EMPTY);                           // clear the form, ready for the next patient
      setImage(null);
      setToast({ type: 'success', text: 'Case submitted — it now appears in the Pathology Viewer queue.' });
    } catch {
      setToast({ type: 'error', text: 'Submit failed. Make sure the backend (apps/server) is running.' });
    } finally {
      setBusy(false);                           // re-enable the button, whether it worked or not
    }
  };

  // --- What gets drawn on screen ---
  // (The className="..." text is styling — it sets colours, spacing and layout.)
  return (
    <div className="min-h-screen bg-slate-100 clinical-bg text-slate-900 flex flex-col">
      <Header />
      {/* `flex-1 ... justify-center` centres the form vertically in the leftover
          space, so the page reads as balanced instead of top-heavy with a big
          empty gap underneath on large screens. */}
      <main className="flex-1 flex flex-col justify-center w-full max-w-7xl mx-auto px-4 sm:px-8 py-6 sm:py-8">
        {/* Page heading */}
        <div className="mb-5">
          <h2 className="text-lg sm:text-xl font-bold tracking-tight text-slate-900">New Patient Intake</h2>
          <p className="text-sm text-slate-500">Register a patient and attach their FNAC slide for review.</p>
        </div>

        {/* The little message bar — only shown when `toast` holds something.
            Green for success, red for an error. The ✕ button dismisses it. */}
        {toast && (
          <div className={`mb-5 flex items-start gap-2.5 rounded-xl px-4 py-3 text-sm ring-1 ${
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

        {/* Two columns on wide screens (form + upload); they stack on phones.
            `form`, `setField`, `image`, etc. are "props" — values handed down to
            each part so they can show data and report changes back here. */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7">
            <PatientForm form={form} setField={setField} />
          </div>
          <div className="lg:col-span-5">
            <FileUpload image={image} onFile={handleFile} onSubmit={handleSubmit} busy={busy} />
          </div>
        </div>
      </main>

      {/* Footer status bar — anchors the bottom of the page. */}
      <footer className="shrink-0 border-t border-slate-200/70 bg-white/70 backdrop-blur-sm px-4 sm:px-8 py-2.5">
        <div className="max-w-7xl mx-auto w-full flex items-center justify-between text-[11px] font-medium text-slate-400">
          <span>Devipur CHC · Patient Intake Portal</span>
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
