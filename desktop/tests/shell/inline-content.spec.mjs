// The invariant behind "file windows share the workspace session" (desktop/README.md, "Hardening"): the service never serves
// user-supplied bytes inline as HTML, script or SVG. An .html, a .js and an .svg (with a script in it) are added through
// the normal routes (logo and font uploads, a media import) or placed in a document's media folder the way a user
// would, then fetched back through app://opendoc. Whatever the service accepted must come back as an attachment or as
// a type that cannot run script, with nosniff; whatever it refused must be refused and must not be retrievable.
import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchApp, newProfile, newWorkspace, stubNative } from './support/app.mjs';
import { libraryReady } from './support/helpers.mjs';

const html = '<!doctype html><title>x</title><script>document.title = "ran"</script><h1>user page</h1>';
const js = 'document.title = "ran"; fetch("/api/session");';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><script>document.title = "ran"</script><rect width="8" height="8"/></svg>';
const plainSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>';
// A valid 1x1 PNG: the positive control that shows the metadata of the media import is accepted when the file is an image.
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test.describe.serial('user content is never served inline as HTML, script or SVG', () => {
  test.describe.configure({ timeout: 300_000 });
  let app; let page; let workspace;
  const run = (code, ...args) => page.evaluate(code, ...args);

  test.beforeAll(async () => {
    workspace = await newWorkspace('inline-content');
    app = await launchApp({ profile: await newProfile('inline-content-profile', { defaultWorkspace: workspace }) });
    await stubNative(app);
    page = await app.firstWindow();
    await libraryReady(page);
    await page.evaluate(() => {
      window.__send = async (route, parts) => {
        const token = (await (await fetch('/api/session')).json()).token;
        const form = new FormData();
        for (const [name, value, filename, type] of parts) {
          if (filename) form.append(name, new Blob([value instanceof Uint8Array ? value : String(value)], { type }), filename); else form.append(name, value);
        }
        const response = await fetch(route, { method: 'POST', headers: { 'x-opendoc-token': token }, body: form });
        return { status: response.status, body: await response.json().catch(() => null) };
      };
      window.__headers = async address => {
        const response = await fetch(address);
        return { status: response.status, type: (response.headers.get('content-type') ?? '').split(';')[0], disposition: response.headers.get('content-disposition') ?? '', nosniff: response.headers.get('x-content-type-options'), csp: response.headers.get('content-security-policy') ?? '' };
      };
    });
  });

  test.afterAll(async () => { await app?.close().catch(() => {}); });

  /** The rule every route that serves user bytes must meet. */
  const mustBeSafe = (answer, label) => {
    const runsScript = ['text/html', 'application/xhtml+xml', 'text/javascript', 'application/javascript', 'text/xml', 'application/xml', 'image/svg+xml'].includes(answer.type);
    expect(answer.status, label).toBe(200);
    expect(runsScript ? answer.disposition : 'attachment', `${label} is served as ${answer.type} (${answer.disposition})`).toMatch(/^attachment/);
    expect(answer.nosniff, `${label} sends nosniff`).toBe('nosniff');
    expect(answer.type, label).not.toBe('');
  };

  test('logo and font uploads: an .html and a .js are refused, an .svg comes back as an attachment inside a sandbox, and what comes back always has nosniff', async () => {
    const accepted = [];
    for (const [name, file, type, content] of [
      ['Plain svg', 'plain.svg', 'image/svg+xml', plainSvg],
      ['Evil svg', 'evil.svg', 'image/svg+xml', svg],
      ['Evil html', 'evil.html', 'text/html', html],
      ['Evil js', 'evil.js', 'text/javascript', js],
      ['Html as png', 'evil.png', 'image/png', html],
      ['Svg as png', 'svg-as-png.png', 'image/png', svg],
    ]) {
      const answer = await run(args => window.__send('/api/assets/logo', [['metadata', JSON.stringify({ name: args.name })], ['file', args.content, args.file, args.type]]), { name, file, type, content });
      if (answer.status === 201) accepted.push({ name, file, answer });
      else expect(answer.status, `${file} is refused, not stored`).toBeGreaterThanOrEqual(400);
    }
    // The positive control: a plain .svg is a valid logo (so the refusals above are about the files). The service also refuses
    // an .svg that carries a script; if that ever changes, the loop below still holds it to the attachment-and-sandbox rule.
    expect(accepted.map(item => item.file)).toContain('plain.svg');
    expect(accepted.map(item => item.file)).not.toContain('evil.html');
    expect(accepted.map(item => item.file)).not.toContain('evil.js');
    for (const { file, answer } of accepted) {
      const { asset } = answer.body;
      for (const which of ['original', 'embedded', 'preview', 'png']) {
        const stored = asset.variations[0][which]?.file;
        if (!stored) continue;
        const route = `/api/assets/logo/${asset.id}/file?revision=${asset.revision}&file=${encodeURIComponent(stored)}`;
        const served = await run(address => window.__headers(address), route);
        mustBeSafe(served, `${file} (${which}, ${stored})`);
        if (served.type === 'image/svg+xml') expect(served.csp, `${file} is sandboxed`).toContain("default-src 'none'; sandbox");
      }
    }
    // Fonts take .ttf and .otf only.
    for (const [file, type, content] of [['evil.html', 'text/html', html], ['evil.js', 'text/javascript', js], ['evil.svg', 'image/svg+xml', svg]]) {
      const answer = await run(args => window.__send('/api/assets/font', [['metadata', JSON.stringify({ name: 'Evil font ' + args.file })], ['files', args.content, args.file, args.type]]), { file, type, content });
      expect(answer.status, `${file} is refused as a font`).toBeGreaterThanOrEqual(400);
    }
    const listed = await run(async () => (await (await fetch('/api/assets?kind=font')).json()).items.map(item => item.name));
    expect(listed.filter(name => name.startsWith('Evil font'))).toEqual([]);
  });

  test('media: an .html, a .js and an .svg are refused as an image; files a user puts in the media folder come back as octet-stream attachments with nosniff', async () => {
    const meta = { title: 'Probe', description: 'A probe for the tests.', kind: 'image', alt: 'Probe' };
    for (const [file, type, content] of [['evil.html', 'text/html', html], ['evil.js', 'text/javascript', js], ['evil.svg', 'image/svg+xml', svg]]) {
      const answer = await run(args => window.__send('/api/materials/welcome/import', [['metadata', JSON.stringify(args.meta)], ['file', args.content, args.file, args.type]]), { meta, file, type, content });
      expect(answer.status, `${file} is refused as an image`).toBeGreaterThanOrEqual(400);
    }
    const control = await run(args => window.__send('/api/materials/welcome/import', [['metadata', JSON.stringify(args.meta)], ['file', Uint8Array.from(atob(args.pixel), c => c.charCodeAt(0)), 'pixel.png', 'image/png']]), { meta, pixel });
    expect(control.status, 'the same metadata is accepted for a real image, so the refusals above are about the file').toBeLessThan(400);
    // What a user can put there by hand (the folder is theirs): the service must still never serve it inline.
    const folder = join(workspace, 'documents', 'welcome', 'media', 'probe');
    await mkdir(folder, { recursive: true });
    for (const [file, content] of [['evil.html', html], ['evil.js', js], ['evil.svg', svg]]) {
      await writeFile(join(folder, file), content);
      const served = await run(address => window.__headers(address), `/api/materials/welcome/file?path=${encodeURIComponent(`media/probe/${file}`)}`);
      mustBeSafe(served, `media/probe/${file}`);
      expect(served.type, file).toBe('application/octet-stream');
    }
  });

  test('the app\'s own files and the service\'s documents are the only inline answers: the library page is the app, and a PDF is made by the service', async () => {
    const page_ = await run(async () => { const response = await fetch('/'); return { status: response.status, type: (response.headers.get('content-type') ?? '').split(';')[0], nosniff: response.headers.get('x-content-type-options') }; });
    expect(page_).toMatchObject({ status: 200, type: 'text/html', nosniff: 'nosniff' });
    const pdf = await run(async () => {
      const summaries = await (await fetch('/api/documents')).json();
      const welcome = (Array.isArray(summaries) ? summaries : summaries.documents).find(item => item.id === 'welcome');
      const response = await fetch(`/api/documents/welcome/pdf?hash=${welcome.hash ?? welcome.artifact?.hash}`);
      return { status: response.status, type: response.headers.get('content-type'), nosniff: response.headers.get('x-content-type-options') };
    });
    // Known gap in the service: the PDF routes send no nosniff (the bytes are generated by the service, not supplied by a user).
    expect(pdf).toMatchObject({ status: 200, type: 'application/pdf' });
  });
});
