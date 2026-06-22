/**
 * WsiViewer — the whole-slide-image (WSI) viewer with annotation tools.
 * ---------------------------------------------------------------------------
 * It stacks THREE layers inside one box:
 *   1. OpenSeadragon canvas  — the deep-zoom pathology slide (bottom).
 *   2. Fabric.js canvas      — the user's drawings (middle); only shown while
 *                              annotating, so the original slide stays clean.
 *   3. A transparent overlay — captures the mouse only while drawing (top).
 *
 * Key idea: annotations are stored in IMAGE pixel coordinates (not screen
 * coordinates). On every pan/zoom we re-project them onto the screen via
 * `syncViewport`, so a circle drawn on a cell stays glued to that cell when
 * you zoom in or out.
 *
 * The parent (TelepathologyDashboard) talks to this component through a ref:
 * it can `save()` (get a composited PNG of slide+drawings), `discard()`
 * (roll back), and `exportPNG()` (download). See `useImperativeHandle` below.
 */
import React, { useEffect, useRef, useState, forwardRef, useImperativeHandle, useCallback } from 'react';
import OpenSeadragon from 'openseadragon';                 // deep-zoom slide viewer
import * as FabricModule from 'fabric';                    // 2D canvas drawing library
import { ZoomIn, ZoomOut, Home, Maximize, Minimize, X } from 'lucide-react'; // control icons

// fabric v7 has no named `fabric` export, so we use the whole module namespace.
const fabric = FabricModule;

// Demo slides are filenames served from /public; slides submitted via CHC intake
// are full data-URLs. Use the value directly if it's already a URL, else prefix "/".
const resolveImageUrl = (image) =>
  /^(data:|https?:|blob:)/.test(image || '') ? image : `/${image}`;

// A custom mouse cursor shaped like an eraser, built from an inline SVG encoded
// as a data-URI (no separate image file needed). The trailing "1 15" is the
// cursor hotspot — the active pixel sits at the eraser's lower-left tip so you
// erase exactly where the icon touches. "cell" is the fallback if the SVG fails.
const ERASER_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="white" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>'
)}") 1 15, cell`;

// `forwardRef` lets the parent hold a handle to this component so it can call
// save()/discard()/exportPNG() (wired up via useImperativeHandle further down).
const WsiViewer = forwardRef(({ caseData, annotationMode, annotationColor, annotationTool }, ref) => {
  // --- Refs hold long-lived objects/DOM nodes that must survive re-renders ---
  const viewerRef = useRef(null);       // the OpenSeadragon viewer instance
  const containerRef = useRef(null);    // the <div> OpenSeadragon renders into
  const canvasElRef = useRef(null);     // wrapper <div> that holds the fabric canvas
  const fabricRef = useRef(null);       // the fabric.Canvas instance
  const imgSizeRef = useRef(null);      // natural image size {x, y} in image px
  const baselineRef = useRef(null);     // canvas JSON snapshot taken when annotation mode was enabled (for "Don't save")

  // --- State that, when changed, should re-render the component ---
  const [isReady, setIsReady] = useState(false);          // gate: only build the viewer after first render
  const [hoverInImage, setHoverInImage] = useState(false); // is the cursor currently over the slide image?
  const [isFullPage, setIsFullPage] = useState(false);     // is the viewer in our custom full-screen mode?

  // Drawing is allowed once the user has picked a tool, plus a color for the
  // drawing tools — the eraser doesn't need one.
  const canDraw = annotationMode && !!annotationTool &&
    (annotationTool === 'eraser' || !!annotationColor);

  // Flip `isReady` true once, right after the first render, so the effects below
  // run only when the container <div>s already exist in the DOM.
  useEffect(() => { setIsReady(true); }, []);

  // Keeps the fabric canvas aligned with the slide: annotations live in image
  // pixel coordinates, and this maps them to the screen on every pan/zoom so
  // saved shapes stick to the tissue they were drawn on.
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
    if (!isReady || !caseData?.image || !containerRef.current) return;

    // Tear down any previous viewer before creating a new one (patient switch).
    if (viewerRef.current) {
      viewerRef.current.destroy();
      viewerRef.current = null;
    }

    const viewer = OpenSeadragon({
      element: containerRef.current,
      tileSources: { type: 'image', url: resolveImageUrl(caseData.image) }, // the JPG in /public
      animationTime: 0.5,   // seconds for zoom/pan spring animation
      blendTime: 0.1,       // seconds for image tiles to fade in
      // The default sprite-image buttons are replaced by our own styled
      // controls rendered in JSX below.
      showNavigationControl: false,
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

    // Note: we intentionally do NOT restore previous annotations here — each
    // annotation session starts on the clean original slide. The previously
    // saved annotated image is kept separately by the parent.

    return () => {
      window.removeEventListener('resize', resize);
      fabricRef.current = null;
      // dispose() is async in fabric v6+; remove only this instance's holder
      // so a newly mounted canvas isn't wiped out by a late cleanup.
      Promise.resolve(canvas.dispose()).finally(() => holder.remove());
    };
  }, [isReady, caseData, syncViewport]);

  // --- React to annotation mode turning on/off ---
  useEffect(() => {
    if (!viewerRef.current) return;
    // While drawing, disable OSD's own mouse pan/zoom so dragging draws instead.
    viewerRef.current.setMouseNavEnabled(!annotationMode);
    viewerRef.current.innerTracker.setTracking(!annotationMode);
    // Each new session starts on a fresh, clean slide: wipe any leftover
    // shapes from a previous session, then snapshot that blank canvas as the
    // baseline so "Don't save" rolls back to nothing.
    if (annotationMode && fabricRef.current) {
      fabricRef.current.clear();
      baselineRef.current = fabricRef.current.toJSON();
    }
  }, [annotationMode]);

  // --- Custom full-screen ("full page") mode ---
  // OSD's built-in setFullPage moves only its own div onto the bare (white) page
  // body, leaving our annotation layer and controls behind. Instead we expand
  // the WHOLE viewer block on a dark background. We also push a history entry so
  // the browser/phone Back button exits full screen instead of leaving the app;
  // Escape works too.
  const enterFullPage = () => {
    setIsFullPage(true);
    window.history.pushState({ wsiFullPage: true }, '');
  };
  const exitFullPage = useCallback(() => {
    // If we added a history entry, go back (which fires popstate -> exit);
    // otherwise just flip the flag directly.
    if (window.history.state?.wsiFullPage) window.history.back();
    else setIsFullPage(false);
  }, []);

  // While in full screen, listen for the Back button (popstate) and Escape key.
  useEffect(() => {
    if (!isFullPage) return;
    const onPop = () => setIsFullPage(false);
    const onKey = (e) => { if (e.key === 'Escape') exitFullPage(); };
    window.addEventListener('popstate', onPop);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('keydown', onKey);
    };
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

  // Builds a BRAND-NEW, full-resolution image: the ORIGINAL slide at its native
  // pixel size with the annotations drawn on top — NOT a screenshot of whatever
  // is on screen at the current zoom. Annotations live in image coordinates, so
  // they map 1:1 onto the full image. Async because it loads the original at
  // native resolution and clones the marks onto an off-screen canvas.
  const compositeAnnotatedImage = useCallback(async () => {
    const canvas = fabricRef.current;
    if (!canvas || !caseData?.image) return null;

    // Load the original slide at native resolution. It's served from /public
    // (same-origin), so the export canvas won't be tainted and toDataURL works.
    const img = await new Promise((resolve) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => resolve(null);
      im.src = resolveImageUrl(caseData.image);
    });
    if (!img) return null;
    const W = img.naturalWidth, H = img.naturalHeight;

    // Render the marks at native scale: a fresh StaticCanvas has the default
    // identity transform, so each mark sits at its image-pixel position.
    const layer = new fabric.StaticCanvas(null, { width: W, height: H, enableRetinaScaling: false });
    for (const o of canvas.getObjects()) {
      layer.add(await o.clone());
    }
    layer.renderAll();

    // Composite onto a new canvas: original slide first, annotations on top.
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const ctx = out.getContext('2d');
    ctx.drawImage(img, 0, 0, W, H);
    ctx.drawImage(layer.lowerCanvasEl, 0, 0, W, H);
    layer.dispose();

    return out.toDataURL('image/png');
  }, [caseData]);

  // Expose a small API to the parent via its ref.
  useImperativeHandle(ref, () => ({
    // Returns the new full-resolution annotated image (a fresh artifact). The
    // live slide is never altered, and the canvas is wiped at the start of the
    // next session for a clean original.
    save: () => compositeAnnotatedImage(),
    // "Don't save": reload the blank baseline snapshot, discarding this session.
    discard: async () => {
      const canvas = fabricRef.current;
      if (canvas && baselineRef.current) {
        await canvas.loadFromJSON(baselineRef.current);
        syncViewport();
        canvas.renderAll();
      }
    },
    exportPNG: compositeAnnotatedImage,   // same full-res image, for the Download button
  }), [caseData, syncViewport, compositeAnnotatedImage]);

  // Convert a screen (mouse) position into IMAGE pixel coordinates by running it
  // through the INVERSE of the current viewport transform.
  const toImagePoint = (clientX, clientY) => {
    const canvas = fabricRef.current;
    const rect = containerRef.current.getBoundingClientRect();
    const inv = fabric.util.invertTransform(canvas.viewportTransform);
    return fabric.util.transformPoint(new fabric.Point(clientX - rect.left, clientY - rect.top), inv);
  };

  // True only if an image-space point lies within the slide's bounds — this is
  // what restricts annotation to the slide itself.
  const isInImage = (pt) => {
    const s = imgSizeRef.current;
    return !!s && pt.x >= 0 && pt.y >= 0 && pt.x <= s.x && pt.y <= s.y;
  };

  // Pointer-down on the drawing overlay: begins a shape/stroke (or erases) for
  // the active tool. Pointer Events cover mouse, touch (phone) and pen alike.
  const handlePointerDown = (e) => {
    const canvas = fabricRef.current;
    if (!canvas || !canDraw) return;
    e.preventDefault();

    // One-stroke eraser: tap or drag over a mark to delete that whole mark.
    // The pointer and each mark's bounding box are both compared in IMAGE
    // (scene) coordinates, so it works at any zoom; the topmost mark wins.
    if (annotationTool === 'eraser') {
      const eraseAt = (ev) => {
        const pt = toImagePoint(ev.clientX, ev.clientY);
        const objs = canvas.getObjects();
        for (let i = objs.length - 1; i >= 0; i--) {
          const o = objs[i];
          o.setCoords();
          const r = o.getBoundingRect();
          const pad = (o.strokeWidth || 2);
          if (pt.x >= r.left - pad && pt.x <= r.left + r.width + pad &&
              pt.y >= r.top - pad && pt.y <= r.top + r.height + pad) {
            canvas.remove(o);
            canvas.renderAll();
            return;
          }
        }
      };
      eraseAt(e.nativeEvent || e);
      const onMove = (ev) => eraseAt(ev);
      const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      return;
    }

    // Drawing tools only act on the slide image itself.
    const start = toImagePoint(e.clientX, e.clientY);
    if (!isInImage(start)) return;
    const color = annotationColor;
    // Stroke widths are in image px so they scale with zoom along with the
    // shape; divide by current scale so they appear ~3px (18px eraser) now.
    const scale = canvas.viewportTransform[0] || 1;
    const strokeW = 3 / scale;

    // Convert a move event to an image point, clamped to the slide's edges so a
    // drag that wanders off the image doesn't draw outside it.
    const clampMove = (ev) => {
      const p = toImagePoint(ev.clientX, ev.clientY);
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

      const onMove = (ev) => {
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

      const onMove = (ev) => {
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
      let pathObj = null;

      const onMove = (ev) => {
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
    <div className={isFullPage
      ? 'fixed inset-0 z-[90] bg-slate-950'
      : 'w-full h-full bg-slate-900 relative'}>
      {/* Layer 1: OpenSeadragon renders the slide into this div. */}
      <div ref={containerRef} className="w-full h-full absolute inset-0" />

      {/* Layer 2: fabric annotation canvas. Shown only while annotating so the
          original slide stays clean afterwards — the saved annotated image is
          kept separately by the parent (it never modifies the live slide). The
          canvas keeps its pixels while hidden, so compositing on save works. */}
      <div
        ref={canvasElRef}
        className="absolute inset-0"
        style={{ pointerEvents: 'none', zIndex: 50, visibility: annotationMode ? 'visible' : 'hidden' }}
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
          Hidden during annotation, when pan/zoom is locked anyway. Each entry
          in the array becomes one icon button; we map over them to avoid repeating markup. */}
      {!annotationMode && (
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
      )}
    </div>
  );
});

// React DevTools display name (forwardRef components are otherwise anonymous).
WsiViewer.displayName = 'WsiViewer';

export default WsiViewer;
