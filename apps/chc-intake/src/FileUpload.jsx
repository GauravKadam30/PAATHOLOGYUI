import { useRef } from 'react';
import { Microscope, UploadCloud, Image as ImageIcon, Send, Loader2 } from 'lucide-react';

// `image` is the chosen slide as a data-URL (or null). `onFile(file)` is called
// when a file is picked; `onSubmit()` submits the case; `busy` disables it.
export default function FileUpload({ image, onFile, onSubmit, busy }) {
  const inputRef = useRef(null);

  return (
    <section className="bg-white rounded-2xl ring-1 ring-slate-200/70 shadow-sm p-5 sm:p-6 h-full flex flex-col">
      <div className="flex items-center gap-2.5 mb-5">
        <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
          <Microscope className="w-4 h-4 text-blue-600" />
        </div>
        <div>
          <h2 className="text-sm font-bold text-slate-800">FNAC Slide Image</h2>
          <p className="text-xs text-slate-400">Attach the cytology slide photo</p>
        </div>
      </div>

      {/* Hidden native file picker, opened by the dropzone */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }}
      />

      {/* Dropzone — clicking it opens the picker */}
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="w-full rounded-xl border-2 border-dashed border-slate-200 hover:border-blue-400 hover:bg-blue-50/40 transition-colors px-6 py-8 text-center flex flex-col items-center gap-3"
      >
        <div className="w-12 h-12 rounded-full bg-blue-50 flex items-center justify-center">
          <UploadCloud className="w-6 h-6 text-blue-600" />
        </div>
        <div>
          <p className="text-sm font-semibold text-slate-700">
            {image ? 'Choose a different image' : 'Click to upload or drag & drop'}
          </p>
          <p className="text-xs text-slate-400 mt-0.5">PNG or JPG, up to 10 MB</p>
        </div>
      </button>

      {/* Preview pane — shows the uploaded image, or a placeholder */}
      <div className="mt-5">
        <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-2">Image Preview</p>
        {image ? (
          <img src={image} alt="Slide preview" className="w-full h-44 object-contain rounded-xl bg-slate-50 ring-1 ring-slate-200" />
        ) : (
          <div className="w-full h-44 rounded-xl bg-slate-50 ring-1 ring-slate-200 flex flex-col items-center justify-center gap-1.5 text-slate-400">
            <ImageIcon className="w-6 h-6" />
            <span className="text-xs font-medium">No image selected</span>
          </div>
        )}
      </div>

      {/* Submit */}
      <button
        onClick={onSubmit}
        disabled={busy}
        className="mt-6 w-full inline-flex items-center justify-center gap-2 py-3 bg-blue-600 text-white rounded-xl font-semibold text-sm tracking-wide hover:bg-blue-700 active:scale-[0.99] shadow-md shadow-blue-600/20 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {busy
          ? <><Loader2 className="w-4 h-4 animate-spin" /> Submitting…</>
          : <><Send className="w-4 h-4" /> Submit Case to EPTB Hub</>}
      </button>
    </section>
  );
}
