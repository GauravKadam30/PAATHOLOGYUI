import { useState } from 'react';
import { CheckCircle2, AlertCircle, X } from 'lucide-react';
import Header from './Header';
import PatientForm from './PatientForm';
import FileUpload from './FileUpload';
import { addCase } from './api';

const EMPTY = { chcId: '', name: '', abha: '', age: '', nikshay: '', gender: '', consultant: '', notes: '' };

// Read a chosen image file, downscale it to <=2000px, and return a JPEG
// data-URL. Downscaling keeps the stored slide a reasonable size.
function fileToDataURL(file, maxDim = 2000, quality = 0.9) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function App() {
  const [form, setForm] = useState(EMPTY);
  const [image, setImage] = useState(null);   // data-URL of the chosen slide
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);   // { type: 'success'|'error', text }

  const setField = (key, value) => setForm(f => ({ ...f, [key]: value }));

  const handleFile = async (file) => {
    if (!file) return;
    try { setImage(await fileToDataURL(file)); }
    catch { setToast({ type: 'error', text: 'Could not read that image — please try another file.' }); }
  };

  const handleSubmit = async () => {
    if (!form.name.trim() || !image) {
      setToast({ type: 'error', text: 'Please enter the patient name and upload a slide image first.' });
      return;
    }
    setBusy(true);
    try {
      await addCase({
        patient: form.name.trim(),
        age: form.age || '—',
        gender: form.gender || '—',
        site: 'Lymph Node',
        status: 'Pending',
        date: new Date().toISOString().slice(0, 10),
        image,
      });
      setForm(EMPTY);
      setImage(null);
      setToast({ type: 'success', text: 'Case submitted — it now appears in the Pathology Viewer queue.' });
    } catch {
      setToast({ type: 'error', text: 'Submit failed. Make sure the backend (apps/server) is running.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <Header />
      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <div className="mb-5">
          <h2 className="text-lg sm:text-xl font-bold tracking-tight text-slate-900">New Patient Intake</h2>
          <p className="text-sm text-slate-500">Register a patient and attach their FNAC slide for review.</p>
        </div>

        {/* Success / error banner */}
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

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7">
            <PatientForm form={form} setField={setField} />
          </div>
          <div className="lg:col-span-5">
            <FileUpload image={image} onFile={handleFile} onSubmit={handleSubmit} busy={busy} />
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
