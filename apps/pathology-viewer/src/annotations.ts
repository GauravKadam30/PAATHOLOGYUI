/**
 * annotations.ts — how a pathologist's marks are stored, and how they are
 * flattened into a picture when one is actually needed.
 * ---------------------------------------------------------------------------
 * Annotations are saved as VECTOR SHAPES (fabric.js JSON: "red oval, centre
 * 60000x28000, radius 400"), not as a rendered image. That matters for three
 * reasons:
 *
 *   • Size. A flattened PNG of an annotated whole-slide image ran to ~16 MB
 *     each and was kept inside the database; the same marks as JSON are a few
 *     KB — roughly a thousand times smaller.
 *   • Editability. Baked-in pixels can't be undone. Shapes can be moved,
 *     recoloured or deleted individually, even after saving and reopening.
 *   • Sharpness. A gigapixel slide can't be composited at native size in a
 *     browser, so a stored PNG had to be shrunk to 4096px. Vector marks are
 *     redrawn live over the slide, so they stay crisp at every zoom level.
 *
 * The one thing that still needs a real picture is downloading or previewing
 * a report image — `renderAnnotatedImage` builds that ON DEMAND, so nothing
 * large is ever stored.
 *
 * Coordinates: every shape is stored in IMAGE PIXEL space (the slide's own
 * coordinate system), never screen space. That is what lets a mark stay glued
 * to the same cell at any zoom or pan — see syncViewport in WsiViewer.
 */
import * as FabricModule from 'fabric';
import { API_BASE, authHeaders } from './api';
import type { AnnotationData, Case } from './types';

const fabric = FabricModule;

// Demo slides are filenames served from /public; slides submitted via CHC
// intake are full data-URLs. Use the value directly if it's already a URL,
// otherwise treat it as a file in /public.
export const resolveImageUrl = (image: string | null | undefined): string =>
  /^(data:|https?:|blob:)/.test(image || '') ? (image as string) : `/${image}`;

// A whole-slide case stores its Deep Zoom descriptor as a server path like
// "/slides/105/slide.dzi". That has to be resolved against the BACKEND origin,
// not this app's own — the viewer is served by Vite on a different port, so a
// bare "/slides/..." would ask the wrong server.
export const resolveDziUrl = (dziUrl: string | null | undefined): string =>
  /^https?:/.test(dziUrl || '') ? (dziUrl as string) : `${API_BASE}${dziUrl}`;

// Longest edge of a flattened export, in pixels. A whole slide is far past
// what a canvas can hold (the sample is 135,438 x 57,665 — about 7.8
// gigapixels, where browsers cap out around 2^25 pixels total), so exports of
// those are built from a downscaled overview instead.
export const MAX_EXPORT_DIM = 4096;

/** True if this case has any saved vector marks. */
export const hasAnnotations = (entry: AnnotationData | undefined | null): boolean =>
  !!entry && Array.isArray(entry.objects) && entry.objects.length > 0;

/** A slide's native pixel dimensions. */
export interface SlideSize {
  x: number;
  y: number;
}

// Load an <img>, resolving to null instead of throwing so callers can fall
// back gracefully. `crossOrigin` keeps the export canvas untainted, which is
// what allows toDataURL() to work on tiles served by the backend.
function loadImage(src: string, crossOrigin = false): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const im = new Image();
    if (crossOrigin) im.crossOrigin = 'anonymous';
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = src;
  });
}

/**
 * Load a picture from an endpoint that requires a signed-in account.
 *
 * An <img> tag CANNOT send an Authorization header — there is no API for it —
 * so anything behind auth has to be fetched first and handed to the image as a
 * blob URL. Slide overviews live under /slides/*, which is protected because
 * the tiles are patient data, so this is the only way to composite them.
 *
 * The blob URL is same-origin, which also keeps the export canvas untainted —
 * `toDataURL()` would throw on a canvas that had drawn a cross-origin image.
 */
async function loadAuthedImage(src: string): Promise<HTMLImageElement | null> {
  try {
    const res = await fetch(src, { headers: authHeaders() });
    if (!res.ok) return null;
    const objectUrl = URL.createObjectURL(await res.blob());
    try {
      return await loadImage(objectUrl);
    } finally {
      // Safe here: loadImage resolves on `onload`, so the pixels are decoded.
      URL.revokeObjectURL(objectUrl);
    }
  } catch {
    return null;
  }
}

/**
 * Read a whole slide's native pixel dimensions out of its Deep Zoom
 * descriptor. Needed on the Reports page, where the viewer isn't mounted and
 * so can't report the size itself.
 */
export async function fetchSlideSize(dziUrl: string): Promise<SlideSize | null> {
  try {
    const res = await fetch(resolveDziUrl(dziUrl), { headers: authHeaders() });
    if (!res.ok) return null;
    const xml = await res.text();
    const w = /Width="(\d+)"/.exec(xml);
    const h = /Height="(\d+)"/.exec(xml);
    // `noUncheckedIndexedAccess` means capture groups are possibly undefined,
    // so both are checked before use rather than assumed present.
    return w?.[1] && h?.[1] ? { x: Number(w[1]), y: Number(h[1]) } : null;
  } catch {
    return null;
  }
}

/**
 * Flatten saved vector marks onto the slide and return a PNG data-URL.
 *
 * Works WITHOUT the live viewer being mounted, so the Reports page can build
 * a preview or download on demand. Returns null if there's nothing to render.
 *
 * @param caseData       the case ({ image } and/or { dziUrl })
 * @param annotationJSON fabric canvas JSON, in image coordinates
 * @param slideWidth     native slide width, if already known
 * @param slideHeight    native slide height, if already known
 */
export async function renderAnnotatedImage(
  caseData: Case | null | undefined,
  annotationJSON: AnnotationData | null,
  slideWidth?: number,
  slideHeight?: number,
): Promise<string | null> {
  if (!caseData) return null;

  let img: HTMLImageElement | null = null;
  let W = 0;
  let H = 0;
  let markScale = 1;   // shrink factor applied to the marks, see below

  if (caseData.dziUrl) {
    // Whole-slide case: ask the tile service for a downscaled render of the
    // entire slide. The Deep Zoom pyramid already holds these levels, so this
    // is a cheap read rather than a resize of the full image.
    if (!slideWidth || !slideHeight) {
      const size = await fetchSlideSize(caseData.dziUrl);
      if (!size) return null;
      slideWidth = size.x;
      slideHeight = size.y;
    }
    markScale = Math.min(1, MAX_EXPORT_DIM / Math.max(slideWidth, slideHeight));
    W = Math.round(slideWidth * markScale);
    H = Math.round(slideHeight * markScale);
    const base = resolveDziUrl(caseData.dziUrl).replace(/slide\.dzi$/, '');
    img = await loadAuthedImage(`${base}overview.jpeg?w=${W}&h=${H}`);
  } else if (caseData.image) {
    // Ordinary photo case: composite at the image's own full resolution.
    img = await loadImage(resolveImageUrl(caseData.image));
    if (img) { W = img.naturalWidth; H = img.naturalHeight; }
  }
  if (!img || !W || !H) return null;

  // Draw the marks onto an off-screen canvas the size of the export. A fresh
  // StaticCanvas starts with the identity transform, so each shape lands at
  // its stored image-pixel position; `markScale` (1 for ordinary photos)
  // shrinks them by the same factor as a downscaled whole-slide export.
  const layer = new fabric.StaticCanvas(undefined, { width: W, height: H, enableRetinaScaling: false });
  if (annotationJSON) {
    await layer.loadFromJSON(annotationJSON);
    // Set the transform AFTER loading — loadFromJSON resets it.
    if (markScale !== 1) layer.setViewportTransform([markScale, 0, 0, markScale, 0, 0]);
    layer.renderAll();
  }

  // Composite: the slide first, the marks on top.
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const ctx = out.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, W, H);
  ctx.drawImage(layer.lowerCanvasEl, 0, 0, W, H);
  layer.dispose();

  return out.toDataURL('image/png');
}

// --- Listing marks for the annotation panel -----------------------------------

/** One saved mark, summarised for the annotation list. */
export interface AnnotationSummary {
  /** Position in the saved objects array — also its label in the list. */
  index: number;
  /** Freehand / Rectangle / Oval, for the row's icon and wording. */
  kind: 'Freehand' | 'Rectangle' | 'Oval' | 'Shape';
  /** The colour it was drawn in, so the row can show a matching swatch. */
  color: string;
  /** Bounding box in IMAGE pixels, always top-left origin. */
  box: { left: number; top: number; width: number; height: number };
}

/**
 * Summarise saved marks so they can be listed and jumped to.
 *
 * WHY THIS EXISTS: marks are stored in image coordinates, so a mark drawn at
 * 20x is only a few screen pixels once the whole slide is in view — on a
 * 135,000 px wide scan a 100 µm lesion is about 3 px. Zoomed out, they are
 * effectively impossible to find by eye, which makes reviewing a case a hunt.
 * A list you can click turns that into one action.
 *
 * The box is computed from the raw JSON rather than by rebuilding fabric
 * objects, which would mean instantiating a canvas just to read coordinates.
 * Each shape is handled explicitly because fabric records them differently:
 * a Path carries its point list, an Ellipse carries radii, a Rect carries a
 * size — and their origins differ too (the Rect and Oval tools anchor at the
 * top-left, while a Path uses fabric's centre default). Reading the geometry
 * directly sidesteps all of that.
 */
export function listAnnotations(data: AnnotationData | null | undefined): AnnotationSummary[] {
  const objects = (data as { objects?: unknown[] } | null | undefined)?.objects;
  if (!Array.isArray(objects)) return [];

  const out: AnnotationSummary[] = [];
  objects.forEach((raw, index) => {
    const o = raw as Record<string, any>;
    const scaleX = Number(o.scaleX ?? 1) || 1;
    const scaleY = Number(o.scaleY ?? 1) || 1;
    let box: AnnotationSummary['box'] | null = null;
    let kind: AnnotationSummary['kind'] = 'Shape';

    // Classify by fabric's own `type`, NOT by which properties are present:
    // a Rect also carries rx/ry (its CORNER RADIUS, 0 for square corners), so
    // testing for rx first silently read every rectangle as a zero-size oval
    // and dropped it from the list.
    const type = String(o.type ?? '').toLowerCase();

    if (type === 'path' || (!type && Array.isArray(o.path))) {
      // Freehand: ["M", x, y], ["L", x, y], … — take the extents of the points.
      kind = 'Freehand';
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const seg of o.path as unknown[]) {
        if (!Array.isArray(seg)) continue;
        for (let i = 1; i + 1 < seg.length; i += 2) {
          const x = Number(seg[i]), y = Number(seg[i + 1]);
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
      if (Number.isFinite(minX)) box = { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
    } else if (type === 'ellipse' || type === 'circle') {
      // Oval: left/top are the top-left corner (the tool sets originX/Y).
      kind = 'Oval';
      box = {
        left: Number(o.left ?? 0), top: Number(o.top ?? 0),
        width: Number(o.rx ?? 0) * 2 * scaleX, height: Number(o.ry ?? 0) * 2 * scaleY,
      };
    } else if (o.width != null && o.height != null) {   // Rect and anything boxy
      kind = 'Rectangle';
      box = {
        left: Number(o.left ?? 0), top: Number(o.top ?? 0),
        width: Number(o.width) * scaleX, height: Number(o.height) * scaleY,
      };
    }

    // A zero-area mark (a stray click) is not worth a row in the list.
    if (!box || !Number.isFinite(box.left) || (box.width < 1 && box.height < 1)) return;
    out.push({ index, kind, color: String(o.stroke || '#000000'), box });
  });
  return out;
}
