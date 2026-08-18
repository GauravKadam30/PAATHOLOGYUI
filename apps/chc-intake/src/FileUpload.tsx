import { useRef, useState, useEffect } from 'react';
import { Microscope, UploadCloud, Image as ImageIcon, Send, Loader2, CheckCircle2, Layers } from 'lucide-react'; // icons
import type { FileInfo } from './types';

// Turn a byte count into a short, friendly size like "820 KB", "2.4 MB" or "1.2 GB".
const formatSize = (bytes: number): string => {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

/*
 * FileUpload.jsx — the card on the right: pick a slide image, see a preview,
 * and press Submit ("Pro Workstation" styling: indigo drag-drop box).
 *
 * Handles two kinds of file:
 *   • an ordinary photo (.png/.jpg), shown as a preview image, and
 *   • a scanner whole-slide file (.tiff/.svs/...), which browsers cannot
 *     display at all — those show a file summary card plus an upload progress
 *     bar instead, since they can be over a gigabyte.
 *
 * Like the form, this card doesn't keep its own data; App.jsx does. It receives:
 *   image     — the chosen photo (as text), or null
 *   slideFile — the chosen scanner slide (raw File), or null
 *   uploadPct — 0-100 while a slide is uploading, else null
 *   onFile    — function to call when the user picks a file
 *   onSubmit  — function to call when the Submit button is pressed
 *   busy      — true while submitting (used to disable the button)
 */
export default function FileUpload({ image, slideFile, uploadPct, onFile, onSubmit, busy }: {
  /** A shrunk photo as a data-URL, or null. */
  image: string | null;
  /** A scanner slide kept as a raw File — too big to preview or inline. */
  slideFile: File | null;
  /** 0-100 while a slide uploads, else null. */
  uploadPct: number | null;
  onFile: (file: File | undefined | null) => void;
  onSubmit: () => void;
  busy: boolean;
}) {
  // A "ref" is a handle to a hidden element on the page. We use it to click the
  // (invisible) file picker from our own nicer-looking upload box below.
  const inputRef = useRef<HTMLInputElement>(null);

  // True only while a file is being dragged over the box, so we can light it up
  // (indigo border) to show "yes, you can drop here".
  const [dragActive, setDragActive] = useState(false);

  // Remembers the chosen file's name and size, so the box can show WHICH file is
  // selected (not just the preview below). Cleared automatically if the image is
  // removed (e.g. after the form is submitted) — see the effect below.
  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null);
  useEffect(() => { if (!image && !slideFile) setFileInfo(null); }, [image, slideFile]);

  // "Something is selected" now means EITHER a shrunk photo or a scanner slide.
  const hasFile = !!image || !!slideFile;

  // One place that handles a chosen file, whether it came from the picker or a
  // drag-and-drop: remember its name/size, then hand it to App like before.
  const pick = (file: File | undefined | null) => {
    if (!file) return;
    setFileInfo({ name: file.name, size: file.size });
    onFile(file);
  };

  // Runs when the user releases a dragged file over the box. We stop the browser
  // from just opening the image in a new tab (its default), then hand the dropped
  // file to App exactly like the file picker does.
  const handleDrop = (e: React.DragEvent<HTMLButtonElement>) => {
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
          <p className="text-xs text-slate-400">Attach a scanned slide or cytology photo</p>
        </div>
      </div>

      {/* The real file picker is hidden (it looks ugly by default). When a file is
          chosen, we hand it to App via onFile, then clear it so the SAME file can
          be re-picked later if needed. `accept` lists the scanner slide formats
          explicitly because they don't match the generic "image/*" type. */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*,.tiff,.tif,.svs,.ndpi,.scn,.mrxs,.vms,.vmu,.bif"
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
            : hasFile
              ? 'border-indigo-300 bg-indigo-50/50 hover:border-indigo-400'       // a file is selected
              : 'border-indigo-200 bg-indigo-50/40 hover:border-indigo-400'
        }`}
      >
        {hasFile ? (
          /* A file is selected: show WHICH file, and that clicking/dropping replaces it. */
          <>
            <div className="pointer-events-none w-12 h-12 rounded-full bg-indigo-600 flex items-center justify-center">
              {slideFile ? <Layers className="w-6 h-6 text-white" /> : <CheckCircle2 className="w-6 h-6 text-white" />}
            </div>
            <div className="pointer-events-none min-w-0 w-full px-2">
              <p className="text-sm font-semibold text-indigo-800 truncate">
                {dragActive ? 'Drop to replace' : (fileInfo?.name || 'Image selected')}
              </p>
              <p className="mono text-xs text-indigo-400 mt-0.5">
                {fileInfo ? `${formatSize(fileInfo.size)} · ` : ''}
                {slideFile ? 'whole-slide image' : 'click or drop to replace'}
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
              <p className="mono text-xs text-indigo-400 mt-0.5">scanned slide (.tiff / .svs) or png / jpg</p>
            </div>
          </>
        )}
      </button>

      {/* Preview area — shows the chosen image, or a placeholder if none yet.
          `flex-1` lets it grow and fill the card's spare height on big screens,
          so the card doesn't leave an empty gap below the preview. */}
      <div className="mt-5 flex-1 flex flex-col min-h-0">
        <p className="mono text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-2">image preview</p>
        {slideFile ? (
          /* Scanner slides can't be shown here — no browser can decode a
             gigapixel .tiff in an <img>. Confirm the file instead; the
             pathologist views it in the console, where it streams as tiles. */
          <div className="w-full flex-1 min-h-[11rem] rounded-xl bg-neutral-50 border border-gray-200 flex flex-col items-center justify-center gap-2 px-4 text-center">
            <div className="w-11 h-11 rounded-xl bg-indigo-600 flex items-center justify-center">
              <Layers className="w-5 h-5 text-white" />
            </div>
            <span className="text-sm font-semibold text-slate-700 truncate max-w-full">{slideFile.name}</span>
            <span className="mono text-[11px] text-slate-400">{formatSize(slideFile.size)} · whole-slide image</span>
            <span className="text-[11px] text-slate-400 leading-relaxed max-w-[16rem]">
              Preview isn't available for scanned slides — it opens zoomable in the Pathology Console.
            </span>
          </div>
        ) : image ? (
          <img src={image} alt="Slide preview" className="w-full flex-1 min-h-[11rem] object-contain rounded-xl bg-neutral-50 border border-gray-200" />
        ) : (
          <div className="w-full flex-1 min-h-[11rem] rounded-xl bg-neutral-50 border border-gray-200 flex flex-col items-center justify-center gap-1.5 text-slate-400">
            <ImageIcon className="w-6 h-6" />
            <span className="text-xs font-medium">No image selected</span>
          </div>
        )}
      </div>

      {/* Upload progress — only while a (large) scanner slide is transferring.
          A gigabyte-scale file takes minutes, so a plain spinner would look
          like the app had frozen. */}
      {uploadPct !== null && (
        <div className="mt-4">
          <div className="flex items-center justify-between mb-1.5">
            <span className="mono text-[10px] font-bold text-slate-400 uppercase tracking-wide">uploading slide</span>
            <span className="mono text-[11px] font-semibold text-indigo-600">{uploadPct}%</span>
          </div>
          <div className="w-full h-2 rounded-full bg-gray-100 overflow-hidden">
            <div className="h-full bg-indigo-600 transition-all duration-200" style={{ width: `${uploadPct}%` }} />
          </div>
        </div>
      )}

      {/* Submit button. While submitting (busy) it's disabled and shows a spinner. */}
      <button
        onClick={onSubmit}
        disabled={busy}
        className="mt-6 w-full inline-flex items-center justify-center gap-2 py-3 bg-indigo-600 text-white rounded-xl font-semibold text-sm tracking-wide hover:bg-indigo-700 active:scale-[0.99] shadow-md shadow-indigo-600/25 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {busy
          ? <><Loader2 className="w-4 h-4 animate-spin" /> {uploadPct !== null ? `Uploading… ${uploadPct}%` : 'Submitting…'}</>
          : <><Send className="w-4 h-4" /> Submit Case to EPTB Hub</>}
      </button>
    </section>
  );
}
