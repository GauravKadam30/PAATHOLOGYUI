import { useRef, useState, useEffect } from 'react';
import { Microscope, UploadCloud, Image as ImageIcon, Send, Loader2, CheckCircle2 } from 'lucide-react'; // icons

// Turn a byte count into a short, friendly size like "820 KB" or "2.4 MB".
const formatSize = (bytes) => bytes < 1024 * 1024
  ? `${Math.max(1, Math.round(bytes / 1024))} KB`
  : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/*
 * FileUpload.jsx — the card on the right: pick a slide image, see a preview,
 * and press Submit ("Pro Workstation" styling: indigo drag-drop box).
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
  // (indigo border) to show "yes, you can drop here".
  const [dragActive, setDragActive] = useState(false);

  // Remembers the chosen file's name and size, so the box can show WHICH file is
  // selected (not just the preview below). Cleared automatically if the image is
  // removed (e.g. after the form is submitted) — see the effect below.
  const [fileInfo, setFileInfo] = useState(null);
  useEffect(() => { if (!image) setFileInfo(null); }, [image]);

  // One place that handles a chosen file, whether it came from the picker or a
  // drag-and-drop: remember its name/size, then hand it to App like before.
  const pick = (file) => {
    if (!file) return;
    setFileInfo({ name: file.name, size: file.size });
    onFile(file);
  };

  // Runs when the user releases a dragged file over the box. We stop the browser
  // from just opening the image in a new tab (its default), then hand the dropped
  // file to App exactly like the file picker does.
  const handleDrop = (e) => {
    e.preventDefault();
    setDragActive(false);
    pick(e.dataTransfer.files?.[0]);   // the first file that was dropped
  };

  return (
    <section className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 sm:p-6 h-full flex flex-col">
      {/* Card title with an icon badge */}
      <div className="flex items-center gap-2.5 mb-5">
        <div className="w-8 h-8 rounded-lg bg-indigo-50 flex items-center justify-center shrink-0">
          <Microscope className="w-4 h-4 text-indigo-600" />
        </div>
        <div>
          <h2 className="text-sm font-bold text-slate-900">FNAC Slide Image<span className="text-red-500 ml-0.5">*</span></h2>
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
        onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }}
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
        className={`w-full rounded-xl border-[1.5px] border-dashed transition-colors px-6 py-7 text-center flex flex-col items-center gap-3 ${
          dragActive
            ? 'border-indigo-500 bg-indigo-50'                                    // highlighted while dragging over
            : image
              ? 'border-indigo-300 bg-indigo-50/50 hover:border-indigo-400'       // a file is selected
              : 'border-indigo-200 bg-indigo-50/40 hover:border-indigo-400'
        }`}
      >
        {image ? (
          /* A file is selected: show WHICH file, and that clicking/dropping replaces it. */
          <>
            <div className="pointer-events-none w-12 h-12 rounded-full bg-indigo-600 flex items-center justify-center">
              <CheckCircle2 className="w-6 h-6 text-white" />
            </div>
            <div className="pointer-events-none min-w-0 w-full px-2">
              <p className="text-sm font-semibold text-indigo-800 truncate">
                {dragActive ? 'Drop to replace' : (fileInfo?.name || 'Image selected')}
              </p>
              <p className="mono text-xs text-indigo-400 mt-0.5">
                {fileInfo ? `${formatSize(fileInfo.size)} · ` : ''}click or drop to replace
              </p>
            </div>
          </>
        ) : (
          /* No file yet: show the upload prompt. */
          <>
            <div className="pointer-events-none w-12 h-12 rounded-full bg-indigo-600 flex items-center justify-center">
              <UploadCloud className="w-6 h-6 text-white" />
            </div>
            <div className="pointer-events-none">
              <p className="text-sm font-semibold text-indigo-700">
                {dragActive ? 'Drop the image here' : 'Click to upload or drag & drop'}
              </p>
              <p className="mono text-xs text-indigo-400 mt-0.5">png / jpg · max 10mb</p>
            </div>
          </>
        )}
      </button>

      {/* Preview area — shows the chosen image, or a placeholder if none yet.
          `flex-1` lets it grow and fill the card's spare height on big screens,
          so the card doesn't leave an empty gap below the preview. */}
      <div className="mt-5 flex-1 flex flex-col min-h-0">
        <p className="mono text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-2">image preview</p>
        {image ? (
          <img src={image} alt="Slide preview" className="w-full flex-1 min-h-[11rem] object-contain rounded-xl bg-neutral-50 border border-gray-200" />
        ) : (
          <div className="w-full flex-1 min-h-[11rem] rounded-xl bg-neutral-50 border border-gray-200 flex flex-col items-center justify-center gap-1.5 text-slate-400">
            <ImageIcon className="w-6 h-6" />
            <span className="text-xs font-medium">No image selected</span>
          </div>
        )}
      </div>

      {/* Submit button. While submitting (busy) it's disabled and shows a spinner. */}
      <button
        onClick={onSubmit}
        disabled={busy}
        className="mt-6 w-full inline-flex items-center justify-center gap-2 py-3 bg-indigo-600 text-white rounded-xl font-semibold text-sm tracking-wide hover:bg-indigo-700 active:scale-[0.99] shadow-md shadow-indigo-600/25 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {busy
          ? <><Loader2 className="w-4 h-4 animate-spin" /> Submitting…</>
          : <><Send className="w-4 h-4" /> Submit Case to EPTB Hub</>}
      </button>
    </section>
  );
}
