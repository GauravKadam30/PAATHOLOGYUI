/**
 * annotations.js — how a pathologist's marks are stored, and how they are
 * flattened into a picture when one is actually needed.
 * ---------------------------------------------------------------------------
 * Annotations are saved as VECTOR SHAPES (fabric.js JSON: "red oval, centre
 * 60000x25000, radius 400"), not as a rendered image. That matters for three
 * reasons:
 *
 *   • Size. A flattened PNG of an annotated whole-slide image ran to ~16 MB
 *     each and was kept inside SQLite; the same marks as JSON are a few KB —
 *     roughly a thousand times smaller.
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
 * to the same cell at any zoom or pan — see syncViewport in WsiViewer.jsx.
 */
import * as FabricModule from 'fabric';
import { API_BASE } from './api';

const fabric = FabricModule;

// Demo slides are filenames served from /public; slides submitted via CHC
// intake are full data-URLs. Use the value directly if it's already a URL,
// otherwise treat it as a file in /public.
export const resolveImageUrl = (image) =>
  /^(data:|https?:|blob:)/.test(image || '') ? image : `/${image}`;

// A whole-slide case stores its Deep Zoom descriptor as a server path like
// "/slides/105/slide.dzi". That has to be resolved against the BACKEND origin,
// not this app's own — the viewer is served by Vite on a different port, so a
// bare "/slides/..." would ask the wrong server.
export const resolveDziUrl = (dziUrl) =>
  /^https?:/.test(dziUrl || '') ? dziUrl : `${API_BASE}${dziUrl}`;

// Longest edge of a flattened export, in pixels. A whole slide is far past
// what a canvas can hold (the sample is 135,438 x 57,665 — about 7.8
// gigapixels, where browsers cap out around 2^25 pixels total), so exports of
// those are built from a downscaled overview instead.
export const MAX_EXPORT_DIM = 4096;

// True if this case has any saved vector marks.
export const hasAnnotations = (entry) =>
  !!entry && Array.isArray(entry.objects) && entry.objects.length > 0;

// Load an <img>, resolving to null instead of throwing so callers can fall
// back gracefully. `crossOrigin` keeps the export canvas untainted, which is
// what allows toDataURL() to work on tiles served by the backend.
function loadImage(src, crossOrigin = false) {
  return new Promise((resolve) => {
    const im = new Image();
    if (crossOrigin) im.crossOrigin = 'anonymous';
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = src;
  });
}

// Read a whole slide's native pixel dimensions out of its Deep Zoom
// descriptor. Needed on the Reports page, where the viewer isn't mounted and
// so can't report the size itself.
export async function fetchSlideSize(dziUrl) {
  try {
    const res = await fetch(resolveDziUrl(dziUrl));
    if (!res.ok) return null;
    const xml = await res.text();
    const w = /Width="(\d+)"/.exec(xml);
    const h = /Height="(\d+)"/.exec(xml);
    return w && h ? { x: Number(w[1]), y: Number(h[1]) } : null;
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
 * @param {object}  caseData        the case ({ image } and/or { dziUrl })
 * @param {object}  annotationJSON  fabric canvas JSON, in image coordinates
 * @param {number}  slideWidth      native slide width, if already known
 * @param {number}  slideHeight     native slide height, if already known
 */
export async function renderAnnotatedImage(caseData, annotationJSON, slideWidth, slideHeight) {
  if (!caseData) return null;

  let img = null;
  let W, H;
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
    img = await loadImage(`${base}overview.jpeg?w=${W}&h=${H}`, true);
  } else if (caseData.image) {
    // Ordinary photo case: composite at the image's own full resolution.
    img = await loadImage(resolveImageUrl(caseData.image));
    if (img) { W = img.naturalWidth; H = img.naturalHeight; }
  }
  if (!img) return null;

  // Draw the marks onto an off-screen canvas the size of the export. A fresh
  // StaticCanvas starts with the identity transform, so each shape lands at
  // its stored image-pixel position; `markScale` (1 for ordinary photos)
  // shrinks them by the same factor as a downscaled whole-slide export.
  const layer = new fabric.StaticCanvas(null, { width: W, height: H, enableRetinaScaling: false });
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
  ctx.drawImage(img, 0, 0, W, H);
  ctx.drawImage(layer.lowerCanvasEl, 0, 0, W, H);
  layer.dispose();

  return out.toDataURL('image/png');
}
