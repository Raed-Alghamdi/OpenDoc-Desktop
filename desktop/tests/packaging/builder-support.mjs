// Shared by the packaging tests and scripts: the parsed electron-builder config, an Info.plist reader, and the rule for the macOS
// design pack document type. js-yaml and plist are electron-builder's own dependencies, reached through it so the desktop
// package needs no new dependency.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const desktop = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

const fromBuilder = (name) => {
  const here = createRequire(path.join(desktop, 'package.json'));
  const builder = createRequire(here.resolve('electron-builder'));
  return createRequire(builder.resolve('app-builder-lib'))(name);
};

export const builderConfig = () => fromBuilder('js-yaml').load(readFileSync(path.join(desktop, 'electron-builder.yml'), 'utf8'));
export const readPlist = (file) => fromBuilder('plist').parse(readFileSync(file, 'utf8'));

export const PACK_EXTENSION = 'opendoc.zip';
export const PACK_MIME_TYPE = 'application/x-opendoc-pack';

// What Info.plist must say about design packs, and what it must never say. macOS matches a file on its last extension, so `zip` is
// what Launch Services sees on a `name.opendoc.zip`; the app must not claim that (or any broad type a ZIP file conforms to), or it
// would compete with Archive Utility for every ZIP file. Returns a list of problems (empty when the plist is right).
export function documentTypeProblems(info, appId) {
  const problems = [];
  const ours = `${appId}.pack`;
  const documentTypes = info.CFBundleDocumentTypes ?? [];
  const exported = info.UTExportedTypeDeclarations ?? [];
  const lower = (list) => [].concat(list ?? []).map((value) => String(value).toLowerCase());

  if (!documentTypes.some((entry) => lower(entry.LSItemContentTypes).includes(ours.toLowerCase()))) problems.push(`no document type lists ${ours}`);
  for (const entry of documentTypes) {
    const label = JSON.stringify(entry.CFBundleTypeName ?? '(unnamed)');
    for (const type of lower(entry.LSItemContentTypes)) if (type !== ours.toLowerCase()) problems.push(`document type ${label} lists ${type}; only ${ours} is ours to claim`);
    for (const extension of lower(entry.CFBundleTypeExtensions)) if (extension !== PACK_EXTENSION) problems.push(`document type ${label} lists the extension ${extension}`);
    for (const mime of lower(entry.CFBundleTypeMIMETypes)) if (mime !== PACK_MIME_TYPE) problems.push(`document type ${label} lists the MIME type ${mime}`);
    if (lower(entry.CFBundleTypeOSTypes).length) problems.push(`document type ${label} lists legacy OS types`);
  }

  const declaration = exported.find((entry) => entry.UTTypeIdentifier === ours);
  if (!declaration) problems.push(`${ours} is not exported`);
  else {
    const tags = declaration.UTTypeTagSpecification ?? {};
    if (!lower(tags['public.filename-extension']).includes(PACK_EXTENSION)) problems.push(`${ours} does not carry the extension ${PACK_EXTENSION}`);
    if (!lower(tags['public.mime-type']).includes(PACK_MIME_TYPE)) problems.push(`${ours} does not carry the MIME type ${PACK_MIME_TYPE}`);
    if (!lower(declaration.UTTypeConformsTo).includes('public.zip-archive')) problems.push(`${ours} should conform to public.zip-archive, so archive tools still open a pack`);
  }
  for (const entry of exported) {
    const tags = entry.UTTypeTagSpecification ?? {};
    for (const extension of lower(tags['public.filename-extension'])) if (extension === 'zip') problems.push(`${entry.UTTypeIdentifier} exports the plain extension zip`);
    for (const mime of lower(tags['public.mime-type'])) if (mime === 'application/zip') problems.push(`${entry.UTTypeIdentifier} exports application/zip`);
  }
  return problems;
}
