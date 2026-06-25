#!/usr/bin/env python3
"""Project working-notes wiki — local, no-build, stdlib-only HTTP server.

Serves the static front-end in docs/wiki/ and a tiny JSON notes API so that
both the user (in a browser) and Claude (via file tools or --as claude) read and
append the SAME repo-backed notes store (docs/wiki/notes.json).

    python tools/wiki-serve.py
    -> open http://localhost:8777

Endpoints:
    GET  /                      docs/wiki/index.html
    GET  /<static>              docs/wiki/<static>  (assets/*, content/*.md, nav.json, ...)
    GET  /api/notes?topic=slug  notes whose topic == slug OR "general", oldest-first
    GET  /api/notes             all notes, oldest-first
    POST /api/notes             {topic,type,author?,text,parentId?} -> create + return entry

Stdlib only: http.server, json, uuid, datetime, argparse, threading, os.
"""
import argparse
import json
import mimetypes
import os
import socketserver
import sys
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WIKI_DIR = os.path.join(REPO_ROOT, "docs", "wiki")

# Resolved at startup from CLI args.
CONFIG = {
    "wiki_dir": WIKI_DIR,
    "notes_path": os.path.join(WIKI_DIR, "notes.json"),
    "author": "you",
}

_notes_lock = threading.Lock()

VALID_TYPES = {"note", "question", "answer"}

# Content types we care about (mimetypes can be flaky for these on Windows).
_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
}


def content_type_for(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in _CONTENT_TYPES:
        return _CONTENT_TYPES[ext]
    guessed, _ = mimetypes.guess_type(path)
    return guessed or "application/octet-stream"


def known_slugs():
    """Slugs read from nav.json so POST topic validation tracks the real nav."""
    slugs = {"general"}
    try:
        with open(os.path.join(CONFIG["wiki_dir"], "nav.json"), encoding="utf-8") as f:
            for item in json.load(f):
                if isinstance(item, dict) and item.get("slug"):
                    slugs.add(item["slug"])
    except Exception:
        pass
    return slugs


def load_notes():
    """Read notes.json -> list. Missing/empty/corrupt file yields []."""
    try:
        with open(CONFIG["notes_path"], encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except FileNotFoundError:
        return []
    except Exception:
        return []


def append_note(entry):
    """Atomic read-modify-write of notes.json under a lock.

    Writes ONLY to CONFIG['notes_path'] (temp file in the same dir, then replace).
    """
    with _notes_lock:
        notes = load_notes()
        notes.append(entry)
        notes_path = CONFIG["notes_path"]
        directory = os.path.dirname(notes_path) or "."
        os.makedirs(directory, exist_ok=True)
        tmp = os.path.join(directory, f".notes.{uuid.uuid4().hex}.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(notes, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp, notes_path)
    return entry


def safe_static_path(url_path):
    """Map a URL path to a file under wiki_dir, guarding against traversal.

    Returns an absolute path inside wiki_dir, or None if the request escapes it.
    """
    rel = url_path.lstrip("/")
    if rel == "":
        rel = "index.html"
    # Normalize and reject anything that climbs out of the wiki dir.
    wiki_dir = os.path.realpath(CONFIG["wiki_dir"])
    full = os.path.realpath(os.path.join(wiki_dir, rel))
    if full != wiki_dir and not full.startswith(wiki_dir + os.sep):
        return None
    return full


class Handler(BaseHTTPRequestHandler):
    server_version = "WikiServe/1.0"

    def log_message(self, *args):
        pass

    # --- helpers -----------------------------------------------------------
    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        b = body if isinstance(body, (bytes, bytearray)) else str(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(b)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False), "application/json; charset=utf-8")

    # --- GET ---------------------------------------------------------------
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/notes":
            return self._handle_get_notes(parse_qs(parsed.query))

        if path.startswith("/api/"):
            return self._json(404, {"error": "unknown endpoint"})

        return self._serve_static(path)

    def _handle_get_notes(self, query):
        topic = query.get("topic", [None])[0]
        notes = load_notes()

        # oldest-first by createdAt (falls back to original order for ties/missing).
        def sort_key(n):
            return n.get("createdAt") or ""

        notes = sorted(notes, key=sort_key)
        if topic:
            notes = [n for n in notes if n.get("topic") in (topic, "general")]
        return self._json(200, notes)

    def _serve_static(self, path):
        full = safe_static_path(path)
        if full is None:
            return self._json(403, {"error": "forbidden"})
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        if not os.path.isfile(full):
            return self._json(404, {"error": "not found"})
        try:
            with open(full, "rb") as f:
                body = f.read()
        except OSError:
            return self._json(404, {"error": "not found"})
        self._send(200, body, content_type_for(full))

    # --- POST --------------------------------------------------------------
    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/notes":
            return self._json(404, {"error": "unknown endpoint"})

        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw or b"{}")
        except Exception:
            return self._json(400, {"error": "invalid JSON body"})
        if not isinstance(body, dict):
            return self._json(400, {"error": "body must be a JSON object"})

        ntype = body.get("type")
        if ntype not in VALID_TYPES:
            return self._json(400, {"error": "type must be one of note|question|answer"})

        text = body.get("text")
        if not isinstance(text, str) or not text.strip():
            return self._json(400, {"error": "text must be a non-empty string"})

        topic = body.get("topic") or "general"
        if topic not in known_slugs():
            return self._json(400, {"error": f"unknown topic: {topic}"})

        author = body.get("author") or CONFIG["author"]
        parent_id = body.get("parentId")
        if parent_id is not None and not isinstance(parent_id, str):
            return self._json(400, {"error": "parentId must be a string or null"})

        entry = {
            "id": str(uuid.uuid4()),
            "topic": topic,
            "type": ntype,
            "author": str(author),
            "parentId": parent_id,
            "text": text,
            "createdAt": datetime.now(timezone.utc).isoformat(),
        }
        append_note(entry)
        return self._json(201, entry)


class ThreadingHTTPServer(socketserver.ThreadingMixIn, HTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def main(argv=None):
    parser = argparse.ArgumentParser(description="Serve the project working-notes wiki.")
    parser.add_argument("--port", type=int, default=8777, help="port to listen on (default 8777)")
    parser.add_argument("--as", dest="author", default="you",
                        help="default author for notes posted without one (default 'you')")
    parser.add_argument("--notes", dest="notes_path", default=None,
                        help="override notes.json path (used by the smoke test)")
    args = parser.parse_args(argv)

    CONFIG["author"] = args.author
    if args.notes_path:
        CONFIG["notes_path"] = os.path.abspath(args.notes_path)

    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://localhost:{args.port}"
    print(f"Project wiki:  {url}")
    print(f"Serving:       {CONFIG['wiki_dir']}")
    print(f"Notes store:   {CONFIG['notes_path']}")
    print(f"Default author (--as): {CONFIG['author']}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping.")
        httpd.shutdown()


if __name__ == "__main__":
    main()
