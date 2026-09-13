"""
tile_server.py — serves whole-slide images as Deep Zoom tiles, on demand.

Started automatically as a child process by the Node backend (see server.js)
and only ever listens on 127.0.0.1, so it is not reachable from outside this
machine — Node proxies the public /slides/* routes to it.

WHY ON DEMAND, rather than converting each upload into a tile folder up front:
a real scanner slide (the development sample is 135,438 x 57,665 px) expands
to ~162,000 tiles, which measured at roughly 20 minutes of conversion and
~2.2 GB of extra disk PER SLIDE. Reading tiles straight from the original
file as the viewer asks for them costs neither: the slide is viewable the
instant it finishes uploading, and the only disk used is the file itself.
OpenSlide is built for exactly this random-access pattern.

Routes (caseId is the numeric case id; slides live in <uploads>/<caseId>/):
    GET /slides/<caseId>/slide.dzi                       -> Deep Zoom descriptor XML
    GET /slides/<caseId>/slide_files/<level>/<c>_<r>.jpeg -> one tile
    GET /health                                           -> {"ok": true}
    DELETE /slides/<caseId>                               -> close that slide (Node calls
                                                             this after removing its files)

Usage:
    python tile_server.py <uploads-dir> [port]
"""
import io
import json
import os
import re
import sys
import threading
import time
from collections import OrderedDict
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

import openslide
from openslide.deepzoom import DeepZoomGenerator

TILE_SIZE = 254          # +1px overlap each side = 256px tiles (Deep Zoom convention)
OVERLAP = 1
JPEG_QUALITY = 80
MAX_OPEN_SLIDES = 4      # keep a few slides warm; each holds an OS file handle

UPLOADS_DIR = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.abspath("uploads")
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 3002

DZI_RE = re.compile(r"^/slides/(\d+)/slide\.dzi$")
TILE_RE = re.compile(r"^/slides/(\d+)/slide_files/(\d+)/(\d+)_(\d+)\.jpeg$")
OVERVIEW_RE = re.compile(r"^/slides/(\d+)/overview\.jpeg")
INFO_RE = re.compile(r"^/slides/(\d+)/info\.json$")
RELEASE_RE = re.compile(r"^/slides/(\d+)$")
MAX_OVERVIEW_DIM = 8192   # ceiling on a requested overview, to bound memory use
REAP_INTERVAL_S = 60      # how often to close slides whose file has gone

# --- Slide cache -------------------------------------------------------------
# Opening a slide is comparatively expensive, so keep the most recently used
# ones open. OpenSlide's handle is NOT safe for concurrent reads, so every
# entry carries its own lock and readers serialise per slide (different
# slides still serve in parallel).
#
# An open slide is a held file, and that has two consequences once the file is
# removed underneath the cache. Linux does not give a deleted file's space back
# while any process still has it open, so deleting a patient freed nothing
# until this service restarted. And because entries were keyed by case id
# alone, a slide REPLACED on the same case went on being served in place of
# the new one. So the cache now checks, on every hit, that the file is still
# the one it opened; Node tells it when it removes a case's files (see
# do_DELETE); and a periodic sweep closes whatever is left.
_cache = OrderedDict()          # caseId -> {"slide", "dz", "lock", "path", "identity"}
_cache_lock = threading.Lock()


def file_identity(path):
    """What tells a file apart from its replacement — None once it is gone."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    return (st.st_ino, st.st_size, st.st_mtime_ns)


def close_entry(entry):
    # Under the slide's own lock, so a tile being read from it finishes first.
    with entry["lock"]:
        try:
            entry["slide"].close()
        except Exception:
            pass


def evict(case_id, only=None):
    """Close and forget a case's slide. With `only`, just if that is still the
    cached entry — another thread may already have replaced it."""
    with _cache_lock:
        entry = _cache.get(case_id)
        if entry is None or (only is not None and entry is not only):
            return
        del _cache[case_id]
    close_entry(entry)


def reap_stale():
    """Close every cached slide whose file was deleted or replaced."""
    with _cache_lock:
        stale = [(cid, e) for cid, e in _cache.items() if file_identity(e["path"]) != e["identity"]]
    for cid, entry in stale:
        evict(cid, only=entry)


def find_slide_file(case_id):
    """The uploaded slide for a case: <uploads>/<caseId>/<any single file>."""
    case_dir = os.path.join(UPLOADS_DIR, str(case_id))
    if not os.path.isdir(case_dir):
        return None
    for name in sorted(os.listdir(case_dir)):
        path = os.path.join(case_dir, name)
        if os.path.isfile(path):
            return path
    return None


def get_entry(case_id):
    """Fetch (or open) the cached OpenSlide + DeepZoomGenerator for a case."""
    with _cache_lock:
        cached = _cache.get(case_id)
        if cached is not None:
            _cache.move_to_end(case_id)
    if cached is not None:
        if file_identity(cached["path"]) == cached["identity"]:
            return cached
        evict(case_id, only=cached)    # deleted or replaced since it was opened

    path = find_slide_file(case_id)
    if not path:
        return None
    identity = file_identity(path)
    slide = openslide.OpenSlide(path)          # raises if unreadable/not a slide
    entry = {
        "slide": slide,
        "dz": DeepZoomGenerator(slide, tile_size=TILE_SIZE, overlap=OVERLAP, limit_bounds=True),
        "lock": threading.Lock(),
        "path": path,
        "identity": identity,
    }

    # The viewer asks for many tiles at once, so several threads can miss the
    # cache for the same slide together. Only one copy may be kept: any other
    # would never be closed, and would hold the file open for good.
    to_close = []
    with _cache_lock:
        current = _cache.get(case_id)
        if current is not None and current["path"] == path and current["identity"] == identity:
            to_close.append(entry)
            entry = current
        else:
            if current is not None:
                to_close.append(current)
            _cache[case_id] = entry
        _cache.move_to_end(case_id)
        while len(_cache) > MAX_OPEN_SLIDES:
            to_close.append(_cache.popitem(last=False)[1])
    for old in to_close:
        close_entry(old)
    return entry


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"   # keep-alive: the viewer requests many tiles

    def _send(self, code, body=b"", content_type="application/octet-stream", cache=False):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if cache:
            # Tiles for a given slide never change, so let the browser keep them.
            self.send_header("Cache-Control", "public, max-age=86400")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, b'{"ok":true}', "application/json")

        m = DZI_RE.match(self.path)
        if m:
            case_id = m.group(1)
            try:
                entry = get_entry(case_id)
                if not entry:
                    return self._send(404, b'{"error":"slide not found"}', "application/json")
                with entry["lock"]:
                    xml = entry["dz"].get_dzi("jpeg")
                return self._send(200, xml.encode("utf-8"), "application/xml")
            except Exception as e:
                return self._send(500, json.dumps({"error": str(e)}).encode(), "application/json")

        # Slide metadata. The important field is microns-per-pixel, which the
        # scanner records and which is the ONLY honest basis for a scale bar or
        # a magnification readout — without it the viewer shows neither rather
        # than inventing a scale on a diagnostic image.
        m = INFO_RE.match(self.path)
        if m:
            case_id = m.group(1)
            try:
                entry = get_entry(case_id)
                if not entry:
                    return self._send(404, b'{"error":"slide not found"}', "application/json")
                with entry["lock"]:
                    s = entry["slide"]
                    props = s.properties
                    mpp_x = props.get("openslide.mpp-x")
                    mpp_y = props.get("openslide.mpp-y")
                    info = {
                        "width": s.dimensions[0],
                        "height": s.dimensions[1],
                        "levelCount": s.level_count,
                        # None when the file carries no calibration
                        "mppX": float(mpp_x) if mpp_x else None,
                        "mppY": float(mpp_y) if mpp_y else None,
                        "vendor": props.get("openslide.vendor"),
                    }
                body = json.dumps(info).encode()
                return self._send(200, body, "application/json", cache=True)
            except Exception as e:
                return self._send(500, json.dumps({"error": str(e)}).encode(), "application/json")

        # A single downscaled JPEG of the WHOLE slide. Used when exporting an
        # annotated image: the native size (billions of pixels) is far past
        # what a browser canvas can hold, so the export is built from this.
        m = OVERVIEW_RE.match(self.path)
        if m:
            case_id = m.group(1)
            try:
                from urllib.parse import urlparse, parse_qs
                q = parse_qs(urlparse(self.path).query)
                want_w = min(int(q.get("w", [2048])[0]), MAX_OVERVIEW_DIM)
                want_h = min(int(q.get("h", [2048])[0]), MAX_OVERVIEW_DIM)

                entry = get_entry(case_id)
                if not entry:
                    return self._send(404, b"", "image/jpeg")
                with entry["lock"]:
                    # get_thumbnail picks the nearest pyramid level itself, so
                    # this never decodes the full-resolution image.
                    thumb = entry["slide"].get_thumbnail((want_w, want_h))
                buf = io.BytesIO()
                thumb.convert("RGB").save(buf, "JPEG", quality=88)
                return self._send(200, buf.getvalue(), "image/jpeg", cache=True)
            except Exception as e:
                return self._send(500, json.dumps({"error": str(e)}).encode(), "application/json")

        m = TILE_RE.match(self.path)
        if m:
            case_id, level, col, row = m.group(1), int(m.group(2)), int(m.group(3)), int(m.group(4))
            try:
                entry = get_entry(case_id)
                if not entry:
                    return self._send(404, b"", "image/jpeg")
                with entry["lock"]:
                    tile = entry["dz"].get_tile(level, (col, row))
                buf = io.BytesIO()
                tile.save(buf, "JPEG", quality=JPEG_QUALITY)
                return self._send(200, buf.getvalue(), "image/jpeg", cache=True)
            except Exception:
                # Out-of-range tiles are normal at the pyramid edges — the
                # viewer simply doesn't draw them.
                return self._send(404, b"", "image/jpeg")

        return self._send(404, b'{"error":"not found"}', "application/json")

    # Node calls this after removing a case's files — a deletion, or a cancelled
    # or failed upload — so the slide is closed at once rather than whenever the
    # cache next turns over. Only reachable from this machine: the service
    # listens on 127.0.0.1, and the public /slides proxy forwards GET alone.
    def do_DELETE(self):
        m = RELEASE_RE.match(self.path)
        if not m:
            return self._send(404, b'{"error":"not found"}', "application/json")
        evict(m.group(1))
        return self._send(204)

    def log_message(self, *args):
        pass   # Node owns the console; tile logs would drown everything else


def reap_forever():
    while True:
        time.sleep(REAP_INTERVAL_S)
        try:
            reap_stale()
        except Exception as e:
            print(f"[tiles] closing stale slides failed: {e}", flush=True)


def main():
    os.makedirs(UPLOADS_DIR, exist_ok=True)
    # The backstop for files removed without Node's DELETE arriving — a manual
    # rm, a restored backup, or a release request that timed out.
    threading.Thread(target=reap_forever, daemon=True).start()
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[tiles] serving slides from {UPLOADS_DIR} on http://127.0.0.1:{PORT}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
