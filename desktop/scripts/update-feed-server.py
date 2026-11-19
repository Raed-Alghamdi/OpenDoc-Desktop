#!/usr/bin/env python3
"""A local update feed for testing opendoc-desktop's updater. It binds 127.0.0.1 only and never talks to the network.

Usage: update-feed-server.py <root> [port]      (port 0 or none: pick a free one; the first line printed is {"port": N})

It serves two layouts from one root folder:

  /generic/<file>                                   -> <root>/generic/<file>
      for an `updateFeed` of http://127.0.0.1:<port>/generic/
  GitHub-shaped release URLs, for an `updateFeed` of http://127.0.0.1:<port>/github-like (what electron-updater's GitHub provider asks for):
  /<owner>/<repo>/releases.atom                     -> an atom feed of the tag folders, newest first
  /api/v3/repos/<owner>/<repo>/releases/latest      -> {"tag_name": ...} (the tag named in <root>/LATEST)
  /<owner>/<repo>/releases/download/<tag>/<file>    -> <root>/tags/<tag>/<file>

A <root>/redirects.json of {"/request/path": "location"} answers those paths with a 302 to the location (to test what the app does with a redirect).

Range requests work (one range or several, as electron-updater's differential AppImage download sends). Every request is appended to
<root>/requests.log as one JSON line with the bytes sent, so a test can show what the app asked for and what it did not.
"""
import json
import os
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(sys.argv[1])
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 0
LOG = os.path.join(ROOT, 'requests.log')
OWNER_REPO = 'Raed-Alghamdi/OpenDoc-Desktop'
BOUNDARY = 'FEEDBOUNDARY'


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    sent = 0

    def log_message(self, *args):
        pass

    def record(self, status):
        with open(LOG, 'a') as f:
            f.write(json.dumps({'t': time.strftime('%H:%M:%S'), 'method': self.command, 'path': self.path, 'range': self.headers.get('Range'), 'status': status, 'sent': self.sent}) + '\n')

    def send_bytes(self, status, body, ctype='application/octet-stream', extra=None):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Accept-Ranges', 'bytes')
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)
        self.sent = len(body)
        self.record(status)

    def serve_file(self, path):
        if not os.path.isfile(path):
            return self.send_bytes(404, b'not found', 'text/plain')
        size = os.path.getsize(path)
        wanted = self.headers.get('Range')
        ctype = 'text/yaml' if path.endswith('.yml') else 'application/octet-stream'
        if not wanted:
            with open(path, 'rb') as f:
                return self.send_bytes(200, f.read(), ctype)
        specs = []
        for part in wanted.replace('bytes=', '').split(','):
            m = re.match(r'\s*(\d*)-(\d*)\s*$', part)
            if not m:
                return self.send_bytes(416, b'bad range', 'text/plain')
            a, b = m.groups()
            start = int(a) if a else max(size - int(b), 0)
            end = int(b) if (a and b) else size - 1
            specs.append((start, min(end, size - 1)))
        with open(path, 'rb') as f:
            if len(specs) == 1:
                start, end = specs[0]
                f.seek(start)
                return self.send_bytes(206, f.read(end - start + 1), ctype, {'Content-Range': f'bytes {start}-{end}/{size}'})
            body = b''
            for start, end in specs:
                f.seek(start)
                body += f'--{BOUNDARY}\r\nContent-Type: {ctype}\r\nContent-Range: bytes {start}-{end}/{size}\r\n\r\n'.encode() + f.read(end - start + 1) + b'\r\n'
            body += f'--{BOUNDARY}--\r\n'.encode()
            return self.send_bytes(206, body, f'multipart/byteranges; boundary={BOUNDARY}')

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = self.path.split('?')[0]
        redirects_file = os.path.join(ROOT, 'redirects.json')
        redirects = json.load(open(redirects_file)) if os.path.exists(redirects_file) else {}
        if path in redirects:
            self.send_response(302)
            self.send_header('Location', redirects[path])
            self.send_header('Content-Length', '0')
            self.end_headers()
            self.sent = 0
            return self.record(302)
        tags_dir = os.path.join(ROOT, 'tags')
        latest_file = os.path.join(ROOT, 'LATEST')
        latest = open(latest_file).read().strip() if os.path.exists(latest_file) else None
        if path.startswith('/generic/'):
            return self.serve_file(os.path.join(ROOT, 'generic', os.path.basename(path)))
        if path == f'/{OWNER_REPO}/releases.atom':
            tags = sorted(os.listdir(tags_dir), key=lambda t: os.path.getmtime(os.path.join(tags_dir, t)), reverse=True) if os.path.isdir(tags_dir) else []
            entries = ''.join(f'<entry><id>tag:github.com,2008:Repository/1/{t}</id><link rel="alternate" type="text/html" href="http://127.0.0.1:{self.server.server_port}/{OWNER_REPO}/releases/tag/{t}"/><title>{t}</title><content type="html">notes for {t}</content></entry>' for t in tags)
            return self.send_bytes(200, f'<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">{entries}</feed>'.encode(), 'application/atom+xml')
        if path == f'/api/v3/repos/{OWNER_REPO}/releases/latest':
            return self.send_bytes(200, json.dumps({'tag_name': latest}).encode(), 'application/json')
        m = re.match(rf'^/{re.escape(OWNER_REPO)}/releases/download/([^/]+)/([^/]+)$', path)
        if m:
            return self.serve_file(os.path.join(tags_dir, os.path.basename(m.group(1)), os.path.basename(m.group(2))))
        return self.send_bytes(404, b'not found', 'text/plain')


server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
print(json.dumps({'port': server.server_port}), flush=True)
server.serve_forever()
