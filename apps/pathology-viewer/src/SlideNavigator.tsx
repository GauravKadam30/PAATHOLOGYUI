/**
 * SlideNavigator — the overview "minimap" in the corner of the slide viewer.
 * ---------------------------------------------------------------------------
 * A whole slide is tens of thousands of pixels across, and at 40x the screen
 * shows a sliver of it with nothing to say where that sliver sits. This panel
 * shows the entire slide small, with a box marking the part in the main view:
 *
 *   • the box follows every pan and zoom, shrinking as the view zooms in
 *   • dragging the box moves the main view with it
 *   • pressing anywhere else on the overview glides the view there
 *
 * It is always shown — there is no control to fold it away.
 *
 * WHY NOT OPENSEADRAGON'S BUILT-IN NAVIGATOR. It moves its element into the
 * viewer's own DOM, out from under React and beneath the annotation layer, so
 * it could neither sit with the other controls nor be used mid-annotation.
 *
 * THE PICTURE is painted from the slide's own low-resolution Deep Zoom tiles —
 * the same pyramid the main view reads — rather than the tile service's
 * overview image, so the two always agree about where the slide's edges are,
 * including on formats whose scans are cropped to the tissue.
 *
 * The box is positioned by writing its style directly, not through React
 * state: OpenSeadragon reports the viewport every animation frame, and a
 * re-render for each would be wasted work.
 */
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import OpenSeadragon from 'openseadragon';
import { resolveImageUrl } from './annotations';
import { authHeaders } from './api';
import type { Case } from './types';

/** Largest the overview is drawn, in CSS pixels. A wide slide meets the width
 *  first and a tall one the height, so neither shape crowds the viewer. */
const MAX_WIDTH = 220;
const MAX_HEIGHT = 150;
/** Smallest the box is drawn. At 40x on a 135,000 px scan the true box is about
 *  two pixels across — accurate, but impossible to find or take hold of. */
const MIN_BOX_PX = 10;

// The events used below are all real OpenSeadragon events, but its typings
// model the event map as a closed union — the same narrow cast WsiViewer uses.
type ViewerEvent = Parameters<OpenSeadragon.Viewer['addHandler']>[0];

/** The slide's size in image pixels, and the size its overview is drawn at. */
interface Layout {
  imageWidth: number;
  imageHeight: number;
  width: number;
  height: number;
}

/** A rectangle in overview pixels. */
interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface SlideNavigatorProps {
  viewer: OpenSeadragon.Viewer;
  caseData: Case;
  /** Positioning classes — the viewer owns the layout of its corners. */
  className?: string;
}

export default function SlideNavigator({ viewer, caseData, className = '' }: SlideNavigatorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  // The main view as it truly is, unclipped. Dragging steers its centre.
  const viewRef = useRef<Box | null>(null);
  // The box as drawn — clipped to the overview and never below MIN_BOX_PX.
  // This is what counts as "pressing on the box".
  const drawnRef = useRef<Box | null>(null);
  // Where inside the box it was taken hold of, so it doesn't jump to centre
  // itself under the pointer.
  const dragRef = useRef<{ offsetX: number; offsetY: number } | null>(null);

  const [layout, setLayout] = useState<Layout | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pictureFailed, setPictureFailed] = useState(false);

  // --- Size the overview to the slide's shape once it opens ----------------
  useEffect(() => {
    setLayout(null);
    const measure = () => {
      const item = viewer.world?.getItemAt(0);
      if (!item) return;
      const { x: imageWidth, y: imageHeight } = item.getContentSize();
      if (!imageWidth || !imageHeight) return;
      const aspect = imageWidth / imageHeight;
      let width = MAX_WIDTH;
      let height = width / aspect;
      if (height > MAX_HEIGHT) {
        height = MAX_HEIGHT;
        width = height * aspect;
      }
      setLayout({
        imageWidth, imageHeight,
        width: Math.max(1, Math.round(width)),
        height: Math.max(1, Math.round(height)),
      });
    };
    // The slide may already be open by the time this runs, or still loading.
    if (viewer.world?.getItemCount()) measure();
    viewer.addHandler('open', measure);
    return () => { viewer.removeHandler('open', measure); };
  }, [viewer]);

  // --- Keep the box on the part of the slide in view -----------------------
  useEffect(() => {
    if (!layout) return;

    const update = () => {
      const item = viewer.world?.getItemAt(0);
      const box = boxRef.current;
      if (!item || !box || !viewer.viewport) return;
      // `true`: where the view is on this animation frame, not where it is heading.
      const r = item.viewportToImageRectangle(viewer.viewport.getBounds(true));
      const sx = layout.width / layout.imageWidth;
      const sy = layout.height / layout.imageHeight;
      const view = { left: r.x * sx, top: r.y * sy, width: r.width * sx, height: r.height * sy };
      viewRef.current = view;

      // Zoomed out past the slide's edges the view is bigger than the whole
      // overview, so clip the box to the picture.
      const left = Math.max(0, view.left);
      const top = Math.max(0, view.top);
      const right = Math.min(layout.width, view.left + view.width);
      const bottom = Math.min(layout.height, view.top + view.height);
      if (right <= left || bottom <= top) {        // panned right off the slide
        box.style.display = 'none';
        drawnRef.current = null;
        return;
      }

      const width = Math.max(right - left, MIN_BOX_PX);
      const height = Math.max(bottom - top, MIN_BOX_PX);
      const drawn = {
        left: Math.min(Math.max((left + right - width) / 2, 0), layout.width - width),
        top: Math.min(Math.max((top + bottom - height) / 2, 0), layout.height - height),
        width,
        height,
      };
      drawnRef.current = drawn;
      box.style.display = 'block';
      box.style.transform = `translate(${drawn.left}px, ${drawn.top}px)`;
      box.style.width = `${width}px`;
      box.style.height = `${height}px`;
    };

    update();
    // 'update-viewport' fires on every frame the view moves; 'resize' covers
    // full screen and the annotation toolbar changing the viewer's size.
    const events = ['update-viewport', 'animation', 'resize', 'open'] as const;
    events.forEach((e) => viewer.addHandler(e as ViewerEvent, update));
    return () => events.forEach((e) => viewer.removeHandler(e as ViewerEvent, update));
  }, [viewer, layout]);

  // --- Paint the picture from the slide's own low-resolution tiles ---------
  useEffect(() => {
    setPictureFailed(false);
    if (!layout || !caseData.dziUrl) return;
    const item = viewer.world?.getItemAt(0);
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!item || !canvas || !ctx) return;
    const source = item.source;

    // The smallest pyramid level at least twice the overview's size: sharp on
    // a high-density screen, yet only a handful of tiles to fetch.
    const longest = Math.max(source.dimensions.x, source.dimensions.y);
    const wanted = Math.max(layout.width, layout.height) * 2;
    let level = source.minLevel;
    while (level < source.maxLevel && longest * source.getLevelScale(level) < wanted) level++;

    const levelWidth = source.dimensions.x * source.getLevelScale(level);
    const levelHeight = source.dimensions.y * source.getLevelScale(level);
    canvas.width = Math.ceil(levelWidth);
    canvas.height = Math.ceil(levelHeight);

    let cancelled = false;
    const tiles = source.getNumTiles(level);
    const jobs: Promise<void>[] = [];
    for (let x = 0; x < tiles.x; x++) {
      for (let y = 0; y < tiles.y; y++) {
        const url = source.getTileUrl(level, x, y);
        // Tile bounds come back as fractions of the level's WIDTH, on both axes.
        const at = source.getTileBounds(level, x, y);
        jobs.push((async () => {
          // Signed in like every other slide request: tiles are patient data.
          // The URL carries the slide's version, so these are the very tiles
          // the main view has already cached.
          const res = await fetch(typeof url === 'function' ? url() : url, { headers: authHeaders() });
          if (!res.ok) throw new Error(`tile ${res.status}`);
          const bitmap = await createImageBitmap(await res.blob());
          if (!cancelled) ctx.drawImage(bitmap, Math.round(at.x * levelWidth), Math.round(at.y * levelWidth));
          bitmap.close();
        })());
      }
    }
    void Promise.allSettled(jobs).then((results) => {
      if (!cancelled && results.every((r) => r.status === 'rejected')) setPictureFailed(true);
    });
    return () => { cancelled = true; };
  }, [viewer, layout, caseData.dziUrl]);

  // --- Steering the main view from the overview ----------------------------
  const pointInOverview = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  /** Centre the main view on a point of the overview, kept within the slide. */
  const centreOn = (x: number, y: number, immediately: boolean) => {
    const item = viewer.world?.getItemAt(0);
    if (!item || !layout || !viewer.viewport) return;
    const cx = Math.min(Math.max(x, 0), layout.width);
    const cy = Math.min(Math.max(y, 0), layout.height);
    viewer.viewport.panTo(item.imageToViewportCoordinates(new OpenSeadragon.Point(
      (cx / layout.width) * layout.imageWidth,
      (cy / layout.height) * layout.imageHeight,
    )), immediately);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const p = pointInOverview(e);
    const drawn = drawnRef.current;
    const view = viewRef.current;
    const onBox = !!drawn && !!view
      && p.x >= drawn.left && p.x <= drawn.left + drawn.width
      && p.y >= drawn.top && p.y <= drawn.top + drawn.height;

    if (onBox && view) {
      dragRef.current = {
        offsetX: p.x - (view.left + view.width / 2),
        offsetY: p.y - (view.top + view.height / 2),
      };
    } else {
      dragRef.current = { offsetX: 0, offsetY: 0 };
      centreOn(p.x, p.y, false);                   // glide there
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const p = pointInOverview(e);
    // Immediate, so the slide moves with the hand rather than trailing behind.
    centreOn(p.x - drag.offsetX, p.y - drag.offsetY, true);
  };

  const endDrag = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    // Settle within the viewer's usual limits, as its own drags do on release.
    viewer.viewport?.applyConstraints();
  };

  if (!layout) return null;

  return (
    <div className={`${className} p-1.5 rounded-2xl bg-slate-900/80 backdrop-blur ring-1 ring-slate-700/60 shadow-lg select-none`}>
      <div
        title="Drag the box, or click anywhere, to move around the slide"
        aria-label="Slide overview"
        className={`relative overflow-hidden rounded-lg bg-slate-950 ring-1 ring-slate-800 ${dragging ? 'cursor-grabbing' : 'cursor-pointer'}`}
        style={{ width: layout.width, height: layout.height, touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      >
        {caseData.dziUrl ? (
          <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
        ) : caseData.image ? (
          <img src={resolveImageUrl(caseData.image)} alt="" draggable={false} className="absolute inset-0 w-full h-full" />
        ) : null}
        {pictureFailed && (
          <span className="absolute inset-0 flex items-center justify-center text-[10px] text-slate-500">
            Overview unavailable
          </span>
        )}
        {/* Hidden until the first position arrives. Its geometry is written
            by the effect above, never by React, so a re-render leaves it be. */}
        <div
          ref={boxRef}
          className={`absolute left-0 top-0 rounded-[3px] border-2 border-indigo-400 bg-indigo-400/15 shadow-[0_0_0_1px_rgba(2,6,23,0.6)] ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
          style={{ display: 'none', willChange: 'transform' }}
        />
      </div>
    </div>
  );
}
