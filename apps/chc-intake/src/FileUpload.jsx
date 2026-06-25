import { useRef, useState } from 'react';
import { Microscope, UploadCloud, Image as ImageIcon, Send, Loader2 } from 'lucide-react'; // icons

/*
 * FileUpload.jsx — the card on the right: pick a slide image, see a preview,
 * and press Submit.
 *
 * Like the form, this card doesn't keep its own data; App.jsx does. It receives:
 *   image    — the chosen picture (as text), or null if none yet
 *   onFile   — function to call when the user picks a file
 *   onSubmit — function to call when the Submit button is pressed
 *   busy     — true while submitting (used to disable the button)
 */
export default function FileUpload({ image, onFile, onSubmit, busy }) {
  // A "ref" is a handle to a hidden element on the page. We use it to click the
  // (invisible) file picker from our own nicer-looking upload box below.
  const inputRef = useRef(null);

  // True only while a file is being dragged over the box, so we can light it up
  // (blue border) to show "yes, you can drop here".
  const [dragActive, setDragActive] = useState(false);

  // Runs when the user releases a dragged file over the box. We stop the browser
  // from just opening the image in a new tab (its default), then hand the dropped
  // file to App exactly like the file picker does.
  const handleDrop = (e) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];   // the first file that was dropped
    if (file) onFile(file);
  };

  return (
    <section className="bg-white rounded-2xl ring-1 ring-slate-200/70 shadow-sm p-5 sm:p-6 h-full flex flex-col">
      {/* Card title with an icon badge */}
      <div className="flex items-center gap-2.5 mb-5">
        <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
          <Microscope className="w-4 h-4 text-blue-600" />
        </div>
        <div>
          <h2 className="text-sm font-bold text-slate-800">FNAC Slide Image</h2>
          <p className="text-xs text-slate-400">Attach the cytology slide photo</p>
        </div>
      </div>

      {/* The real file picker is hidden (it looks ugly by default). When a file is
          chosen, we hand it to App via onFile, then clear it so the SAME file can
          be re-picked later if needed. */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"        // only allow image files
        className="hidden"
        onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }}
      />

      {/* Our nice-looking upload box. Clicking it triggers the hidden picker
          above; dragging a file over it and letting go also works.
          - onDragOver/onDragEnter must call preventDefault, otherwise the
            browser refuses to let you drop here at all.
          - The children are `pointer-events-none` so dragging across the icon or
            text doesn't make the highlight flicker on and off. */}
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
        onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
        onDragLeave={(e) => { e.preventDefault(); setDragActive(false); }}
        onDrop={handleDrop}
        className={`w-full rounded-xl border-2 border-dashed transition-colors px-6 py-8 text-center flex flex-col items-center gap-3 ${
          dragActive
            ? 'border-blue-500 bg-blue-50'                       // highlighted while dragging over
            : 'border-slate-200 hover:border-blue-400 hover:bg-blue-50/40'
        }`}
      >
        <div className="pointer-events-none w-12 h-12 rounded-full bg-blue-50 flex items-center justify-center">
          <UploadCloud className="w-6 h-6 text-blue-600" />
        </div>
        <div className="pointer-events-none">
          {/* Wording changes while dragging, and once an image is already chosen */}
          <p className="text-sm font-semibold text-slate-700">
            {dragActive
              ? 'Drop the image here'
              : image ? 'Choose a different image' : 'Click to upload or drag & drop'}
          </p>
          <p className="text-xs text-slate-400 mt-0.5">PNG or JPG, up to 10 MB</p>
        </div>
      </button>

      {/* Preview area — shows the chosen image, or a placeholder if none yet.
          `flex-1` lets it grow and fill the card's spare height on big screens,
          so the card doesn't leave an empty gap below the preview. */}
      <div className="mt-5 flex-1 flex flex-col min-h-0">
        <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-2">Image Preview</p>
        {image ? (
          <img src={image} alt="Slide preview" className="w-full flex-1 min-h-[11rem] object-contain rounded-xl bg-slate-50 ring-1 ring-slate-200" />
        ) : (
          <div className="w-full flex-1 min-h-[11rem] rounded-xl bg-slate-50 ring-1 ring-slate-200 flex flex-col items-center justify-center gap-1.5 text-slate-400">
            <ImageIcon className="w-6 h-6" />
            <span className="text-xs font-medium">No image selected</span>
          </div>
        )}
      </div>

      {/* Submit button. While submitting (busy) it's disabled and shows a spinner. */}
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
