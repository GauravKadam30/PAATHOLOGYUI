/**
 * WsiViewer — the whole-slide-image (WSI) viewer with annotation tools.
 * ---------------------------------------------------------------------------
 * THREE LAYERS stacked inside one box:
 *   1. OpenSeadragon canvas  — the pathology slide itself (bottom).
 *   2. Fabric.js canvas      — the pathologist's marks (middle). Shown
 *                              whenever `showAnnotations` is on, not only
 *                              while drawing, so previous findings are visible
 *                              the moment a slide is opened.
 *   3. A transparent overlay — captures the mouse, only while drawing (top).
 *
 * TWO KINDS OF SLIDE, one component:
 *   • A scanner file (.tiff/.svs/…) → `caseData.dziUrl`. Far too large to load
 *     as one image (the development sample is 135,438 × 57,665 px, ~7.8
 *     gigapixels), so OpenSeadragon streams it as small tiles, fetching only
 *     what's on screen at the current zoom.
 *   • An ordinary photo (.png/.jpg) → `caseData.image`, loaded as one file,
 *     exactly as before whole-slide support existed.
 *
 * WHY MARKS STAY GLUED TO THE TISSUE: every shape is stored in IMAGE pixel
 * coordinates, never screen coordinates. `syncViewport` re-projects them on
 * each pan/zoom frame by matching fabric's transform to OpenSeadragon's, so a
 * circle drawn around a cell stays on that cell at any magnification.
 *
 * THE PARENT'S HANDLE (see `useImperativeHandle` below):
 *   save()      → the marks as VECTOR JSON, a few KB, for the parent to store.
 *                 (It used to return a flattened PNG — ~16 MB per case, and
 *                 uneditable once saved. See annotations.js.)
 *   discard()   → roll back to the state this drawing session began in.
 *   exportPNG() → a flattened picture, built ON DEMAND for downloads only.
 *
 * SCALE BAR & MAGNIFICATION are shown only when the slide carries the
 * scanner's microns-per-pixel calibration. Without it, no scale is displayed
 * rather than a guessed one — an invented measurement on a diagnostic image is
 * worse than none.
 */
import { useEffect, useRef, useState, forwardRef, useImperativeHandle, useCallback } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import OpenSeadragon from 'openseadragon';                 // deep-zoom slide viewer
import * as FabricModule from 'fabric';                    // 2D canvas drawing library
import { ZoomIn, ZoomOut, Home, Maximize, Minimize, X, Loader2, List, Crosshair, Square, Circle, PenLine } from 'lucide-react'; // control icons
// URL helpers and the on-demand flattener live in annotations.js, which owns
// everything about how marks are stored and rendered.
import { resolveImageUrl, resolveDziUrl, renderAnnotatedImage, listAnnotations } from './annotations';
import type { AnnotationSummary } from './annotations';
import { fetchSlideInfo, authHeaders } from './api';        // scanner calibration + auth for tile requests
import type { Case, AnnotationData, SlideInfo } from './types';

// fabric v7 has no named `fabric` export, so we use the whole module namespace.
const fabric = FabricModule;

// A custom mouse cursor shaped like an eraser, built from an inline SVG encoded
// as a data-URI (no separate image file needed). The trailing "1 15" is the
// cursor hotspot — the active pixel sits at the eraser's lower-left tip so you
// erase exactly where the icon touches. "cell" is the fallback if the SVG fails.
const ERASER_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="white" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>'
)}") 1 15, cell`;

// --- Scale bar / magnification maths ----------------------------------------
// Everything below depends on the scanner's microns-per-pixel (MPP) figure.
// If a slide doesn't carry one, no scale bar and no magnification are shown —
// a made-up scale on a diagnostic image is worse than none at all.

// Objective magnifications offered as quick presets, matching a microscope's
// turret. The conventional mapping between an objective and the scan
// resolution it corresponds to is 10/M microns per pixel — a 40x objective is
// ~0.25 µm/px, 20x is ~0.5, 10x is ~1.0, 4x is ~2.5.
// One wheel notch's worth of zoom, matching OpenSeadragon's own default so
// scrolling feels identical whether or not a drawing tool is active.
const ZOOM_PER_SCROLL = 1.2;

const MAGNIFICATION_PRESETS = [4, 10, 20, 40];
const MICRONS_PER_PIXEL_AT_1X = 10;

// Lengths a scale bar is allowed to show. Bars snap to one of these so the
// label is always a round number a pathologist can reason about, rather than
// something like "137 µm".
const NICE_SCALE_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];
const TARGET_SCALE_BAR_PX = 130;   // preferred on-screen length before snapping

// How many microns one SCREEN pixel currently covers.
// `zoom` is OpenSeadragon's viewport zoom, where 1 means the image width
// exactly fills the container.
const micronsPerScreenPixel = (mpp: number, imageWidth: number, containerWidth: number, zoom: number): number =>
  (mpp * imageWidth) / (zoom * containerWidth);

// The objective magnification the current view corresponds to.
const magnificationFor = (mpp: number, imageWidth: number, containerWidth: number, zoom: number): number =>
  MICRONS_PER_PIXEL_AT_1X / micronsPerScreenPixel(mpp, imageWidth, containerWidth, zoom);

// The viewport zoom needed to display at a given objective magnification —
// the inverse of magnificationFor(), used by the preset buttons.
const zoomForMagnification = (mpp: number, imageWidth: number, containerWidth: number, magnification: number): number =>
  (mpp * imageWidth * magnification) / (MICRONS_PER_PIXEL_AT_1X * containerWidth);

/** A scale bar ready to draw: how long it claims to be, and how wide to draw it. */
interface ScaleBar {
  microns: number;
  widthPx: number;
  label: string;
}

/** What the overlay currently displays. Null when the slide has no calibration. */
interface ScaleState {
  magnification: number;
  scaleBar: ScaleBar;
}

// Choose a round micron length whose on-screen width lands near the target,
// and report both the label and the exact pixel width to draw.
function computeScaleBar(micronsPerPx: number): ScaleBar {
  const rawMicrons = TARGET_SCALE_BAR_PX * micronsPerPx;
  // `?? last` covers both "nothing is big enough" and the possibly-undefined
  // index access that noUncheckedIndexedAccess flags.
  const microns = NICE_SCALE_STEPS.find((s) => s >= rawMicrons)
    ?? NICE_SCALE_STEPS[NICE_SCALE_STEPS.length - 1]!;
  return {
    microns,
    widthPx: microns / micronsPerPx,
    label: microns >= 1000 ? `${microns / 1000} mm` : `${microns} µm`,
  };
}

/** The handle the parent gets on this viewer, via its ref. */
export interface WsiViewerHandle {
  /** Current marks as vector JSON (a few KB) for the parent to persist. */
  save: () => AnnotationData | null;
  /** Roll back to the state this drawing session began in. */
  discard: () => Promise<void>;
  /** A flattened PNG, built on demand for downloads only. */
  exportPNG: () => Promise<string | null>;
}

interface WsiViewerProps {
  caseData: Case;
  annotationMode: boolean;
  annotationColor: string | null;
  annotationTool: string | null;
  /**
   * Previously saved marks for this case (fabric JSON in image coordinates).
   * They're loaded onto the canvas when the slide opens, so a pathologist sees
   * earlier annotations straight away and can edit them rather than starting
   * from scratch each session.
   */
  savedAnnotations?: AnnotationData | null;
  /** Lets the viewer show the clean, unmarked slide without discarding anything. */
  showAnnotations?: boolean;
}

// `forwardRef` lets the parent hold a handle to this component so it can call
// save()/discard()/exportPNG() (wired up via useImperativeHandle further down).
const WsiViewer = forwardRef<WsiViewerHandle, WsiViewerProps>(({
  caseData, annotationMode, annotationColor, annotationTool,
  savedAnnotations,
  showAnnotations = true,
}, ref) => {
  // --- Refs hold long-lived objects/DOM nodes that must survive re-renders ---
  const viewerRef = useRef<OpenSeadragon.Viewer | null>(null);   // the OpenSeadragon viewer instance
  const rootRef = useRef<HTMLDivElement | null>(null);           // outer box; ancestor of every layer, so wheel events reach it
  const containerRef = useRef<HTMLDivElement | null>(null);      // the <div> OpenSeadragon renders into
  const canvasElRef = useRef<HTMLDivElement | null>(null);       // wrapper <div> that holds the fabric canvas
  const fabricRef = useRef<FabricModule.Canvas | null>(null);    // the fabric.Canvas instance
  const imgSizeRef = useRef<OpenSeadragon.Point | null>(null);   // natural image size {x, y} in image px
  const baselineRef = useRef<AnnotationData | null>(null);       // canvas snapshot taken when annotation mode was enabled (for "Don't save")

  // --- State that, when changed, should re-render the component ---
  const [isReady, setIsReady] = useState(false);          // gate: only build the viewer after first render
  const [hoverInImage, setHoverInImage] = useState(false); // is the cursor currently over the slide image?
  const [isFullPage, setIsFullPage] = useState(false);     // is the viewer in our custom full-screen mode?
  // Scanner calibration for this slide, or null for an ordinary photo case /
  // a slide with no calibration recorded.
  const [slideInfo, setSlideInfo] = useState<SlideInfo | null>(null);
  // Recomputed as the user zooms.
  const [scaleState, setScaleState] = useState<ScaleState | null>(null);

  // Drawing is allowed once the user has picked a tool, plus a color for the
  // drawing tools — the eraser doesn't need one.
  const canDraw = annotationMode && !!annotationTool &&
    (annotationTool === 'eraser' || !!annotationColor);

  // Flip `isReady` true once, right after the first render, so the effects below
  // run only when the container <div>s already exist in the DOM.
  useEffect(() => { setIsReady(true); }, []);

  // Fetch the scanner's calibration for whole-slide cases. Ordinary photo
  // cases have no known physical scale, so they get no scale bar.
  useEffect(() => {
    setSlideInfo(null);
    setScaleState(null);
    if (!caseData?.dziUrl || !caseData?.id) return;
    let cancelled = false;
    fetchSlideInfo(caseData.id).then((info) => {
      if (!cancelled && info?.mppX) setSlideInfo(info);
    });
    return () => { cancelled = true; };
  }, [caseData]);

  // Keep the scale bar and magnification readout in step with the viewport.
  // OpenSeadragon fires 'zoom' on every animation frame of a zoom, so the
  // state is only updated when the DISPLAYED values actually change —
  // otherwise this would re-render the component dozens of times a second.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !slideInfo?.mppX) return;
    // Pulled out of the optional-chained object so TypeScript can see it stays
    // a number inside the closure below — `slideInfo.mppX` on its own is
    // `number | null`, and the guard above doesn't narrow across a callback.
    const mpp = slideInfo.mppX;
    const imageWidth = slideInfo.width;

    const recompute = () => {
      const containerWidth = viewer.container?.clientWidth;
      if (!containerWidth) return;
      const zoom = viewer.viewport.getZoom(true);
      if (!zoom || !isFinite(zoom)) return;

      const perPx = micronsPerScreenPixel(mpp, imageWidth, containerWidth, zoom);
      if (!isFinite(perPx) || perPx <= 0) return;
      const magnification = magnificationFor(mpp, imageWidth, containerWidth, zoom);
      const scaleBar = computeScaleBar(perPx);

      setScaleState((prev) => {
        const mag = magnification >= 10 ? Math.round(magnification) : Math.round(magnification * 10) / 10;
        if (prev && prev.magnification === mag && prev.scaleBar.microns === scaleBar.microns
            && Math.abs(prev.scaleBar.widthPx - scaleBar.widthPx) < 0.5) {
          return prev;                     // nothing visibly changed
        }
        return { magnification: mag, scaleBar };
      });
    };

    recompute();
    // 'zoom' fires when a zoom is REQUESTED — before the spring animation has
    // moved anything — so listening to it alone leaves the readout showing the
    // previous position. 'animation' fires each frame while the view is
    // settling and 'animation-finish' guarantees a final, exact sample.
    // These five are all real OpenSeadragon events, but its typings model the
    // event map as a closed union, so a string[] doesn't satisfy it. The cast
    // is narrow and deliberate rather than loosening the handler signature.
    const events = ['zoom', 'animation', 'animation-finish', 'open', 'resize'] as const;
    type ViewerEvent = Parameters<OpenSeadragon.Viewer['addHandler']>[0];
    events.forEach((e) => viewer.addHandler(e as ViewerEvent, recompute));
    return () => events.forEach((e) => viewer.removeHandler(e as ViewerEvent, recompute));
  }, [slideInfo, isReady, caseData, isFullPage]);

  // Jump straight to a standard objective magnification, like turning a
  // microscope's turret. Clamped to what the viewer allows.
  const goToMagnification = useCallback((magnification: number) => {
    const viewer = viewerRef.current;
    if (!viewer || !slideInfo?.mppX) return;
    const containerWidth = viewer.container?.clientWidth;
    if (!containerWidth) return;
    const target = zoomForMagnification(slideInfo.mppX, slideInfo.width, containerWidth, magnification);
    viewer.viewport.zoomTo(Math.min(target, viewer.viewport.getMaxZoom()));
    viewer.viewport.applyConstraints();
  }, [slideInfo]);

  // The magnification the scan itself actually resolves — one screen pixel per
  // image pixel. Presets beyond this still work but are digital enlargement,
  // so they're marked in the UI rather than pretending to be real optics.
  const nativeMagnification = slideInfo?.mppX
    ? MICRONS_PER_PIXEL_AT_1X / slideInfo.mppX
    : null;

  // Keeps the fabric canvas aligned with the slide: annotations live in image
  // pixel coordinates, and this maps them to the screen on every pan/zoom so
  // saved shapes stick to the tissue they were drawn on.
  // --- Annotation list ------------------------------------------------------
  // Marks live in image coordinates, so one drawn at 20x is only a few screen
  // pixels once the whole slide is in view — on this scanner's output a 100 µm
  // lesion is about 3 px wide zoomed out. Finding them by eye is impractical,
  // so they are listed and each row flies the viewer to its mark.
  const [marks, setMarks] = useState<AnnotationSummary[]>([]);
  const [listOpen, setListOpen] = useState(false);

  /** Re-read the canvas into the list. Cheap — it walks the saved JSON only. */
  const refreshMarks = useCallback(() => {
    const canvas = fabricRef.current;
    setMarks(canvas ? listAnnotations(canvas.toJSON() as AnnotationData) : []);
  }, []);

  /**
   * Fly the viewer to one mark.
   *
   * Padded to 40% of the mark's larger side so it lands framed rather than
   * filling the screen edge to edge, and so a tiny mark still arrives at a
   * sensible zoom instead of magnifying to a blur.
   */
  const goToMark = useCallback((m: AnnotationSummary) => {
    const viewer = viewerRef.current;
    const item = viewer?.world?.getItemAt(0);
    if (!viewer || !item) return;
    const pad = Math.max(m.box.width, m.box.height) * 0.4 || 50;
    const rect = item.imageToViewportRectangle(new OpenSeadragon.Rect(
      m.box.left - pad, m.box.top - pad,
      m.box.width + pad * 2, m.box.height + pad * 2,
    ));
    viewer.viewport.fitBounds(rect, false);   // false = animate the flight
  }, []);

  // Keep the list in step with the canvas. Fabric fires these for adds, edits
  // and erases alike, so one set of handlers covers every way marks change.
  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    const update = () => refreshMarks();
    canvas.on('object:added', update);
    canvas.on('object:removed', update);
    canvas.on('object:modified', update);
    update();
    return () => {
      canvas.off('object:added', update);
      canvas.off('object:removed', update);
      canvas.off('object:modified', update);
    };
  }, [refreshMarks, savedAnnotations, caseData.id]);

  const syncViewport = useCallback(() => {
    const viewer = viewerRef.current;
    const canvas = fabricRef.current;
    if (!viewer || !canvas || !viewer.world) return;
    const item = viewer.world.getItemAt(0);   // the slide image inside OSD
    if (!item) return;
    // Ask OSD where image pixels (0,0) and (1,0) currently sit on screen.
    const p0 = viewer.viewport.pixelFromPoint(item.imageToViewportCoordinates(new OpenSeadragon.Point(0, 0)), true);
    const p1 = viewer.viewport.pixelFromPoint(item.imageToViewportCoordinates(new OpenSeadragon.Point(1, 0)), true);
    const scale = p1.x - p0.x;                 // distance between them = current zoom scale
    // Apply that scale + offset to fabric so it draws image-space shapes
    // exactly where the matching tissue appears on screen. Matrix form:
    // [scaleX, skewY, skewX, scaleY, translateX, translateY].
    canvas.setViewportTransform([scale, 0, 0, scale, p0.x, p0.y]);
  }, []);

  // --- Build / rebuild the OpenSeadragon viewer when the patient changes ---
  useEffect(() => {
    // Two kinds of case can be shown, and either is enough to open the viewer:
    //   • a scanner whole-slide image → caseData.dziUrl, streamed as tiles
    //   • an ordinary photo of a slide → caseData.image, loaded as one file
    if (!isReady || (!caseData?.image && !caseData?.dziUrl) || !containerRef.current) return;

    // Tear down any previous viewer before creating a new one (patient switch).
    if (viewerRef.current) {
      viewerRef.current.destroy();
      viewerRef.current = null;
    }

    const viewer = OpenSeadragon({
      element: containerRef.current,
      // A .dzi descriptor is passed as a plain URL string — OpenSeadragon
      // recognises Deep Zoom and fetches only the tiles the current view
      // needs, which is the only way a gigapixel slide can be displayed at
      // all. Everything else still loads as a single flat image, exactly as
      // before, so existing PNG/JPG cases are unaffected.
      tileSources: caseData.dziUrl
        ? resolveDziUrl(caseData.dziUrl)
        : { type: 'image', url: resolveImageUrl(caseData.image) },
      animationTime: 0.5,   // seconds for zoom/pan spring animation
      blendTime: 0.1,       // seconds for image tiles to fade in
      // How far past native resolution the user may zoom. OpenSeadragon's
      // default (1.1) stops almost exactly at one image pixel per screen
      // pixel, which feels like the viewer has "hit a wall" mid-examination.
      // 2 allows a further 2x digital magnification — note this only enlarges
      // the pixels that are already there, it does NOT reveal more detail;
      // the real limit is whatever the scanner captured.
      maxZoomPixelRatio: 2,
      // The default sprite-image buttons are replaced by our own styled
      // controls rendered in JSX below.
      showNavigationControl: false,
      // Tiles are patient data, so /slides/* requires a signed-in account.
      // OpenSeadragon normally loads tiles by assigning image URLs, and an
      // <img> cannot carry an Authorization header — every tile would come
      // back 401. Switching to AJAX makes it fetch them with XHR instead, so
      // the same token used everywhere else can be attached.
      loadTilesWithAjax: true,
      ajaxHeaders: authHeaders(),
    });

    // 'open' fires once the slide image has loaded.
    viewer.addHandler('open', () => {
      const item = viewer.world.getItemAt(0);
      if (item) imgSizeRef.current = item.getContentSize(); // remember natural size for bounds checks
      syncViewport();
    });
    // Fires on every rendered frame of a pan/zoom, keeping annotations glued.
    viewer.addHandler('update-viewport', syncViewport);

    viewerRef.current = viewer;
    return () => viewer.destroy();   // cleanup when patient changes / unmounts
  }, [caseData, isReady, syncViewport]);

  // --- Build the fabric annotation canvas (its own layer over the viewer) ---
  // The <canvas> element is created here in JS rather than in JSX because fabric
  // mutates the DOM around it, and StrictMode double-mounting would otherwise
  // initialize the same element twice.
  useEffect(() => {
    if (!isReady || !canvasElRef.current || !containerRef.current) return;

    const wrapper = canvasElRef.current;
    // Each canvas gets its OWN holder div. fabric's async dispose() can finish
    // late; removing only this holder avoids wiping a freshly mounted canvas.
    const holder = document.createElement('div');
    holder.style.position = 'absolute';
    holder.style.inset = '0';
    wrapper.appendChild(holder);
    const el = document.createElement('canvas');
    holder.appendChild(el);

    const canvas = new fabric.Canvas(el, {
      selection: false,   // disable fabric's group-selection box
    });
    fabricRef.current = canvas;

    // Match the canvas size to the viewer box, then re-align to the slide.
    const resize = () => {
      if (!containerRef.current) return;
      canvas.setDimensions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
      });
      syncViewport();
      canvas.renderAll();
    };
    resize();
    window.addEventListener('resize', resize);

    // Restore this case's saved marks. They're stored as vector shapes in
    // image coordinates, so they land back exactly on the tissue they were
    // drawn on — and stay editable, unlike the flattened image we used to
    // keep. `cancelled` guards against a patient switch landing mid-load.
    let cancelled = false;
    if (savedAnnotations) {
      Promise.resolve(canvas.loadFromJSON(savedAnnotations)).then(() => {
        if (cancelled || fabricRef.current !== canvas) return;
        syncViewport();          // loadFromJSON resets the transform
        canvas.renderAll();
        // Explicit: loadFromJSON populates the canvas in bulk without firing
        // an `object:added` per shape, so the list would stay empty on a case
        // that already has saved marks — exactly the case worth listing.
        refreshMarks();
      }).catch(() => { /* corrupt saved data — start clean rather than break */ });
    }

    return () => {
      cancelled = true;
      window.removeEventListener('resize', resize);
      fabricRef.current = null;
      // dispose() is async in fabric v6+; remove only this instance's holder
      // so a newly mounted canvas isn't wiped out by a late cleanup.
      Promise.resolve(canvas.dispose()).finally(() => holder.remove());
    };
  }, [isReady, caseData, syncViewport]);

  // --- Hand the mouse to the drawing tools, but only once one is chosen ---
  // Gated on `canDraw`, NOT on annotationMode. Turning navigation off for the
  // whole of annotation mode froze the slide the moment the mode opened: with
  // no tool selected there is no capture overlay either, so the viewer simply
  // stopped responding to the mouse and could be neither panned nor zoomed.
  // With a tool active the overlay covers the viewer anyway, so drags reach the
  // canvas rather than OpenSeadragon regardless of this setting.
  useEffect(() => {
    if (!viewerRef.current) return;
    viewerRef.current.setMouseNavEnabled(!canDraw);
    // `innerTracker` is real and public in OpenSeadragon but missing from its
    // bundled .d.ts, so it needs a narrow cast rather than an `any` viewer.
    (viewerRef.current as unknown as { innerTracker: { setTracking(v: boolean): void } })
      .innerTracker.setTracking(!canDraw);
  }, [canDraw]);

  // --- Snapshot the canvas when an annotation session begins ---
  // Includes any previously saved marks. "Don't save" rolls back to THIS, i.e.
  // the last saved state, rather than wiping the case's whole history as it did
  // when annotations were flattened into an image.
  useEffect(() => {
    if (annotationMode && fabricRef.current) {
      baselineRef.current = fabricRef.current.toJSON();
    }
  }, [annotationMode]);

  // --- Scroll-to-zoom while a drawing tool is active ---
  // With a tool selected, the transparent capture overlay sits above the
  // viewer, so wheel events land on it and never reach OpenSeadragon — leaving
  // the slide stuck at whatever magnification it happened to be on. Zooming is
  // exactly what a pathologist needs mid-annotation (mark a field at 40x, pull
  // back, move to the next one), so the wheel is forwarded to the viewport by
  // hand.
  //
  // This is a NATIVE listener with { passive: false } on purpose. React
  // registers its own wheel handlers passively at the root, where
  // preventDefault() is ignored — the slide would zoom and the page would
  // scroll behind it at the same time.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !canDraw) return;

    const onWheel = (e: WheelEvent) => {
      const viewer = viewerRef.current;
      if (!viewer) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? ZOOM_PER_SCROLL : 1 / ZOOM_PER_SCROLL;
      // Zoom about the pointer, as OpenSeadragon's own scroll-to-zoom does.
      // Zooming about the centre instead would slide the tissue under the
      // cursor out from under it, which is disorienting at high magnification.
      const box = root.getBoundingClientRect();
      const at = viewer.viewport.pointFromPixel(
        new OpenSeadragon.Point(e.clientX - box.left, e.clientY - box.top),
      );
      viewer.viewport.zoomBy(factor, at);
      viewer.viewport.applyConstraints();
    };

    root.addEventListener('wheel', onWheel, { passive: false });
    return () => root.removeEventListener('wheel', onWheel);
  }, [canDraw]);

  // Existing marks are selectable/movable only while annotating; the rest of
  // the time they are inert decoration over the slide.
  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    for (const o of canvas.getObjects()) {
      o.selectable = annotationMode;
      o.evented = annotationMode;
    }
    canvas.renderAll();
  }, [annotationMode, savedAnnotations]);

  // --- Custom full-screen ("full page") mode ---
  // OSD's built-in setFullPage moves only its own div onto the bare (white) page
  // body, leaving our annotation layer and controls behind. Instead we expand
  // the WHOLE viewer block on a dark background.
  //
  // THIS DELIBERATELY DOES NOT TOUCH BROWSER HISTORY, and that is a fix rather
  // than an omission. It used to push an entry so the Back button would exit
  // full screen:
  //
  //     window.history.pushState({ wsiFullPage: true }, '');
  //
  // but a raw pushState REPLACES the state React Router keeps there — it tracks
  // its position in the stack as `{ idx: n }`. The entry left behind had no
  // idx, and it outlived full screen: after using the control once, a
  // pathologist looking at a slide could press Back and watch nothing happen,
  // because that press was silently spent on the phantom entry. Reaching the
  // worklist took two presses, the first appearing broken.
  //
  // Escape and the on-screen Exit control both still work. The cost is that a
  // phone's Back button now leaves the slide instead of exiting full screen —
  // a far smaller price than Back not working anywhere in the app.
  const enterFullPage = () => setIsFullPage(true);
  const exitFullPage = useCallback(() => setIsFullPage(false), []);

  // Escape exits full screen. No popstate listener: nothing is pushed now.
  useEffect(() => {
    if (!isFullPage) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') exitFullPage(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isFullPage, exitFullPage]);

  // Toggling full page resizes the container without firing a window 'resize'
  // event, so re-fit the annotation canvas manually a moment later.
  useEffect(() => {
    const t = setTimeout(() => {
      const canvas = fabricRef.current;
      if (canvas && containerRef.current) {
        canvas.setDimensions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
        syncViewport();
        canvas.renderAll();
      }
    }, 60);
    return () => clearTimeout(t);
  }, [isFullPage, syncViewport]);

  // Flatten the current marks onto the slide and return a PNG data-URL.
  // Used ONLY for downloading/previewing a report image — nothing this large
  // is stored; the saved annotation is the vector JSON from save() below.
  // The actual compositing lives in annotations.js so the Reports page can do
  // the same thing without the viewer being mounted.
  const compositeAnnotatedImage = useCallback(async () => {
    const canvas = fabricRef.current;
    if (!canvas) return null;
    const size = imgSizeRef.current;
    return renderAnnotatedImage(caseData, canvas.toJSON(), size?.x, size?.y);
  }, [caseData]);

  // Expose a small API to the parent via its ref.
  useImperativeHandle(ref, () => ({
    // Returns the marks as VECTOR JSON (a few KB) for the parent to persist —
    // not a flattened image. The live slide is never altered.
    save: () => {
      const canvas = fabricRef.current;
      return canvas ? canvas.toJSON() : null;
    },
    // "Don't save": reload the snapshot taken when this session began, which
    // includes any previously saved marks — so discarding one session's edits
    // no longer throws away the case's earlier annotations.
    discard: async () => {
      const canvas = fabricRef.current;
      if (canvas && baselineRef.current) {
        await canvas.loadFromJSON(baselineRef.current);
        syncViewport();
        canvas.renderAll();
      }
    },
    // Flattened PNG, built on demand for the Download button only.
    exportPNG: compositeAnnotatedImage,
  }), [caseData, syncViewport, compositeAnnotatedImage]);

  // Convert a screen (mouse) position into IMAGE pixel coordinates by running it
  // through the INVERSE of the current viewport transform.
  // Returns null when the canvas or container isn't mounted yet, so every
  // caller has to handle "not ready" rather than crashing on a null deref.
  const toImagePoint = (clientX: number, clientY: number): FabricModule.Point | null => {
    const canvas = fabricRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return null;
    const rect = container.getBoundingClientRect();
    const inv = fabric.util.invertTransform(canvas.viewportTransform);
    return fabric.util.transformPoint(new fabric.Point(clientX - rect.left, clientY - rect.top), inv);
  };

  // True only if an image-space point lies within the slide's bounds — this is
  // what restricts annotation to the slide itself.
  const isInImage = (pt: FabricModule.Point | null): boolean => {
    const s = imgSizeRef.current;
    return !!s && !!pt && pt.x >= 0 && pt.y >= 0 && pt.x <= s.x && pt.y <= s.y;
  };

  // Pointer-down on the drawing overlay: begins a shape/stroke (or erases) for
  // the active tool. Pointer Events cover mouse, touch (phone) and pen alike.
  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const canvas = fabricRef.current;
    if (!canvas || !canDraw) return;
    e.preventDefault();

    // One-stroke eraser: tap or drag over a mark to delete that whole mark.
    // The pointer and each mark's bounding box are both compared in IMAGE
    // (scene) coordinates, so it works at any zoom; the topmost mark wins.
    if (annotationTool === 'eraser') {
      const eraseAt = (ev: { clientX: number; clientY: number }) => {
        const pt = toImagePoint(ev.clientX, ev.clientY);
        if (!pt) return;
        const objs = canvas.getObjects();
        // Walk BACKWARDS: fabric keeps objects in paint order, so the last one
        // is the topmost on screen. Iterating in reverse means overlapping
        // marks are erased in the order the user sees them.
        for (let i = objs.length - 1; i >= 0; i--) {
          const o = objs[i];
          if (!o) continue;                    // strict indexing: element is possibly undefined
          o.setCoords();                       // refresh fabric's cached corners
          const r = o.getBoundingRect();
          // A thick stroke is drawn centred on the shape's edge, so half of it
          // sits outside the bounding box. Padding by the stroke width means
          // clicking the visible line erases, rather than feeling "just off".
          const pad = (o.strokeWidth || 2);
          if (pt.x >= r.left - pad && pt.x <= r.left + r.width + pad &&
              pt.y >= r.top - pad && pt.y <= r.top + r.height + pad) {
            canvas.remove(o);
            canvas.renderAll();
            return;                            // one mark per position, not all of them
          }
        }
      };
      eraseAt(e.nativeEvent);                  // erase on the initial tap too, not only on drag
      // Listeners go on `window`, not the overlay: a fast drag can leave the
      // element mid-stroke, and we still need the move/up events.
      const onMove = (ev: PointerEvent) => eraseAt(ev);
      const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      return;
    }

    // Drawing tools only act on the slide image itself.
    const start = toImagePoint(e.clientX, e.clientY);
    // isInImage already rejects null, but TypeScript can't see that through the
    // helper — this second check narrows `start` for everything below.
    if (!start || !isInImage(start)) return;
    const color = annotationColor ?? '#000000';
    // Stroke widths are in image px so they scale with zoom along with the
    // shape; divide by current scale so they appear ~3px (18px eraser) now.
    const scale = canvas.viewportTransform[0] || 1;
    const strokeW = 3 / scale;

    // Convert a move event to an image point, clamped to the slide's edges so a
    // drag that wanders off the image doesn't draw outside it. Falls back to
    // the press point if the canvas has gone away mid-drag.
    const clampMove = (ev: PointerEvent): FabricModule.Point => {
      const p = toImagePoint(ev.clientX, ev.clientY);
      if (!p) return start;
      const s = imgSizeRef.current;
      if (s) {
        p.x = Math.min(Math.max(p.x, 0), s.x);
        p.y = Math.min(Math.max(p.y, 0), s.y);
      }
      return p;
    };

    if (annotationTool === 'rect') {
      // The corner where the mouse was pressed stays fixed; only the
      // opposite corner follows the cursor, so the box grows purely in
      // the drag direction.
      const box = new fabric.Rect({
        left: start.x, top: start.y, width: 0, height: 0,
        // fabric v7 defaults origin to 'center', which makes the box grow
        // in all four directions — anchor it to the press corner instead.
        originX: 'left', originY: 'top',
        fill: 'transparent', stroke: color, strokeWidth: strokeW, selectable: true,
      });
      canvas.add(box);
      canvas.renderAll();

      const onMove = (ev: PointerEvent) => {
        const p = clampMove(ev);
        // Re-anchor top-left to whichever side the cursor is on, and size from
        // the absolute distance — so dragging any direction keeps a clean box.
        box.set({
          left: p.x >= start.x ? start.x : p.x,
          top: p.y >= start.y ? start.y : p.y,
          width: Math.abs(p.x - start.x),
          height: Math.abs(p.y - start.y),
        });
        box.setCoords();   // refresh fabric's cached corner positions
        canvas.renderAll();
      };
      // Stop tracking on mouse-up. Listeners live on `window` so a fast drag
      // that leaves the element still ends correctly.
      const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);

    } else if (annotationTool === 'oval') {
      // Same corner-anchored behaviour as the rectangle: the press point is
      // fixed and the oval grows toward the cursor, keeping its oval shape
      // (inscribed in the drag rectangle) rather than expanding from center.
      const oval = new fabric.Ellipse({
        left: start.x, top: start.y, rx: 0, ry: 0,
        originX: 'left', originY: 'top',
        fill: 'transparent', stroke: color, strokeWidth: strokeW, selectable: true,
      });
      canvas.add(oval);
      canvas.renderAll();

      const onMove = (ev: PointerEvent) => {
        const p = clampMove(ev);
        oval.set({
          left: p.x >= start.x ? start.x : p.x,
          top: p.y >= start.y ? start.y : p.y,
          rx: Math.abs(p.x - start.x) / 2,   // radii are half the drag box
          ry: Math.abs(p.y - start.y) / 2,
        });
        oval.setCoords();
        canvas.renderAll();
      };
      const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);

    } else {
      // freehand: a path that grows point-by-point as you drag.
      let pathStr = `M ${start.x} ${start.y}`;
      let pathObj: FabricModule.Path | null = null;

      const onMove = (ev: PointerEvent) => {
        const p = clampMove(ev);
        pathStr += ` L ${p.x} ${p.y}`;
        if (pathObj) canvas.remove(pathObj);   // replace with the longer path
        pathObj = new fabric.Path(pathStr, {
          stroke: color, strokeWidth: strokeW, fill: '',
          strokeLineCap: 'round', strokeLineJoin: 'round', selectable: true,
        });
        canvas.add(pathObj);
        canvas.renderAll();
      };
      const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    }
  };

  return (
    // Outer box. In full screen it becomes a fixed, dark overlay covering the
    // whole window; otherwise it just fills its parent.
    <div
      ref={rootRef}
      className={isFullPage
        ? 'fixed inset-0 z-[90] bg-slate-950'
        : 'w-full h-full bg-slate-900 relative'}>
      {/* Layer 1: OpenSeadragon renders the slide into this div. */}
      <div ref={containerRef} className="w-full h-full absolute inset-0" />

      {/* Shown briefly while an intake patient's image is still being fetched.
          Whole-slide cases skip this — they stream tiles instead of loading a
          single file, so there's nothing to wait on before the viewer opens. */}
      {caseData?.hasImage && !caseData?.image && !caseData?.dziUrl && (
        <div className="absolute inset-0 z-[55] flex items-center justify-center text-slate-400">
          <span className="flex items-center gap-2 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading slide…
          </span>
        </div>
      )}

      {/* Layer 2: fabric annotation canvas — the marks themselves.
          Now that annotations are stored as vectors rather than baked into a
          flattened image, saved marks are drawn live over the slide whenever
          the case is open, so a pathologist sees earlier findings immediately
          instead of having to export a picture to check. `showAnnotations`
          hides them again to inspect the clean original; the canvas keeps its
          contents either way, so nothing is lost by toggling. */}
      <div
        ref={canvasElRef}
        className="absolute inset-0"
        style={{ pointerEvents: 'none', zIndex: 50, visibility: showAnnotations ? 'visible' : 'hidden' }}
      />

      {/* Layer 3: transparent mouse-capture overlay, present only when a tool +
          (if needed) color are chosen. It sets the cursor and starts drawing. */}
      {canDraw && (
        <div
          className="absolute inset-0"
          style={{
            zIndex: 60,
            // touch-action:none lets a finger drag draw instead of scrolling/zooming.
            touchAction: 'none',
            // Drawing cursor only while over the slide image; outside it the
            // pointer reverts to normal and clicks are ignored.
            cursor: hoverInImage
              ? (annotationTool === 'eraser' ? ERASER_CURSOR : 'crosshair')
              : 'default',
          }}
          onPointerMove={(e) => setHoverInImage(isInImage(toImagePoint(e.clientX, e.clientY)))}
          onPointerDown={handlePointerDown}
        />
      )}

      {/* Magnification presets + live readout — a microscope's turret.
          Only rendered when the slide carries real calibration, since the
          numbers are meaningless without it. Sits top-left, out of the way of
          the annotation toolbar above and the zoom controls below. */}
      {scaleState && (
        <div className="absolute top-4 left-4 z-[65] flex items-center gap-1 p-1 rounded-xl bg-slate-900/80 backdrop-blur ring-1 ring-slate-700/60 shadow-lg">
          {MAGNIFICATION_PRESETS.map((m) => {
            // Presets above what the scan resolves are digital enlargement,
            // not extra detail — flagged so the reading isn't misleading.
            const beyondScan = nativeMagnification && m > nativeMagnification;
            const active = Math.abs(scaleState.magnification - m) < Math.max(0.5, m * 0.03);
            return (
              <button
                key={m}
                onClick={() => goToMagnification(m)}
                title={beyondScan
                  ? `${m}x — beyond this scan's ${Math.round(nativeMagnification)}x resolution (digital enlargement)`
                  : `View at ${m}x`}
                className={`mono px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition-all ${
                  active
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-300 hover:bg-slate-700/80 hover:text-white'
                } ${beyondScan && !active ? 'opacity-50' : ''}`}
              >
                {m}x
              </button>
            );
          })}
          <div className="w-px h-5 bg-slate-700 mx-1" />
          {/* The honest current value, which is rarely exactly a preset. */}
          <span className="mono text-[11px] font-bold text-indigo-300 pr-2 tabular-nums">
            {scaleState.magnification}x
          </span>
        </div>
      )}

      {/* Micron scale bar. The label is a round number and the bar's width is
          computed from it, so the drawn length is exactly what it claims.
          Sits bottom-LEFT beside the zoom controls: the bottom-right corner is
          taken by the dashboard's floating "Prescription & Info" button, which
          would otherwise cover the bar. */}
      {scaleState && (
        <div className="absolute bottom-5 left-20 z-[65] flex flex-col items-center gap-1 px-3 py-2 rounded-xl bg-slate-900/80 backdrop-blur ring-1 ring-slate-700/60 shadow-lg">
          <span className="mono text-[11px] font-bold text-slate-200 tabular-nums">{scaleState.scaleBar.label}</span>
          {/* End caps make the measured span unambiguous. */}
          <div className="relative h-2 flex items-end" style={{ width: `${scaleState.scaleBar.widthPx}px` }}>
            <div className="absolute left-0 bottom-0 w-px h-2 bg-slate-200" />
            <div className="absolute right-0 bottom-0 w-px h-2 bg-slate-200" />
            <div className="absolute left-0 right-0 bottom-0 h-px bg-slate-200" />
          </div>
        </div>
      )}

      {/* --- Annotation list ---------------------------------------------------
          A mark drawn at 40x is a handful of pixels once the slide is zoomed
          out, so hunting for it by eye is hopeless on a 135,000 px wide scan.
          Listing the marks and flying to them on click is how desktop
          pathology software (QuPath, ASAP) solves the same problem.

          Placed top-right, which is free except in full screen — where the
          exit button sits — so it shifts down there rather than overlapping. */}
      <div className={`absolute ${isFullPage ? 'top-20' : 'top-4'} right-4 z-[70] w-60 max-w-[calc(100%-2rem)]`}>
        <button
          onClick={() => setListOpen((v) => !v)}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-900/80 backdrop-blur text-slate-200 text-xs font-semibold ring-1 ring-slate-700/60 shadow-lg hover:bg-slate-800 hover:text-white transition-all"
        >
          <List className="w-3.5 h-3.5 shrink-0" />
          <span>Annotations</span>
          <span className="ml-auto mono tabular-nums text-indigo-300">{marks.length}</span>
        </button>

        {listOpen && (
          <div className="mt-1.5 rounded-xl bg-slate-900/90 backdrop-blur ring-1 ring-slate-700/60 shadow-lg overflow-hidden">
            {marks.length === 0 ? (
              <p className="px-3 py-3 text-[11px] text-slate-400 leading-relaxed">
                No marks yet. Enable annotation and draw on the slide.
              </p>
            ) : (
              <ul className="max-h-64 overflow-y-auto divide-y divide-slate-800">
                {marks.map((m) => {
                  const Icon = m.kind === 'Rectangle' ? Square : m.kind === 'Oval' ? Circle : PenLine;
                  // Size in microns where the scanner calibrated the slide,
                  // otherwise in pixels — never a guessed measurement.
                  const longest = Math.max(m.box.width, m.box.height);
                  const size = slideInfo?.mppX
                    ? `${Math.round(longest * slideInfo.mppX)} µm`
                    : `${Math.round(longest)} px`;
                  return (
                    <li key={m.index}>
                      <button
                        onClick={() => goToMark(m)}
                        title="Zoom to this annotation"
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-slate-800/80 transition-colors group"
                      >
                        <span className="w-2.5 h-2.5 rounded-full shrink-0 ring-1 ring-white/20" style={{ background: m.color }} />
                        <Icon className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                        <span className="text-[11px] text-slate-200 font-medium">{m.kind}</span>
                        <span className="ml-auto mono text-[10px] text-slate-400 tabular-nums">{size}</span>
                        <Crosshair className="w-3 h-3 text-slate-600 group-hover:text-indigo-300 shrink-0 transition-colors" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Prominent exit affordance while in full screen. */}
      {isFullPage && (
        <button
          onClick={exitFullPage}
          className="absolute top-4 right-4 z-[95] flex items-center gap-2 px-3.5 py-2 rounded-full bg-slate-900/80 backdrop-blur text-slate-200 text-xs font-semibold ring-1 ring-slate-700/60 shadow-lg hover:bg-slate-800 hover:text-white active:scale-95 transition-all"
        >
          <X className="w-4 h-4" />
          <span className="hidden sm:inline">Exit full screen</span>
          <span className="hidden sm:inline text-slate-500 font-normal">Esc</span>
        </button>
      )}

      {/* Custom navigation controls (replace OSD's default sprite buttons).
          SHOWN IN ANNOTATION MODE TOO. These were previously hidden there, on
          the reasoning that pan/zoom was locked anyway — but entering the mode
          also killed scroll-to-zoom, so between the two a pathologist had no
          way whatsoever to change magnification while marking up a slide. The
          wheel is now forwarded to the viewport while drawing (see the wheel
          effect above), so these work throughout, and keeping them mounted
          means the cluster no longer appears and vanishes as the mode toggles.

          They sit at z-65, above the z-60 capture overlay, so a click lands on
          the button rather than starting a stroke. Each entry in the array
          becomes one icon button; we map over them to avoid repeating markup. */}
      <div className="absolute bottom-5 left-5 z-[65] flex flex-col gap-1.5 p-1.5 rounded-2xl bg-slate-900/80 backdrop-blur ring-1 ring-slate-700/60 shadow-lg">
        {[
          { title: 'Zoom in',  Icon: ZoomIn,  onClick: () => { const v = viewerRef.current; if (v) { v.viewport.zoomBy(1.4); v.viewport.applyConstraints(); } } },
          { title: 'Zoom out', Icon: ZoomOut, onClick: () => { const v = viewerRef.current; if (v) { v.viewport.zoomBy(1 / 1.4); v.viewport.applyConstraints(); } } },
          { title: 'Reset view', Icon: Home,  onClick: () => viewerRef.current?.viewport.goHome() },
          {
            title: isFullPage ? 'Exit full screen (Esc)' : 'Full screen',
            Icon: isFullPage ? Minimize : Maximize,
            onClick: () => (isFullPage ? exitFullPage() : enterFullPage()),
          },
        ].map(({ title, Icon, onClick }) => (
          <button
            key={title}
            title={title}
            onClick={onClick}
            className="p-2 rounded-xl text-slate-300 hover:text-white hover:bg-slate-700/80 active:scale-90 transition-all"
          >
            <Icon className="w-4 h-4" />
          </button>
        ))}
      </div>
    </div>
  );
});

// React DevTools display name (forwardRef components are otherwise anonymous).
WsiViewer.displayName = 'WsiViewer';

export default WsiViewer;
