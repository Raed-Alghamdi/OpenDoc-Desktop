import type { Edition } from './workspace';

/**
 * Every command the `opendoc` CLI dispatches, in one list: what `opendoc help --json` prints.
 * Each command keeps its own argument parser (they are the source of truth for what is accepted),
 * so tests/cli-registry.test.ts runs every option listed here through the real parser, in both
 * directions, to stop the two drifting apart. `--json` and `--workspace <folder>` apply to every
 * command and are listed once, under `globalOptions`, not in each command.
 */

export interface OptionSpec { name: string; type: 'boolean' | 'string'; repeatable: boolean; required: boolean; description: string }
export interface ArgSpec { name: string; required: boolean; repeatable: boolean }
export interface CommandSpec {
  /** The command and its subcommands, as typed: `["comments", "add"]`. */
  path: string[];
  summary: string;
  /** Positional arguments in order. `required` means the command refuses to run without it. */
  args: ArgSpec[];
  options: OptionSpec[];
  /** Whether `--json` gives structured output. Every command does. */
  json: true;
}

/** What the registry holds: a command plus the editions it exists in (all, when omitted). Arguments are written as `<required>`, `[optional]` and `<repeatable...>`. */
interface Entry extends Omit<CommandSpec, 'args' | 'options' | 'json'> {
  args?: string[];
  options?: OptionSpec[];
  editions?: Edition[];
}

const parseArg = (text: string): ArgSpec => {
  const required = text.startsWith('<');
  const repeatable = text.endsWith('...>') || text.endsWith('...]');
  return { name: text.slice(1, text.length - (repeatable ? 4 : 1)), required, repeatable };
};
type Extra = { required?: boolean; repeatable?: boolean };
const flag = (name: string, description: string, extra: Extra = {}): OptionSpec => ({ name, type: 'boolean', repeatable: false, required: false, description, ...extra });
const text = (name: string, description: string, extra: Extra = {}): OptionSpec => ({ name, type: 'string', repeatable: false, required: false, description, ...extra });

const tagKinds = 'document, presentation, theme, or template';

export const commandRegistry: Entry[] = [
  { path: ['help'], summary: 'Print the commands, or with --json the catalogue of every command, its arguments and options.' },
  { path: ['init'], summary: 'Create a workspace and open OpenDoc.', args: ['[folder]'], editions: ['normal'], options: [
    flag('no-start', 'Create the workspace without starting OpenDoc.'),
    flag('no-open', 'Start OpenDoc without opening a browser.'),
  ] },
  { path: ['init'], summary: 'Create a workspace without a server.', args: ['<folder>'], editions: ['headless'] },
  { path: ['start'], summary: 'Start the workspace\'s installed runtime and open it in the browser.', args: ['[folder]'], editions: ['normal'], options: [
    flag('no-open', 'Do not open a browser.'),
  ] },
  { path: ['create'], summary: 'Create a document or presentation, or list the starters with --list.', args: ['[id]'], options: [
    text('project', 'Project to create the document in. Required to create.'),
    text('title', 'Document title. Required to create.'),
    text('theme', 'Theme ID.'),
    text('format', 'document or presentation.'),
    text('template', 'Create from a reusable template ID.'),
    text('starter', 'Create from an example starter.'),
    flag('list', 'List the starters instead of creating.'),
  ] },
  { path: ['projects', 'list'], summary: 'List projects and their theme defaults.' },
  { path: ['projects', 'create'], summary: 'Create a project.', args: ['<id>'], options: [
    text('name', 'Project name.', { required: true }),
    text('theme', 'Default theme for new documents and presentations.'),
    text('document-theme', 'Default theme for new documents.'),
    text('presentation-theme', 'Default theme for new presentations.'),
  ] },
  { path: ['projects', 'update'], summary: 'Rename a project or change its theme defaults.', args: ['<id>'], options: [
    text('name', 'New project name.'),
    text('theme', 'Default theme for both formats, or none to clear it.'),
    text('document-theme', 'Default theme for new documents, or none to clear it.'),
    text('presentation-theme', 'Default theme for new presentations, or none to clear it.'),
  ] },
  { path: ['projects', 'assign'], summary: 'Move a document into a project.', args: ['<document-id>', '<project-id>'] },
  { path: ['projects', 'delete'], summary: 'Delete an empty project.', args: ['<project-id>'] },
  { path: ['documents', 'rename'], summary: 'Change the name OpenDoc shows for a document.', args: ['<id>', '<title...>'] },
  { path: ['documents', 'duplicate'], summary: 'Copy a document into a new one with its own history.', args: ['<id>'], options: [
    text('id', 'ID of the copy.'),
    text('title', 'Name of the copy.'),
    text('project', 'Project for the copy; the original\'s project by default.'),
  ] },
  { path: ['documents', 'delete'], summary: 'Move a document to Trash and print its restore command.', args: ['<id>'] },
  { path: ['documents', 'trash'], summary: 'List deleted documents, most recent first.' },
  { path: ['documents', 'restore'], summary: 'Restore a document from Trash.', args: ['<restore-id>'] },
  { path: ['templates', 'list'], summary: 'List templates.', options: [
    text('type', 'Only templates of this type.'),
    text('language', 'english, arabic, or bilingual.'),
    text('tag', 'Only templates with this tag.', { repeatable: true }),
  ] },
  { path: ['templates', 'inspect'], summary: 'Show a template\'s descriptor, paths and guide.', args: ['<id>'] },
  { path: ['templates', 'check'], summary: 'Render a template\'s preview and report issues.', args: ['<id>'] },
  { path: ['templates', 'preview'], summary: 'Write a template\'s preview PDF.', args: ['<id>'] },
  { path: ['themes', 'list'], summary: 'List themes.', options: [
    text('folder', 'Only themes in this folder, or none for themes outside every folder.'),
    text('tag', 'Only themes with this tag.', { repeatable: true }),
    text('language', 'english, arabic, or bilingual.'),
  ] },
  { path: ['themes', 'inspect'], summary: 'Show a theme\'s description, palette, paths and guide size.', args: ['<id>'] },
  { path: ['themes', 'check'], summary: 'Render a theme\'s preview and report issues.', args: ['<id>'] },
  { path: ['themes', 'preview'], summary: 'Write a theme\'s preview PDF.', args: ['<id>'] },
  { path: ['themes', 'folders', 'list'], summary: 'List theme folders and the themes in them.' },
  { path: ['themes', 'folders', 'create'], summary: 'Create a theme folder.', args: ['<name>'] },
  { path: ['themes', 'folders', 'rename'], summary: 'Rename a theme folder.', args: ['<name>', '<new-name>'] },
  { path: ['themes', 'folders', 'delete'], summary: 'Delete a theme folder; its themes become unfiled.', args: ['<name>'] },
  { path: ['themes', 'assign'], summary: 'File a theme in a folder, or none to unfile it.', args: ['<theme-id>', '<folder>'] },
  { path: ['themes', 'tags'], summary: 'Show or change a theme\'s tags (kept for scripts; opendoc tags covers every kind).', args: ['<theme-id>'], options: [
    text('set', 'Replace the tags with this comma-separated list.'),
    text('add', 'Add this tag.', { repeatable: true }),
    text('remove', 'Remove this tag.', { repeatable: true }),
  ] },
  { path: ['tags', 'list'], summary: 'List the types, statuses, languages and custom tags in use, with counts.', options: [
    text('kind', `Count one kind only: ${tagKinds}.`),
  ] },
  { path: ['tags', 'show'], summary: 'Show one item\'s type, status, language and tags.', args: ['<kind>', '<id>'] },
  { path: ['tags', 'add'], summary: 'Add types or custom tags to an item.', args: ['<kind>', '<id>', '<tag...>'] },
  { path: ['tags', 'remove'], summary: 'Remove tags from an item.', args: ['<kind>', '<id>', '<tag...>'] },
  { path: ['tags', 'set'], summary: 'Replace an item\'s tags.', args: ['<kind>', '<id>', '[tag...]'] },
  { path: ['tags', 'status'], summary: 'Show or set a document\'s status: draft, in-review, final or archived.', args: ['<document-id>', '[status]'], options: [
    flag('clear', 'Clear the status.'),
  ] },
  { path: ['tags', 'find'], summary: 'Find documents, presentations, themes and templates by tag, type, status or language.', args: ['[tag...]'], options: [
    text('kind', `Only this kind: ${tagKinds}.`),
    text('type', 'Only this type.'),
    text('status', 'Only this status, or none.'),
    text('language', 'english, arabic, or bilingual.'),
  ] },
  { path: ['tags', 'create'], summary: 'Create a custom tag.', args: ['<custom-tag>'] },
  { path: ['tags', 'delete'], summary: 'Delete a custom tag.', args: ['<custom-tag>'], options: [
    flag('untag', 'Also remove it from the items that carry it.'),
  ] },
  { path: ['assets', 'list'], summary: 'List logos and fonts.', args: ['[kind]'], options: [
    flag('archived', 'List archived assets.'),
  ] },
  { path: ['assets', 'inspect'], summary: 'Show an asset and its current revision.', args: ['<kind>', '<id>'], options: [
    text('revision', 'Inspect this revision.'),
  ] },
  { path: ['assets', 'import', 'logo'], summary: 'Import a logo from an SVG or PNG file.', options: [
    text('file', 'SVG or PNG file.', { required: true }),
    text('name', 'Logo name.', { required: true }),
    text('id', 'Logo ID.'),
    text('description', 'Guidance on using it.'),
    text('variation-name', 'Name of the first variation.'),
    text('variation-description', 'When to use the first variation.'),
  ] },
  { path: ['assets', 'import', 'font'], summary: 'Import a font family from TTF or OTF files.', options: [
    text('file', 'TTF or OTF face.', { required: true, repeatable: true }),
    text('id', 'Font ID.'),
    text('name', 'Font name.'),
    text('description', 'Guidance on using it.'),
  ] },
  { path: ['assets', 'revise'], summary: 'Change an asset\'s metadata from a JSON file.', args: ['<kind>', '<id>'], options: [
    text('metadata', 'JSON file with expectedRevision and the fields to change.', { required: true }),
  ] },
  { path: ['assets', 'add-variation'], summary: 'Add a variation to a logo.', args: ['<logo-id>'], options: [
    text('file', 'SVG or PNG file.', { required: true }),
    text('name', 'Variation name.', { required: true }),
    text('expected-revision', 'The revision this change is based on.', { required: true }),
    text('id', 'Variation ID.'),
    text('description', 'When to use it.'),
    text('replace', 'Replace this variation.'),
  ] },
  { path: ['assets', 'add-faces'], summary: 'Add faces to a font family.', args: ['<font-id>'], options: [
    text('file', 'TTF or OTF face.', { required: true, repeatable: true }),
    text('expected-revision', 'The revision this change is based on.', { required: true }),
  ] },
  { path: ['assets', 'archive'], summary: 'Archive an asset.', args: ['<kind>', '<id>'], options: [
    text('expected-revision', 'The revision this change is based on.', { required: true }),
    flag('clear-defaults', 'Also clear it from theme defaults.'),
  ] },
  { path: ['assets', 'restore'], summary: 'Restore an archived asset.', args: ['<kind>', '<id>'], options: [
    text('expected-revision', 'The revision this change is based on.', { required: true }),
  ] },
  { path: ['assets', 'defaults'], summary: 'Show or change a theme\'s default assets.', args: ['<theme-id>'], options: [
    text('metadata', 'JSON file with the complete defaults.'),
    text('expected-revision', 'The revision this change is based on; with --metadata.'),
  ] },
  { path: ['assets', 'bind'], summary: 'Bind an asset to a document\'s logo, body font or heading font.', args: ['<document-id>', '<slot>', '<asset-id>'], options: [
    text('revision', 'Bind this revision.'),
    text('variation', 'Logo variation ID.'),
    text('name', 'Name of the logo binding.'),
  ] },
  { path: ['assets', 'unbind'], summary: 'Remove a binding from a document.', args: ['<document-id>', '<slot>'], options: [
    text('name', 'Name of the logo binding.'),
  ] },
  { path: ['media', 'list'], summary: 'List the media of one document, or of every document.', args: ['[document]'] },
  { path: ['media', 'import'], summary: 'Import an image into a document.', args: ['<document>', '<media-id>'], options: [
    text('file', 'PNG or JPEG file.', { required: true }),
    text('title', 'Title.', { required: true }),
    text('description', 'Description.', { required: true }),
    text('kind', 'photo, illustration, chart, diagram, or image.'),
  ] },
  { path: ['media', 'record'], summary: 'Record the generation inputs of reviewed media.', args: ['<document>', '<media-id>'] },
  { path: ['media', 'check'], summary: 'Report whether recorded media is fresh, stale or unrecorded.', args: ['<document>', '<media-id>'] },
  { path: ['comments', 'list'], summary: 'List a document\'s comments.', args: ['<doc>'], options: [
    flag('anchors', 'Check each comment against the current render.'),
    flag('deleted', 'List only comments deleted in the last 90 days.'),
  ] },
  { path: ['comments', 'resolve'], summary: 'Resolve a comment.', args: ['<doc>', '<comment-id>'] },
  { path: ['comments', 'reopen'], summary: 'Reopen a resolved comment.', args: ['<doc>', '<comment-id>'] },
  { path: ['comments', 'delete'], summary: 'Delete a comment; it stays restorable for 90 days.', args: ['<doc>', '<comment-id>'] },
  { path: ['comments', 'restore'], summary: 'Restore a deleted comment.', args: ['<doc>', '<comment-id>'] },
  { path: ['comments', 'add'], summary: 'Add a comment on a block, or on exact words in it, or on several places.', args: ['<doc>', '<block-id>', '<text...>'], options: [
    text('phrase', 'Anchor the comment to these exact words in the block.'),
    text('target', 'The text field, when the words appear in more than one; with --phrase.'),
    text('also', 'Put the comment on another block too. Repeat for each place; a block once.', { repeatable: true }),
    text('also-phrase', 'Anchor the --also just before it to these exact words. Needs OpenDoc stopped.', { repeatable: true }),
    text('also-target', 'The text field for that --also-phrase, when the words appear in more than one.', { repeatable: true }),
  ] },
  { path: ['comments', 'edit'], summary: 'Replace the text of an open or resolved comment.', args: ['<doc>', '<comment-id>', '<text...>'], options: [
    text('expected-version', 'Refuse the edit when the comment is no longer at this version.'),
  ] },
  { path: ['history', 'list'], summary: 'List a document\'s versions, newest first.', args: ['<doc>'] },
  { path: ['history', 'show'], summary: 'Show what a version changed compared with the current source.', args: ['<doc>', '<version>'] },
  { path: ['history', 'block'], summary: 'Show one block\'s earlier versions.', args: ['<doc>', '<block-id>'] },
  { path: ['history', 'restore'], summary: 'Restore a version, one block, or one section.', args: ['<doc>', '<version>'], options: [
    text('block', 'Restore only this block\'s own content.'),
    text('section', 'Restore this block together with everything inside it.'),
  ] },
  { path: ['packs', 'export'], summary: 'Export themes and templates as a pack file.', options: [
    text('theme', 'Theme to include.', { repeatable: true }),
    text('template', 'Template to include.', { repeatable: true }),
    text('include', 'Additional workspace asset file or folder.', { repeatable: true }),
    text('id', 'Pack ID.'),
    text('name', 'Pack display name.'),
    text('pack-version', 'Pack version; default 1.0.0.'),
    text('author', 'Attribution.'),
    text('license', 'Redistribution terms.'),
    text('output', 'Output file, ending in .opendoc.zip.'),
  ] },
  { path: ['packs', 'inspect'], summary: 'Inspect a pack without running its code.', args: ['<file>'], options: [
    text('previews', 'Write the pack\'s preview files to this new folder.'),
  ] },
  { path: ['packs', 'install'], summary: 'Check or install a pack\'s themes and templates.', args: ['<file>'], options: [
    flag('dry-run', 'Report what would be installed.'),
    flag('trust', 'Install it; only for an author you trust.'),
  ] },
  { path: ['export'], summary: 'Export documents as PDF or editable PowerPoint.', args: ['[document-id...]'], options: [
    flag('all', 'Export every document.'),
    text('format', 'pdf or pptx; default pdf.'),
  ] },
  { path: ['export', 'history', 'list'], summary: 'List a document\'s earlier exports, newest first.', args: ['<doc>'] },
  { path: ['export', 'history', 'delete'], summary: 'Delete an earlier export and its file.', args: ['<export-id>'] },
  { path: ['export', 'history', 'restore'], summary: 'Undo the deletion of an earlier export.', args: ['<export-id>'] },
  { path: ['export', 'history', 'reveal'], summary: 'Print an earlier export\'s file path.', args: ['<export-id>'], options: [
    flag('open', 'Also show the file in the system file manager.'),
  ] },
  { path: ['review'], summary: 'Generate page images, text and review issues for a document, theme or template.', args: ['[document-id]'], options: [
    flag('export', 'Also typecheck and prepare PDF and, for presentations, editable PPTX from one render.'),
    text('theme', 'Review this theme instead of a document.'),
    text('template', 'Review this template instead of a document.'),
  ] },
  { path: ['check'], summary: 'Typecheck workspace documents, themes and templates.' },
  { path: ['update'], summary: 'Check for, or explicitly install, a compatible OpenDoc version.', options: [
    flag('check', 'Only report what is available.'),
    text('version', 'Install this exact stable version, including a breaking update or downgrade.'),
  ] },
  { path: ['context'], summary: 'Show what the OpenDoc app has selected.', editions: ['normal'] },
  { path: ['status'], summary: 'Show whether OpenDoc is running for this workspace.', editions: ['normal'] },
  { path: ['stop'], summary: 'Stop the OpenDoc service started with opendoc start; it does not stop opendoc-desktop.', editions: ['normal'] },
];

/** Options of every command: where the CLI reads them is main.ts, not each command's parser. */
export const globalOptions: OptionSpec[] = [
  { name: 'json', type: 'boolean', repeatable: false, required: false, description: 'Structured output. A failure prints {"ok": false, "error", "code"} on stdout.' },
  { name: 'workspace', type: 'string', repeatable: false, required: false, description: 'The workspace folder; otherwise found from the current folder or an ancestor.' },
];

/** The first word of every command, as typed. */
export const commandNames = [...new Set(commandRegistry.map(entry => entry.path[0]))];

/** The commands that exist in this edition, as `help --json` lists them. */
export function commandsFor(edition: Edition): CommandSpec[] {
  const commands: CommandSpec[] = [];
  for (const entry of commandRegistry) {
    if (entry.editions && !entry.editions.includes(edition)) continue;
    commands.push({ path: [...entry.path], summary: entry.summary, args: (entry.args ?? []).map(parseArg), options: (entry.options ?? []).map(option => ({ ...option })), json: true });
  }
  return commands;
}

/** The body of `opendoc help --json`. */
export function helpCatalogue(version: string, edition: Edition) {
  return { version, edition, commands: commandsFor(edition), globalOptions };
}
