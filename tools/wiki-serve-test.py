#!/usr/bin/env python3
"""Smoke test for tools/wiki-serve.py — stdlib only.

Starts the server on an ephemeral port in a background thread, pointed at a
TEMPORARY copy of notes.json (via --notes), so the real docs/wiki/notes.json is
never modified. Runs a handful of checks, prints PASS/FAIL per check, and exits
non-zero on any failure.

    python tools/wiki-serve-test.py
"""
import importlib.util
import json
import os
import shutil
import socket
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SERVE_PATH = os.path.join(HERE, "wiki-serve.py")
WIKI_DIR = os.path.join(os.path.dirname(HERE), "docs", "wiki")
REAL_NOTES = os.path.join(WIKI_DIR, "notes.json")

results = []


def check(name, ok, detail=""):
    results.append(ok)
    status = "PASS" if ok else "FAIL"
    line = f"[{status}] {name}"
    if detail:
        line += f" — {detail}"
    print(line)


def free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def load_module():
    spec = importlib.util.spec_from_file_location("wiki_serve", SERVE_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def get_json(url):
    with urllib.request.urlopen(url, timeout=5) as r:
        return r.getcode(), json.loads(r.read().decode("utf-8"))


def post_json(url, payload):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.getcode(), json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


def get_text(url):
    with urllib.request.urlopen(url, timeout=5) as r:
        return r.getcode(), r.read().decode("utf-8")


def main():
    mod = load_module()

    # Temp copy of notes.json so we never mutate the real store.
    tmpdir = tempfile.mkdtemp(prefix="wiki-test-")
    tmp_notes = os.path.join(tmpdir, "notes.json")
    if os.path.isfile(REAL_NOTES):
        shutil.copyfile(REAL_NOTES, tmp_notes)
    else:
        with open(tmp_notes, "w", encoding="utf-8") as f:
            f.write("[]")

    mod.CONFIG["wiki_dir"] = WIKI_DIR
    mod.CONFIG["notes_path"] = tmp_notes
    mod.CONFIG["author"] = "you"

    port = free_port()
    base = f"http://127.0.0.1:{port}"
    httpd = mod.ThreadingHTTPServer(("127.0.0.1", port), mod.Handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()

    # Wait for the server to accept connections.
    for _ in range(50):
        try:
            get_json(base + "/api/notes")
            break
        except Exception:
            time.sleep(0.05)

    try:
        # 1. GET /api/notes -> array
        try:
            code, notes = get_json(base + "/api/notes")
            check("GET /api/notes returns array", code == 200 and isinstance(notes, list),
                  f"code={code}, type={type(notes).__name__}")
            baseline = len(notes)
        except Exception as e:
            check("GET /api/notes returns array", False, str(e))
            baseline = 0

        # 2. POST a test note -> 201 + echo with id/createdAt
        topic = "terrain"
        created = None
        try:
            code, created = post_json(base + "/api/notes", {
                "topic": topic, "type": "note", "text": "smoke-test note", "author": "you",
            })
            ok = (
                code == 201
                and isinstance(created, dict)
                and bool(created.get("id"))
                and bool(created.get("createdAt"))
                and created.get("topic") == topic
                and created.get("text") == "smoke-test note"
            )
            check("POST /api/notes returns 201 with id/createdAt", ok,
                  f"code={code}, id={created.get('id') if isinstance(created, dict) else None}")
        except Exception as e:
            check("POST /api/notes returns 201 with id/createdAt", False, str(e))

        # 3. GET /api/notes?topic=<topic> contains the new note
        try:
            code, scoped = get_json(base + f"/api/notes?topic={topic}")
            new_id = created.get("id") if isinstance(created, dict) else None
            present = any(n.get("id") == new_id for n in scoped) if new_id else False
            check(f"GET /api/notes?topic={topic} includes posted note",
                  code == 200 and present, f"code={code}, count={len(scoped)}")
        except Exception as e:
            check(f"GET /api/notes?topic={topic} includes posted note", False, str(e))

        # 4. GET /content/terrain.md -> 200, non-empty
        try:
            code, body = get_text(base + "/content/terrain.md")
            check("GET /content/terrain.md returns 200 non-empty",
                  code == 200 and len(body.strip()) > 0, f"code={code}, bytes={len(body)}")
        except Exception as e:
            check("GET /content/terrain.md returns 200 non-empty", False, str(e))

        # 5. Path traversal is blocked.
        try:
            try:
                code, _ = get_text(base + "/../wiki-serve.py")
            except urllib.error.HTTPError as e:
                code = e.code
            check("path traversal blocked (../wiki-serve.py)", code in (403, 404),
                  f"code={code}")
        except Exception as e:
            check("path traversal blocked (../wiki-serve.py)", False, str(e))

        # 6. Invalid type rejected with 400.
        try:
            code, _ = post_json(base + "/api/notes",
                                {"topic": topic, "type": "bogus", "text": "x"})
            check("POST invalid type rejected (400)", code == 400, f"code={code}")
        except Exception as e:
            check("POST invalid type rejected (400)", False, str(e))

        # 7. Real notes.json untouched (server only wrote the temp copy).
        try:
            with open(REAL_NOTES, encoding="utf-8") as f:
                real = json.load(f)
            untouched = all(n.get("text") != "smoke-test note" for n in real)
            check("real notes.json untouched", untouched, f"entries={len(real)}")
        except Exception as e:
            check("real notes.json untouched", False, str(e))

    finally:
        httpd.shutdown()
        httpd.server_close()
        shutil.rmtree(tmpdir, ignore_errors=True)

    print()
    if all(results) and results:
        print(f"ALL PASS ({len(results)} checks)")
        sys.exit(0)
    else:
        print(f"FAILURES: {results.count(False)}/{len(results)} checks failed")
        sys.exit(1)


if __name__ == "__main__":
    main()
