import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { ApiError, discardStagedPack, exportPack, inspectPack, installPack, type PackExportResult, type PackInspection, type PackInstallResult, type PackItemInfo } from './api';
import { PdfPage, usePdf } from './Pdf';
import { fetchReadOnly } from './readOnly';
import { Button, Dialog, Input } from './ui';
import { Icon } from './ui/Icon';
import {
  canInstall, chosenCount, chosenText, createStagedHold, emptyExportForm, exportFailure, exportProblems, exportRequest, fileSize, importEntry, importHosts,
  installedLinks, isPackFileName, licenseLimit, nameLimit, openPackImport, packBlockers, packBridge, packChoice, packFileName, packSizeLimit, type ExportForm, type ImportRequest, type PackKind,
} from './packs';
import './packs.css';

/* Choosing designs in a gallery. */

/** The two gallery buttons: Import pack, and Export pack (which starts choosing designs). */
export function PackHeadingButtons({ kind, count, connected = true }: { kind: PackKind; count: number; connected?: boolean }) {
  const choice = useSyncExternalStore(packChoice.subscribe, packChoice.get);
  const noun = kind === 'theme' ? 'themes' : 'templates';
  return <>
    <Button onClick={() => openPackImport()} disabled={!connected}><Icon name="download" size={17} />Import pack</Button>
    <Button id={`pack-export-${kind}`} onClick={() => packChoice.start()} disabled={!count || !connected || choice.selecting} aria-describedby={count ? undefined : `pack-export-hint-${kind}`}><Icon name="archive" size={17} />Export pack</Button>
    {!count && <span id={`pack-export-hint-${kind}`} className="sr-only">There are no {noun} to export yet.</span>}
  </>;
}

/** A card's tick box while designs are being chosen. It covers the card, so a click anywhere on it chooses or unchooses. */
export function PackCardCheck({ kind, id, name }: { kind: PackKind; id: string; name: string }) {
  const choice = useSyncExternalStore(packChoice.subscribe, packChoice.get);
  if (!choice.selecting) return null;
  const checked = (kind === 'theme' ? choice.themes : choice.templates).includes(id);
  return <label className="pack-card-check">
    <input type="checkbox" checked={checked} onChange={() => packChoice.toggle(kind, id)} aria-label={`Include ${name} in the pack`} />
  </label>;
}

/** The bar that appears while choosing: what is chosen, Export, and Cancel. Also holds the Export dialog. */
export function PackSelectionBar({ kind, available, loaded = true, connected = true }: { kind: PackKind; available: readonly string[]; loaded?: boolean; connected?: boolean }) {
  const choice = useSyncExternalStore(packChoice.subscribe, packChoice.get);
  const [exporting, setExporting] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  const wasSelecting = useRef(false);
  // Only once the catalog has loaded, or a choice made in the other gallery would be dropped while this one is still empty.
  useEffect(() => { if (loaded) packChoice.prune(kind, available); }, [kind, loaded, available.join('\n')]);
  useEffect(() => {
    if (choice.selecting && !wasSelecting.current) bar.current?.focus();
    wasSelecting.current = choice.selecting;
  }, [choice.selecting]);
  const count = chosenCount(choice);
  function cancel() { packChoice.stop(); document.getElementById(`pack-export-${kind}`)?.focus(); }
  return <>
    {choice.selecting && <div className="pack-bar" ref={bar} tabIndex={-1} role="region" aria-label="Export a pack" onKeyDown={event => { if (event.key === 'Escape' && !exporting) cancel(); }}>
      <p className="pack-bar-text"><strong role="status">{chosenText(choice)} chosen</strong><span> Tick the designs to share. A pack carries everything they need, and you can also choose in the {kind === 'theme' ? 'Templates' : 'Themes'} gallery.</span></p>
      <div className="pack-bar-actions"><Button onClick={cancel}>Cancel</Button><Button className="primary" disabled={!count || !connected} onClick={() => setExporting(true)}>Export…</Button></div>
    </div>}
    <ExportPackDialog open={exporting} onOpenChange={setExporting} themes={choice.themes} templates={choice.templates} connected={connected} />
  </>;
}

/* Export */

type ExportState = { phase: 'form' } | { phase: 'working' } | { phase: 'done'; result: PackExportResult };

function CopyPath({ path }: { path: string }) {
  const field = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  async function copy() {
    try { await navigator.clipboard.writeText(path); setCopied(true); setError(''); }
    catch { setError('Copying isn’t available here. Select the path and copy it manually.'); field.current?.focus(); field.current?.select(); }
  }
  return <>
    <div className="pack-path">
      <Input ref={field} readOnly value={path} aria-label="Pack file location" />
      <Button onClick={() => void copy()}><Icon name={copied ? 'check' : 'copy'} size={16} />{copied ? 'Copied' : 'Copy path'}</Button>
    </div>
    <span className="sr-only" role="status">{copied ? 'Path copied.' : ''}</span>
    {error && <p className="field-error" role="alert">{error}</p>}
  </>;
}

/** The pack's contents as a list of the designs, so the user sees what was chosen. */
type ListedItem = Pick<PackItemInfo, 'kind' | 'id'> & { selected?: boolean };
function PackItems({ items }: { items: readonly ListedItem[] }) {
  return <ul className="pack-items">{items.map(item => <li key={`${item.kind}/${item.id}`}>
    <span className="pack-kind">{item.kind === 'theme' ? 'Theme' : 'Template'}</span><bdi className="pack-item-id">{item.id}</bdi>
    {item.selected === false && <span className="pack-item-note">Needed by another design</span>}
  </li>)}</ul>;
}

export function ExportPackDialog({ open, onOpenChange, themes, templates, connected }: { open: boolean; onOpenChange: (open: boolean) => void; themes: readonly string[]; templates: readonly string[]; connected: boolean }) {
  const [form, setForm] = useState<ExportForm>(emptyExportForm);
  const [state, setState] = useState<ExportState>({ phase: 'form' });
  const [error, setError] = useState('');
  const [attempted, setAttempted] = useState(false);
  const working = useRef(false);
  const nameField = useRef<HTMLInputElement>(null);
  const ids = useId();
  const choice = { themes, templates };
  useEffect(() => { if (open) { setForm(emptyExportForm); setState({ phase: 'form' }); setError(''); setAttempted(false); } }, [open]);
  const problems = exportProblems(form);
  const fallbackId = themes[0] ?? templates[0] ?? 'pack';
  const busy = state.phase === 'working';
  async function submit(event: FormEvent) {
    event.preventDefault();
    setAttempted(true);
    if (working.current || !connected || Object.keys(problems).length || !chosenCount(choice)) return;
    working.current = true; setState({ phase: 'working' }); setError('');
    try { setState({ phase: 'done', result: await exportPack(exportRequest(choice, form)) }); }
    catch (failure) { setError(failure instanceof ApiError ? exportFailure(failure) : (failure as Error).message); setState({ phase: 'form' }); }
    finally { working.current = false; }
  }
  function close(next: boolean) {
    if (!next && working.current) return;
    if (!next && state.phase === 'done') packChoice.stop();
    onOpenChange(next);
  }
  const shown = (field: keyof ExportForm) => attempted || form[field] ? problems[field] : undefined;
  const result = state.phase === 'done' ? state.result : undefined;
  const reveal = packBridge()?.showInFolder;
  const items: ListedItem[] = result?.items ?? [...themes.map(id => ({ kind: 'theme' as const, id })), ...templates.map(id => ({ kind: 'template' as const, id }))];
  return <Dialog.Root open={open} onOpenChange={close}>
    <Dialog.Portal><Dialog.Backdrop className="ui-dialog-backdrop" />
      <Dialog.Popup className="help-dialog create-dialog pack-dialog" initialFocus={nameField}>
        <Dialog.Close render={<Button className="icon-button modal-close" aria-label="Close export dialog" disabled={busy} />}><Icon name="close" /></Dialog.Close>
        <Dialog.Title>{result ? 'Pack saved' : 'Export a pack'}</Dialog.Title>
        <Dialog.Description>{result ? 'Send this file to anyone who uses OpenDoc. They add it with Import pack.' : `${chosenText(choice)} will go into one file that another workspace can import. Nothing leaves this computer.`}</Dialog.Description>
        {!result ? <form onSubmit={event => void submit(event)} aria-busy={busy} noValidate>
          <PackItems items={items} />
          <div className="create-field"><label htmlFor={`${ids}-name`}>Pack name</label>
            <Input ref={nameField} id={`${ids}-name`} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} maxLength={nameLimit} placeholder={`For example, ${fallbackId === 'pack' ? 'Studio designs' : fallbackId}`} disabled={busy} autoComplete="off" aria-invalid={Boolean(shown('name')) || undefined} aria-describedby={`${ids}-file`} />
            <p id={`${ids}-file`} className="field-hint">Saved as <bdi className="pack-file-name">output/packs/{packFileName(form, fallbackId)}</bdi> in this workspace. Leave the name empty to use “{fallbackId}”.</p>
            {shown('name') && <p className="field-error" role="alert">{shown('name')}</p>}
          </div>
          <details className="pack-more">
            <summary>More details</summary>
            <div className="create-field"><label htmlFor={`${ids}-version`}>Version</label>
              <Input id={`${ids}-version`} value={form.version} onChange={event => setForm({ ...form, version: event.target.value })} disabled={busy} autoComplete="off" inputMode="decimal" aria-invalid={Boolean(shown('version')) || undefined} aria-describedby={shown('version') ? `${ids}-version-error` : undefined} />
              {shown('version') && <p id={`${ids}-version-error`} className="field-error" role="alert">{shown('version')}</p>}
            </div>
            <div className="create-field"><label htmlFor={`${ids}-author`}>Author <span className="pack-optional">(optional)</span></label>
              <Input id={`${ids}-author`} value={form.author} onChange={event => setForm({ ...form, author: event.target.value })} maxLength={nameLimit} disabled={busy} autoComplete="off" />
            </div>
            <div className="create-field"><label htmlFor={`${ids}-license`}>License <span className="pack-optional">(optional)</span></label>
              <textarea id={`${ids}-license`} dir="auto" value={form.license} onChange={event => setForm({ ...form, license: event.target.value })} maxLength={licenseLimit} disabled={busy} aria-describedby={`${ids}-license-hint`} />
              <p id={`${ids}-license-hint`} className="field-hint">The terms you allow, in your own words. They describe your claim and don’t cover third-party fonts or artwork.</p>
            </div>
          </details>
          <p className="field-hint pack-note">The pack includes the designs’ source, the files they use, and a preview PDF of each. Check it for private content before you share it.</p>
          {!connected && <p className="field-error" role="status">Reconnect to export.</p>}
          {busy && <p className="field-hint" role="status">Preparing the pack. OpenDoc renders each design to check it, which can take a minute.</p>}
          {error && <p className="field-error" role="alert">{error}</p>}
          <div className="dialog-actions"><Dialog.Close render={<Button disabled={busy} />}>Cancel</Dialog.Close><Button className="primary" type="submit" disabled={busy || !connected || !chosenCount(choice)}>{busy ? 'Exporting…' : 'Export pack'}</Button></div>
        </form> : <div className="pack-result">
          <PackItems items={items} />
          <div className="create-field"><span id={`${ids}-where`}>Where it is</span>
            {result.relativeFile && <p className="field-hint">In this workspace: <bdi className="pack-file-name">{result.relativeFile}</bdi></p>}
            <CopyPath path={result.file} />
            {reveal && <Button className="pack-reveal" onClick={() => void Promise.resolve(reveal(result.file)).catch(() => {})}><Icon name="folder" size={16} />Show in folder</Button>}
          </div>
          <dl className="pack-facts"><div><dt>SHA-256</dt><dd><code>{result.sha256}</code></dd></div><div><dt>Previews</dt><dd>{result.previews.length} PDF {result.previews.length === 1 ? 'preview' : 'previews'} inside</dd></div></dl>
          <p className="field-hint pack-note">A pack carries code, so tell the people you send it to where it came from. Look over the designs in the galleries before you share.</p>
          <div className="dialog-actions"><Dialog.Close render={<Button className="primary" />}>Done</Dialog.Close></div>
        </div>}
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

/* Import */

type ImportState =
  | { phase: 'choose' }
  | { phase: 'inspecting'; name: string }
  | { phase: 'review'; name: string; inspection: PackInspection; installing: boolean }
  | { phase: 'done'; inspection: PackInspection; result: PackInstallResult };

function PackPreview({ url, label }: { url: string; label: string }) {
  const { pdf, error } = usePdf(url, 'preview', true, 'themes', url);
  return <figure className="pack-preview">
    <div className="pack-preview-page" aria-busy={!pdf && !error}>
      {error ? <p role="alert">Preview unavailable.</p> : pdf ? <PdfPage pdf={pdf} number={1} width={132} thumbnail /> : null}
    </div>
    <figcaption><bdi>{label}</bdi></figcaption>
  </figure>;
}
const previewLabel = (url: string) => decodeURIComponent(url.split('/').pop() ?? '').replace(/\.pdf$/i, '').replace(/^(theme|template)-/, '');

function PackFiles({ inspection }: { inspection: PackInspection }) {
  const added = new Set(inspection.added), reused = new Set(inspection.reused), conflicts = new Set(inspection.conflicts);
  const state = (path: string) => conflicts.has(path) ? 'Different here' : added.has(path) ? 'New' : reused.has(path) ? 'Already installed' : path.startsWith('previews/') ? 'Preview' : '';
  const total = inspection.files.reduce((sum, file) => sum + file.bytes, 0);
  return <details className="pack-files">
    <summary>{inspection.files.length} {inspection.files.length === 1 ? 'file' : 'files'} · {fileSize(total)} · {inspection.added.length} new{inspection.reused.length ? `, ${inspection.reused.length} already installed` : ''}</summary>
    <ul>{inspection.files.map(file => <li key={file.path} data-state={state(file.path) === 'Different here' ? 'conflict' : undefined}><bdi className="pack-file-path">{file.path}</bdi><span>{fileSize(file.bytes)}{state(file.path) && ` · ${state(file.path)}`}</span></li>)}</ul>
  </details>;
}

function ImportBody({ request, open, connected, onClose, onBusy }: { request: ImportRequest; open: boolean; connected: boolean; onClose: () => void; onBusy: (busy: boolean) => void }) {
  const [state, setState] = useState<ImportState>(request.file ? { phase: 'inspecting', name: request.file.name } : { phase: 'choose' });
  const [error, setError] = useState('');
  const [trusted, setTrusted] = useState(false);
  const [readOnly, setReadOnly] = useState<string>();
  const controller = useRef<AbortController | undefined>(undefined);
  const staged = useMemo(() => createStagedHold(discardStagedPack), []);
  const step = useRef<HTMLDivElement>(null);
  const trust = useId();

  async function inspect(file: File) {
    controller.current?.abort();
    staged.release(); // A new file after an inspection that did not install: the earlier upload is not needed any more.
    const mine = controller.current = new AbortController();
    setError(''); setTrusted(false); setState({ phase: 'inspecting', name: file.name });
    try {
      if (!isPackFileName(file.name)) throw new Error('Choose an OpenDoc pack, a file that ends in .opendoc.zip.');
      if (file.size > packSizeLimit) throw new Error('Choose a pack of at most 64 MiB.');
      const inspection = await inspectPack(file, file.name);
      if (mine.signal.aborted) { staged.abandon(inspection.stagedId); return; } // Closed or replaced while it was being checked.
      staged.hold(inspection.stagedId);
      setState({ phase: 'review', name: file.name, inspection, installing: false });
      void fetchReadOnly(mine.signal).then(state => { if (!mine.signal.aborted) setReadOnly(state?.message); }, () => {});
    } catch (failure) {
      if (mine.signal.aborted) return;
      setError((failure as Error).message); setState({ phase: 'choose' });
    }
  }
  useEffect(() => { if (request.file) void inspect(request.file); }, [request.id]);
  // Closing the dialog drops an inspection still in flight, and gives back the pack it was showing. Fire and forget.
  useEffect(() => { if (!open) { controller.current?.abort(); staged.release(); } }, [open]);
  // A new request (a file opened while this one is showing) and leaving the page replace this body: give the upload back then too.
  useEffect(() => () => { controller.current?.abort(); staged.release(); }, []);
  useEffect(() => { step.current?.focus({ preventScroll: true }); }, [state.phase]);
  // The dialog stays open while an install runs: closing would hide the result of something already under way.
  const installingNow = state.phase === 'review' && state.installing;
  useEffect(() => { onBusy(installingNow); return () => onBusy(false); }, [installingNow]);

  async function install() {
    if (state.phase !== 'review') return;
    const { inspection } = state;
    if (!canInstall(packBlockers(inspection, { readOnly, connected }), trusted, state.installing)) return;
    setError(''); setState({ ...state, installing: true });
    try { const result = await installPack(inspection.stagedId); staged.forget(); setState({ phase: 'done', inspection, result }); }
    catch (failure) {
      const message = (failure as Error).message;
      if (failure instanceof ApiError && failure.status === 404) { staged.forget(); setError(message); setTrusted(false); setState({ phase: 'choose' }); }
      else { setError(message); setState({ ...state, installing: false }); }
    }
  }

  const title = state.phase === 'done' ? (state.result.installed.length ? 'Pack installed' : 'Nothing to install') : 'Import a pack';
  const description = state.phase === 'choose' ? 'Choose a pack file from another workspace. OpenDoc checks it first, and nothing is installed until you say so.'
    : state.phase === 'inspecting' ? 'Checking the file. No code from the pack runs during the check.'
      : state.phase === 'review' ? 'Review what is inside. Nothing is installed yet.'
        : 'The new designs are in this workspace now.';
  return <>
    <Dialog.Title>{title}</Dialog.Title>
    <Dialog.Description>{description}</Dialog.Description>
    <div className="pack-step" ref={step} tabIndex={-1} aria-busy={state.phase === 'inspecting' || (state.phase === 'review' && state.installing)}>
      {state.phase === 'choose' && <div className="create-field pack-choose"><label htmlFor={`${trust}-file`}>Pack file</label>
        <input id={`${trust}-file`} className="pack-file-input" type="file" accept=".zip,application/zip" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void inspect(file); }} />
        <p className="field-hint">Packs end in .opendoc.zip. You can also drop one anywhere on this window.</p>
      </div>}
      {state.phase === 'inspecting' && <p className="pack-checking" role="status"><bdi>{state.name}</bdi><span>Checking…</span></p>}
      {state.phase === 'review' && (() => {
        const { inspection, installing } = state;
        const { manifest } = inspection;
        const blockers = packBlockers(inspection, { readOnly, connected });
        const refused = blockers.some(blocker => blocker.kind === 'incompatible' || blocker.kind === 'conflicts');
        return <>
          <header className="pack-summary"><h3 dir="auto"><bdi>{manifest.name}</bdi></h3>
            <p><bdi>Version {manifest.version}</bdi>{manifest.author && <> · by <bdi>{manifest.author}</bdi></>} · needs OpenDoc {manifest.opendocVersion}</p>
            {manifest.license && <p className="pack-license" dir="auto">License: <bdi>{manifest.license}</bdi></p>}
          </header>
          {blockers.map(blocker => <div key={blocker.kind} className="pack-blocker" role={blocker.kind === 'nothing-new' ? 'status' : 'alert'}>
            <p>{blocker.message}</p>
            {blocker.kind === 'conflicts' && <ul className="pack-conflicts">{inspection.conflicts.slice(0, 12).map(path => <li key={path}><bdi>{path}</bdi></li>)}{inspection.conflicts.length > 12 && <li>and {inspection.conflicts.length - 12} more</li>}</ul>}
          </div>)}
          <PackItems items={inspection.items} />
          {inspection.previews.length > 0 && <section aria-label="Previews from the sender"><h3>Previews from the sender</h3>
            <div className="pack-previews">{inspection.previews.map(url => <PackPreview key={url} url={url} label={previewLabel(url)} />)}</div>
            <p className="field-hint">These PDFs come from the sender. They show what the sender saw, not what is safe.</p></section>}
          <PackFiles inspection={inspection} />
          {!refused && !blockers.some(blocker => blocker.kind === 'nothing-new') && <div className="pack-trust">
            <label className="pack-trust-label"><input type="checkbox" checked={trusted} disabled={installing} onChange={event => setTrusted(event.target.checked)} aria-describedby={`${trust}-trust`} />
              <span>I trust where this pack came from, and I want OpenDoc to run its code.</span></label>
            <p id={`${trust}-trust`} className="field-hint">{inspection.trust} Installing runs the pack’s TypeScript on this computer, with your files and permissions. Tick this only for a source you know.</p>
          </div>}
          {error && <p className="field-error" role="alert">{error}</p>}
          <div className="dialog-actions">
            {refused || blockers.some(blocker => blocker.kind === 'nothing-new') ? <>
              <Button onClick={() => { staged.release(); setError(''); setState({ phase: 'choose' }); }}>Choose another pack</Button><Dialog.Close render={<Button className="primary" />}>Close</Dialog.Close>
            </> : <>
              <Dialog.Close render={<Button disabled={installing} />}>Cancel</Dialog.Close>
              <Button className="primary" disabled={!canInstall(blockers, trusted, installing)} onClick={() => void install()}>{installing ? 'Installing…' : 'Install pack'}</Button>
            </>}
          </div>
          {installing && <p className="field-hint" role="status">Installing. OpenDoc renders each design once to check it, which can take a minute.</p>}
        </>;
      })()}
      {state.phase === 'done' && <>
        {state.result.installed.length > 0 ? <>
          <p className="pack-done">Added {state.result.installed.length} {state.result.installed.length === 1 ? 'design' : 'designs'} to this workspace. They are in the galleries now; nothing needs a restart.</p>
          <ul className="pack-items pack-links">{installedLinks(state.result.installed).map(item => <li key={`${item.kind}/${item.id}`}>
            <span className="pack-kind">{item.kind === 'theme' ? 'Theme' : 'Template'}</span><a href={item.href} onClick={onClose}><bdi>{item.id}</bdi><Icon name="arrow" size={15} /></a>
          </li>)}</ul>
          {typeof state.result.verification === 'string' && <p className="field-hint">{state.result.verification}</p>}
          <p className="field-hint pack-note">Look over each new design before you use it. A successful render doesn’t show that it looks right. The pack changes no project defaults and no existing document.</p>
        </> : <p className="pack-done">{typeof state.result.verification === 'string' ? state.result.verification : 'Everything in this pack is already installed.'}</p>}
        <div className="dialog-actions"><Dialog.Close render={<Button className="primary" />}>Done</Dialog.Close></div>
      </>}
      {state.phase === 'choose' && error && <p className="field-error" role="alert">{error}</p>}
      {state.phase === 'choose' && <div className="dialog-actions"><Dialog.Close render={<Button />}>Cancel</Dialog.Close></div>}
      {state.phase === 'inspecting' && <div className="dialog-actions"><Dialog.Close render={<Button />}>Cancel</Dialog.Close></div>}
    </div>
  </>;
}

/**
 * The Import dialog. It opens when `openPackImport()` is called, with the file chosen if one was given (see packs.ts).
 * Mount it once in a view; only the first mounted copy is active, so the app shell can mount one for every view.
 * While active it also takes a pack dropped on the window and a pack the desktop shell delivers (`onImportPack`).
 */
export function PackImportHost({ connected = true }: { connected?: boolean }) {
  const me = useRef(Symbol('pack-import-host'));
  const active = useSyncExternalStore(importHosts.subscribe, () => importHosts.active() === me.current);
  const request = useSyncExternalStore(importEntry.subscribe, importEntry.get);
  const last = useRef<ImportRequest | null>(null);
  const [dragging, setDragging] = useState(false);
  const [locked, setLocked] = useState(false);
  if (request) last.current = request;
  useEffect(() => importHosts.register(me.current), []);
  useEffect(() => {
    if (!active) return;
    const stopBridge = packBridge()?.onImportPack?.(file => openPackImport(file));
    const files = (event: DragEvent) => Boolean(event.dataTransfer && [...event.dataTransfer.types].includes('Files'));
    // A drop zone elsewhere in the app calls preventDefault first; leave those drags to it.
    const over = (event: DragEvent) => { if (event.defaultPrevented || !files(event)) return; event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; setDragging(true); };
    const leave = (event: DragEvent) => { if (!event.relatedTarget) setDragging(false); };
    const drop = (event: DragEvent) => {
      setDragging(false);
      if (event.defaultPrevented || !files(event)) return;
      const pack = [...event.dataTransfer!.files].find(file => isPackFileName(file.name));
      if (!pack) return;
      event.preventDefault(); openPackImport(pack);
    };
    window.addEventListener('dragover', over); window.addEventListener('dragleave', leave); window.addEventListener('drop', drop);
    return () => { stopBridge?.(); setDragging(false); window.removeEventListener('dragover', over); window.removeEventListener('dragleave', leave); window.removeEventListener('drop', drop); };
  }, [active]);
  if (!active) return null;
  const shown = request ?? last.current;
  return <>
    {dragging && <div className="pack-drop" aria-hidden="true"><div><Icon name="download" size={28} /><strong>Drop a pack to import it</strong></div></div>}
    {shown && <Dialog.Root open={Boolean(request)} onOpenChange={open => { if (!open && !locked) importEntry.close(); }}>
      <Dialog.Portal><Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="help-dialog create-dialog pack-dialog pack-import-dialog">
          <Dialog.Close render={<Button className="icon-button modal-close" aria-label="Close import dialog" disabled={locked} />}><Icon name="close" /></Dialog.Close>
          <ImportBody key={shown.id} request={shown} open={Boolean(request)} connected={connected} onClose={() => importEntry.close()} onBusy={setLocked} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>}
  </>;
}
