#!/usr/bin/env python3
"""Spike S6 test feed. Binds 127.0.0.1 only. Serves two layouts from one root folder:

  /generic/<file>                                   -> <root>/generic/<file>
  GitHub-like release URLs (what electron-updater's GitHub provider asks for, with host 127.0.0.1:<port>):
  /<owner>/<repo>/releases.atom                     -> atom feed of the tag folders, newest first
  /api/v3/repos/<owner>/<repo>/releases/latest      -> {"tag_name": ...} (the tag named in <root>/LATEST)
  /<owner>/<repo>/releases/download/<tag>/<file>    -> <root>/tags/<tag>/<file>

Supports Range (one range or several, as electron-updater's differential download sends). Every request goes to <root>/requests.log
with the bytes actually sent, so a test can show what the app did and did not ask for.
"""
import json, os, re, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(sys.argv[1])
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8099
LOG = os.path.join(ROOT, 'requests.log')
OWNER_REPO = 'Raed-Alghamdi/OpenDoc-Desktop'
BOUNDARY = 'S6BOUNDARY'


class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    sent = 0

    def log_message(self, *a):
        pass

    def record(self, status):
        with open(LOG, 'a') as f:
            f.write(json.dumps({'t': time.strftime('%H:%M:%S'), 'method': self.command, 'path': self.path, 'range': self.headers.get('Range'), 'status': status, 'sent': self.sent}) + '\n')

    def send_bytes(self, status, body, ctype='application/octet-stream', extra=None):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Accept-Ranges', 'bytes')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)
        self.sent = len(body)
        self.record(status)

    def serve_file(self, path):
        if not os.path.isfile(path):
            return self.send_bytes(404, b'not found', 'text/plain')
        size = os.path.getsize(path)
        rng = self.headers.get('Range')
        ctype = 'text/yaml' if path.endswith('.yml') else 'application/octet-stream'
        if not rng:
            with open(path, 'rb') as f:
                return self.send_bytes(200, f.read(), ctype)
        specs = []
        for part in rng.replace('bytes=', '').split(','):
            m = re.match(r'\s*(\d*)-(\d*)\s*$', part)
            if not m:
                return self.send_bytes(416, b'bad range', 'text/plain')
            a, b = m.groups()
            start = int(a) if a else max(size - int(b), 0)
            end = int(b) if (a and b) else size - 1
            specs.append((start, min(end, size - 1)))
        with open(path, 'rb') as f:
            if len(specs) == 1:
                s, e = specs[0]
                f.seek(s)
                return self.send_bytes(206, f.read(e - s + 1), ctype, {'Content-Range': f'bytes {s}-{e}/{size}'})
            body = b''
            for s, e in specs:
                f.seek(s)
                body += (f'--{BOUNDARY}\r\nContent-Type: {ctype}\r\nContent-Range: bytes {s}-{e}/{size}\r\n\r\n').encode() + f.read(e - s + 1) + b'\r\n'
            body += f'--{BOUNDARY}--\r\n'.encode()
            return self.send_bytes(206, body, f'multipart/byteranges; boundary={BOUNDARY}')

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        p = self.path.split('?')[0]
        tags_dir = os.path.join(ROOT, 'tags')
        latest = open(os.path.join(ROOT, 'LATEST')).read().strip() if os.path.exists(os.path.join(ROOT, 'LATEST')) else None
        if p.startswith('/generic/'):
            return self.serve_file(os.path.join(ROOT, 'generic', os.path.basename(p)))
        if p == f'/{OWNER_REPO}/releases.atom':
            tags = sorted(os.listdir(tags_dir), key=lambda t: os.path.getmtime(os.path.join(tags_dir, t)), reverse=True) if os.path.isdir(tags_dir) else []
            entries = ''.join(f'<entry><id>tag:github.com,2008:Repository/1/{t}</id><link rel="alternate" type="text/html" href="http://127.0.0.1:{PORT}/{OWNER_REPO}/releases/tag/{t}"/><title>{t}</title><content type="html">notes for {t}</content></entry>' for t in tags)
            return self.send_bytes(200, f'<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">{entries}</feed>'.encode(), 'application/atom+xml')
        if p == f'/api/v3/repos/{OWNER_REPO}/releases/latest':
            return self.send_bytes(200, json.dumps({'tag_name': latest}).encode(), 'application/json')
        m = re.match(rf'^/{re.escape(OWNER_REPO)}/releases/download/([^/]+)/([^/]+)$', p)
        if m:
            return self.serve_file(os.path.join(tags_dir, os.path.basename(m.group(1)), os.path.basename(m.group(2))))
        return self.send_bytes(404, b'not found', 'text/plain')


ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
