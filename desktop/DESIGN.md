---
name: OpenDoc Desktop
description: Quiet grayscale workspace chrome with one blue accent, wrapped in a few plain shell windows for choosing a workspace, upgrades, crashes and AI app connections.
colors:
  background: "#f8f8f8"
  surface: "#f2f2f2"
  surface-raised: "#ffffff"
  surface-alt: "#eeeeee"
  reader-canvas: "#e5e5e5"
  navigation-surface: "#e2e2e2"
  control-hover: "#eaeaea"
  control-active: "#e2e2e2"
  selected-surface: "#e8e8e8"
  ink: "#262626"
  muted: "#666666"
  navigation-muted: "#5e5e5e"
  placeholder: "#707070"
  line: "#dedede"
  line-strong: "#b8b8b8"
  control-line: "#8c8c8c"
  accent: "#2777c1"
  accent-hover: "#226aab"
  accent-active: "#1d5b93"
  accent-ink: "#1d5b93"
  accent-ink-hover: "#174d7e"
  on-accent: "#ffffff"
  selection: "#d2e4f5"
  destructive: "#b42318"
  destructive-hover: "#9e1f15"
  destructive-active: "#8a1b12"
  on-destructive: "#ffffff"
  status-final: "#1c7c37"
  badge-fill: "#caface"
  badge-ink: "#0e762c"
  notice-surface: "#eeeeee"
  notice-ink: "#424242"
  error-surface: "#e8e8e8"
  error-ink: "#242424"
  error-line: "#777777"
  inverse-surface: "#292929"
  inverse-ink: "#ffffff"
  backdrop: "#00000045"
  shell-ink: "#1c1e21"
  shell-muted: "#5d6470"
  shell-line: "#d9dde3"
  shell-paper: "#ffffff"
  shell-wash: "#f4f5f7"
  shell-accent: "#1f5fbf"
  shell-on-accent: "#ffffff"
  shell-danger: "#a3262a"
typography:
  page-title:
    fontFamily: "OpenDoc UI, OpenDoc UI Arabic, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: "26px"
    letterSpacing: "-0.01em"
  title:
    fontFamily: "OpenDoc UI, OpenDoc UI Arabic, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "16px"
    fontWeight: 500
    lineHeight: "22px"
  label:
    fontFamily: "OpenDoc UI, OpenDoc UI Arabic, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: "18px"
  body:
    fontFamily: "OpenDoc UI, OpenDoc UI Arabic, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "20px"
  menu:
    fontFamily: "OpenDoc UI, OpenDoc UI Arabic, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: "18px"
  caption:
    fontFamily: "OpenDoc UI, OpenDoc UI Arabic, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
  tag:
    fontFamily: "OpenDoc UI, OpenDoc UI Arabic, -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: "15px"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "1.5"
  shell-title:
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: "1.25"
  shell-body:
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: "1.5"
  shell-eyebrow:
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: "1.5"
    letterSpacing: "0.06em"
  shell-hint:
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "1.5"
  shell-mono:
    fontFamily: "ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "1.5"
rounded:
  sm: "4px"
  tooltip: "5px"
  control: "6px"
  panel: "8px"
  dialog: "12px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  gap: "10px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
components:
  button-default:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "6px 10px"
    height: "32px"
  button-default-hover:
    backgroundColor: "{colors.control-hover}"
  button-default-active:
    backgroundColor: "{colors.control-active}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "6px 10px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-primary-active:
    backgroundColor: "{colors.accent-active}"
  button-primary-disabled:
    backgroundColor: "{colors.control-active}"
    textColor: "{colors.muted}"
  button-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.on-destructive}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "6px 10px"
    height: "32px"
  button-destructive-hover:
    backgroundColor: "{colors.destructive-hover}"
  button-text:
    backgroundColor: "transparent"
    textColor: "{colors.accent-ink}"
    typography: "{typography.label}"
    padding: "3px 0"
  field:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "5px 10px"
    height: "32px"
  menu-popup:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "4px"
    width: "184px"
  menu-item:
    textColor: "{colors.ink}"
    typography: "{typography.menu}"
    rounded: "{rounded.sm}"
    padding: "5px 8px"
    height: "32px"
  menu-item-highlighted:
    backgroundColor: "{colors.control-hover}"
  tooltip:
    backgroundColor: "{colors.inverse-surface}"
    textColor: "{colors.inverse-ink}"
    typography: "{typography.tag}"
    rounded: "{rounded.tooltip}"
    padding: "6px 9px"
  dialog:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.dialog}"
    padding: "36px"
    width: "490px"
  info-bar:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted}"
    typography: "{typography.body}"
    rounded: "{rounded.panel}"
    padding: "12px 16px"
  status-pill:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "0 7px"
    height: "20px"
  asset-badge:
    backgroundColor: "{colors.badge-fill}"
    textColor: "{colors.badge-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "2px 6px"
    height: "20px"
  sidebar-row-selected:
    backgroundColor: "{colors.selected-surface}"
    textColor: "{colors.accent-ink}"
    typography: "{typography.menu}"
    rounded: "{rounded.control}"
    height: "32px"
  shell-card:
    backgroundColor: "{colors.shell-paper}"
    textColor: "{colors.shell-ink}"
    typography: "{typography.shell-body}"
    rounded: "{rounded.dialog}"
    padding: "32px"
    width: "640px"
  shell-button:
    backgroundColor: "{colors.shell-paper}"
    textColor: "{colors.shell-ink}"
    typography: "{typography.shell-body}"
    rounded: "{rounded.panel}"
    padding: "8px 14px"
  shell-button-primary:
    backgroundColor: "{colors.shell-accent}"
    textColor: "{colors.shell-on-accent}"
    typography: "{typography.shell-body}"
    rounded: "{rounded.panel}"
    padding: "8px 14px"
  shell-list-row:
    backgroundColor: "{colors.shell-paper}"
    textColor: "{colors.shell-ink}"
    typography: "{typography.shell-body}"
    padding: "12px 14px"
  shell-list-row-hover:
    backgroundColor: "{colors.shell-wash}"
  shell-badge:
    backgroundColor: "transparent"
    textColor: "{colors.shell-muted}"
    rounded: "{rounded.pill}"
    padding: "1px 8px"
---

# Design System: OpenDoc Desktop

OpenDoc Desktop shows two visual surfaces, and this file records both as they are in the code today.

1. **The workspace UI** fills the main window. It is OpenDoc's own web interface (the upstream code in `src/app/`), loaded unchanged by the desktop app. Its tokens live in `src/app/colors.css`, `src/app/ui/ui.css` and `src/app/ui/fonts.css`. The desktop package defines none of them. Dialogs for exporting and importing design packs belong here too (`src/app/packs.css`, `src/app/PackDialogs.tsx`).
2. **The shell pages** are the desktop package's own small windows: the workspace chooser, the upgrade status and result pages, the crash page, the workspace backups list and "Connect your AI apps". They are plain HTML in `desktop/src/renderer/` and share one stylesheet, `desktop/src/renderer/shell.css`. They do not import the workspace UI's CSS, so they have their own palette, their own type and their own radii. The About box and the menus are native operating system UI and carry no styling from this file.

In the token lists above, names with no prefix belong to the workspace UI, and names that start with `shell-` belong to the shell pages. The same role often has two different values (for example the accent blue); the shell pages are an independent, simpler system, not a copy of the workspace UI. A new screen should pick the surface it belongs to and use only that surface's tokens.

## Overview

**Creative North Star: "TODO(raed): pick a name for the whole system"**

TODO(raed): two or three sentences on the personality, in your words. What the code shows, to build on: the workspace UI is a dense, neutral gray tool at 13px with one blue accent, compact 32px controls, hairline borders, a sidebar at 240px, and fully supported light, dark and increased contrast appearances. Documents (PDF pages) keep their own colors and never follow the app appearance. The shell pages are a calmer, larger and plainer set of single cards, centered on a pale wash, with system fonts.

TODO(raed): any visual anti-reference to record (none is stated in the code).

**Key Characteristics:**
- The workspace UI is grayscale chrome with one blue accent, so that a document's own colors stand out.
- 13px body and control text, 32px controls (40px on touch screens), 6px control corners.
- Light, dark and system appearance everywhere, with a stronger increased-contrast mode in the workspace UI.
- English and Arabic side by side: Geist for Latin, Noto Naskh Arabic for Arabic letters, `dir="auto"` on user text, logical properties, and a layout that is never mirrored.
- Shell pages are a separate, smaller system: system fonts, a 15px base size, one white card on a pale wash.
- The brand is black and white: the wordmark and the app icon (a dark page with a folded corner and the wordmark's O) use ink `#21211F` and white only. The blue is an interface color, not a brand color.

## Colors

Workspace palette: a grayscale scale from a near-white background down to a charcoal ink, with a single mid blue for action, focus and selection, and a deeper blue for small links and labels. Green and red appear only for status and destruction. All values below are the light appearance; dark and increased-contrast values follow in the tables.

### Primary
- **TODO(raed): name** (#2777c1): the accent. Primary buttons, the focus ring, checkboxes, selection outlines and drop targets. Hover `#226aab`, pressed `#1d5b93`.
- **TODO(raed): name** (#1d5b93): the accent as text (`accent-ink`): small interactive labels, links, the selected sidebar row, the selected select item. Hover `#174d7e`. Used instead of the plain accent whenever the blue sits on a gray surface as text, for contrast.

### Secondary
- **TODO(raed): name** (#1c7c37): the "Final" document status (`status-final`). Badges use a pale green fill `#caface` with dark green text `#0e762c`.

### Tertiary
- **TODO(raed): name** (#b42318): destructive actions only (`destructive`), the fill of a button that deletes something. Error and notice messages are deliberately not red in the workspace UI: they use gray surfaces (`error-surface`, `notice-surface`) with wording that names the problem, so that color is never the only signal.

### Neutral
- **TODO(raed): name** (#f8f8f8): page background. Sidebar and bars sit one step down on `#f2f2f2` (`surface`), the alternate wells on `#eeeeee`, the sidebar's navigation surface on `#e2e2e2`, and the reader canvas on `#e5e5e5` so off-white pages keep a visible edge.
- **TODO(raed): name** (#ffffff): raised surfaces: fields, default buttons, popups, dialogs and document paper.
- **TODO(raed): name** (#262626): text (`ink`). Secondary text is `#666666` (`muted`), placeholders `#707070`.
- **TODO(raed): name** (#dedede): hairline borders (`line`). Stronger dividers `#b8b8b8`, and form controls draw their edge in `#8c8c8c` (`control-line`) so a field is clearly a field.
- Hover, pressed and selected states are small gray steps: `#eaeaea`, `#e2e2e2`, `#e8e8e8`. Text selection uses a pale blue `#d2e4f5`.
- Tooltips invert the scheme: `#292929` with white text (`inverse-surface`, `inverse-ink`). The dimmed backdrop behind a dialog is `#00000045` (about 27 percent black).

### Dark appearance (workspace UI)

Chosen with the `data-appearance="dark"` attribute on the root, set by the app from the user's Light, Dark or System choice (`src/app/colors.css`). The sidecar file carries these as extension values; they are listed here for readers.

| Role | Light | Dark |
|---|---|---|
| `background` | #f8f8f8 | #181818 |
| `surface` | #f2f2f2 | #202020 |
| `surface-raised` | #ffffff | #262626 |
| `surface-alt` | #eeeeee | #121212 |
| `navigation-surface` | #e2e2e2 | #282828 |
| `ink` | #262626 | #f0f0f0 |
| `muted` | #666666 | #a6a6a6 |
| `line` | #dedede | #393939 |
| `line-strong` | #b8b8b8 | #626262 |
| `control-line` | #8c8c8c | #898989 |
| `accent` | #2777c1 | #8ac4f2 |
| `accent-ink` | #1d5b93 | #9acbf2 |
| `on-accent` | #ffffff | #132638 |
| `destructive` | #b42318 | #ff9285 |
| `status-final` | #1c7c37 | #7ccf91 |
| `selection` | #d2e4f5 | #345575 |
| `inverse-surface` | #292929 | #e2e2e2 |

Increased contrast (`prefers-contrast: more`) pushes ink to `#000000` (white in dark), `line` to `#8c8c8c` (`#858585` in dark), and darkens `accent-ink` to `#123f68` (`#cce6ff` in dark).

### Shell palette

The shell pages use a separate, cooler set of seven values, defined at the top of `desktop/src/renderer/shell.css`. They follow the system light or dark setting through `prefers-color-scheme`.

| Role | Light | Dark |
|---|---|---|
| `shell-ink` text | #1c1e21 | #e8eaed |
| `shell-muted` secondary text | #5d6470 | #a0a7b3 |
| `shell-line` borders | #d9dde3 | #3a3f47 |
| `shell-paper` the card | #ffffff | #1d2026 |
| `shell-wash` the page behind the card, hover fill | #f4f5f7 | #15181c |
| `shell-accent` primary button, links, focus ring, checked state | #1f5fbf | #6ea0ee |
| `shell-on-accent` text on the accent | #ffffff | #0d1520 |
| `shell-danger` errors and broken states | #a3262a | #ff8d90 |

TODO(raed): short descriptive names for the shell's blue and for its blue-gray neutrals, if you want them named differently from the workspace palette.

### Named Rules
**The One Blue Rule.** Each surface has exactly one blue. In the workspace UI it is `#2777c1`, with `#1d5b93` as its text shade; in the shell pages it is `#1f5fbf`. Do not use one surface's blue on the other, and do not add a second accent.

**The Page Keeps Its Colors Rule.** Paper, media, theme swatches and exports keep their authored colors in every appearance. Only the interface around them changes. Never invert or tint a PDF page.

**The Words Carry Errors Rule.** In the workspace UI, a failure or a notice is stated in plain words on a gray surface with a gray border. Color may support it but is never the only signal. (The shell pages do use red text for errors; see Do's and Don'ts.)

## Typography

**Workspace font:** Geist, bundled as the variable face "OpenDoc UI" (weights 100 to 900, real italic), with "OpenDoc UI Arabic" (Noto Naskh Arabic in weights 400, 500, 600 and 700) listed next, then the system sans-serif. Files are in `assets/ui-fonts/`.
**Shell font:** the operating system's UI font (`system-ui`, then `-apple-system` and Segoe UI). The shell pages do not load Geist or Noto Naskh Arabic.
**Mono font:** the system monospace (`ui-monospace`, then Menlo and similar) for paths, commands and pack file names, in both surfaces.

**Character:** TODO(raed): one or two sentences on the pairing. Facts to build on: Geist is a precise, neutral grotesque used small and quiet, with medium weight for labels; Noto Naskh Arabic gives Arabic labels the same weight steps as the Latin beside them; the shell pages read as plain system text.

### Hierarchy (workspace UI)
- **Page title** (600, 20px, 26px line, -0.01em): one per library page and each drilled-in side panel heading.
- **Title** (500, 16px, 22px line): section and card titles, the reader's document title, dialog titles.
- **Label** (500, 13px, 18px line): buttons, field labels, tabs, filter choices.
- **Body** (400, 13px, 20px line): copy, fields, list text. Dialog paragraphs run 14px in muted gray with a 1.65 line, set in the shared dialog style.
- **Menu** (400, 12.5px, 18px line): menu and select rows, sidebar rows.
- **Caption** (400, 12px, 16px line): metadata, hints under fields, pack facts.
- **Tag** (400, 11px, 15px line): tooltips, key hints, the sidebar footer. The floor for compact text.

### Hierarchy (shell pages)
- **Shell title** (bold, 22px, 1.25 line): the one `h1` of each page.
- **Shell body** (400, 15px, 1.5 line): copy and buttons. The "lede" paragraph under a title is muted.
- **Shell eyebrow** (600, 13px, uppercase, 0.06em tracking, muted): the section headings (`h2`) such as "Recent", "Settings folder" and "Try it".
- **Shell hint** (400, 13px, muted): notes under rows and results.
- **Shell mono** (400, 13px): file paths and commands, wrapped at any character.

### Named Rules
**The Small And Quiet Rule.** The workspace UI sets everything at 13px or below except page and card titles. Steps are about a 1.25 ratio (11, 12, 13, 16, 20). Match density with these tokens, never with global zoom or a transform.

**The Auto Direction Rule.** Any text field or block that shows user or document text takes `dir="auto"`; wrap such text in a `bdi` element when it shares a line with icons or labels; use logical properties around it. The app chrome stays left to right and is not mirrored.

## Layout

**Workspace UI.** A fixed 240px sidebar on the left (12px padding, background `surface`, a hairline on its right edge) and a scrolling content column. Library pages (Documents, Presentations, Themes, Templates, Media and Assets) use a content area that is at most 1180px wide with 32px vertical and 40px horizontal padding (32px below 1180px, 40px top padding above 1550px). One filter bar sits under each page title, in a fixed order, and wraps to a second row below 820px. Rows are 32px (data), 40px (library lists) and 44px on touch screens. Spacing in the code is a small set of steps, mostly 4, 8, 10, 12, 16, 20, 24 and 32px, with no spacing variables. The reader has one toolbar and a side panel for Comments and History that docks beside the page and becomes a bottom sheet on narrow screens.

Breakpoints used: 1550px, 1180px, 850px (the sidebar becomes a slide-in drawer of at most 300px), 620px, 520px and 480px, plus `pointer: coarse`, which raises controls to a 40px hit size (`--control-hit-size`).

**Shell pages.** One white card centered in the window on a pale wash, with 24px page padding. The card is 640px wide (920px for the wide pages: backups and the AI apps list), with 32px padding. The AI apps window is sized to the screen it opens on: the list and results scroll while the bottom button bar stays in view, under a hairline. Window sizes are set in the main process: 760 by 660 for the workspace chooser (minimum 480 by 420), and for the other shell windows 520 by 300 (upgrade status), 720 by 700 (upgrade result), 960 by 560 (backups) and 800 by 760 cut down to the screen (AI apps), with a 420 by 300 minimum. Vertical rhythm is 4, 8, 10, 12, 20 and 28px in margins; buttons sit in a flex row with a 10px gap.

## Elevation & Depth

TODO(raed): confirm the philosophy in one phrase. What the code shows:

The workspace UI is a hybrid. Surfaces are layered tonally and stay flat at rest: page background, then the sidebar and bars one gray step down, then white raised fields and dialogs. Shadows appear only on things that float above the page: popups, dialogs, tooltips, notifications, the sidebar drawer, and document paper and covers. Controls carry a barely visible one-pixel shadow only when they are primary or destructive. The shell pages are completely flat: they have no shadows at all, and show structure with one-pixel borders and a pale wash behind a white card.

### Shadow Vocabulary (workspace UI, light appearance)
- **Control** (`box-shadow: 0 1px 2px #00000014`): primary and destructive buttons only.
- **Popup** (`0 4px 8px #00000008, 0 12px 32px #00000014`): menus, selects, popovers, notifications.
- **Dialog** (`0 4px 12px #0000000d, 0 16px 40px #0000001f`): dialogs, one step deeper than popups, above the dimmed backdrop.
- **Tooltip** (`0 2px 6px #00000018`).
- **Paper** (`0 0 0 1px #00000014, 0 1px 3px #00000014, 0 10px 28px #00000014`): document pages in the reader, with a hairline edge.
- **Cover** (`0 2px 5px #00000010, 0 9px 22px #00000010`) and **Thumbnail** (`0 2px 5px #00000012`): document cards and pack previews.
- **Panel edge** (`12px 0 30px #00000014`): the sidebar drawer when it slides over the page.
- Dark appearance uses the same names with stronger, blacker values (for example Popup `0 4px 8px #00000030, 0 12px 32px #00000055`).

### Named Rules
**The Float Only Rule.** Shadows belong to things that float above the page. Content on the page, rows, cards and the shell pages stay flat and use a hairline border instead.

## Shapes

Gently rounded and consistent in the workspace UI: controls, fields, menus, popups and badges share a 6px corner (`--control-radius`), menu rows nest inside at 4px, tooltips are 5px, bars and trust boxes use 8px, and dialogs and the drop target use 12px. Round forms are small: 6px status dots, 20px step marks, and the status pill at 999px. Borders are one pixel, `line` for containers and `control-line` for fields. Focus is a two-pixel ring in the accent, offset 3px from buttons and links and drawn over the edge of text fields.

The shell pages use 8px for buttons, lists and result blocks, 12px for the card, and a full pill (999px) for the status badges. Result blocks carry a four-pixel colored left edge (blue for success, red for a problem) in place of an icon.

## Components

TODO(raed): one phrase for how buttons, cards and fields should feel. What the code shows: compact, flat and quiet, with a clear focus ring and a small press response (a 4 percent scale-down, switched off under reduced motion).

### Buttons
- **Shape:** 6px corners, 32px minimum height (40px on touch), 6px 10px padding, 13px medium label, 1px `line` border (`.ui-button`, `src/app/ui/ui.css`).
- **Default:** white (`surface-raised`) with ink text; hover `#eaeaea`, pressed `#e2e2e2`.
- **Primary:** accent fill with white text, a faint control shadow; hover `#226aab`, pressed `#1d5b93`. Disabled primary becomes the neutral `#e2e2e2` with muted text, never a faded blue.
- **Destructive:** `#b42318` fill with white text; used only in a confirmation that removes something. Hover `#9e1f15`, pressed `#8a1b12`.
- **Icon, tool and text variants:** the icon button is transparent with a 32px target; the tool button is transparent with muted text and turns selected-gray with accent text when pressed; the text button is borderless with accent-ink text and no fill.
- **Transitions:** 140ms on background and color; a press scales to 0.96 (`static` buttons opt out).
- **Shell:** `shell-button` is white with a 1px border, 8px radius, 8px 14px padding, system font at 15px; hover turns the border blue; focus is a 2px blue ring offset by 2px; primary is a solid `#1f5fbf` with white text; disabled is 55 percent opacity. The back link is a borderless blue text button with underline on hover.

### Fields
- **Style:** 32px minimum height, 5px 10px padding, white fill, 1px `control-line` border, 6px corners, 13px text (`.create-field`, `src/app/style.css`). Search fields wrap the input and own the focus.
- **Focus:** a blue edge on the existing border with a soft ring; the ring is drawn flush with the control.
- **Error:** the message sits under the field on 13px ink text, not in red. Hints are muted.
- **Shell:** the shell pages have only checkboxes (18px, accent-colored) and no text fields.

### Menus and selects
- **Style:** popups with 4px padding, a hairline border, 6px corners and the Popup shadow, at least 184px wide; rows are 32px (44px on touch), 12.5px regular, with the current choice named at the right of a submenu row.
- **State:** the highlighted row gets a gray fill and a 2px inset focus ring, so the choice is visible without relying on the faint fill. Destructive rows use the destructive color and go last, below a separator.

### Dialogs
- **Shape:** 12px corners, hairline border, Dialog shadow, centered at 490px wide (600px for pack dialogs, 720px for the import flow), 36px padding (32px in pack dialogs, 24px by 18px below 520px).
- **Structure:** a 16px title, 14px muted paragraphs, fields with 20 to 24px between them, and a right-aligned action row with 10px gaps that sticks to the bottom while a long body scrolls under it, divided by a hairline.
- **Backdrop:** `#00000045` (stronger in dark), fading in over 160ms.

### Bars, lists and boxes
- **Info bar:** `surface` fill, 1px hairline, 8px corners, 12px 16px padding (the "choose designs" bar and the checking box of the import flow). The trust box and error box in pack dialogs use the same shape, with `error-surface` for blockers.
- **Rows:** hairline separators between rows, no row cards; 9px vertical padding for pack item rows.

### Badges
- **Workspace status pill:** 20px high, an outlined pill (1px `line` border, 999px corners, 0 7px padding), caption size at 500 weight in ink, with a 6px colored dot (muted, accent for In review, green for Final; Archived is a hollow dot) (`src/app/tags.css`).
- **Workspace asset badge:** 20px high, 6px corners, 2px 6px padding, pale green fill with dark green text.
- **Shell:** an outlined pill (1px `shell-line` border, 999px corners, 12px text, 1px 8px padding). Muted text by default (installed, available, absent); accent border and text for connected; red border and text for broken, gone or stale.

### Navigation (workspace sidebar)
- **Style:** 240px wide, wordmark at the top (112px, inverted in dark with a filter), rows of 32px at 12.5px muted text with 6px corners.
- **State:** hover is the `control-hover` gray (`#eaeaea`); the selected row is `selected-surface` with accent-ink text and 500 weight. Rows rise to 44px on touch.
- **Drawer:** below 850px the sidebar becomes a 300px slide-in drawer with the Panel edge shadow.

### Shell list rows (AI apps, recent workspaces, problems)
- A single bordered, 8px-rounded list with hairline separators. Each row is a full-width button of 12px 14px padding with the name in 600 weight, optional outlined badges, a muted `›` chevron on the right, and a pale-wash hover. First and last rows round their outer corners to match the list.
- The recent workspaces list shows a bold name over a muted, ellipsized path and a muted "Remove" button.

### Result block (shell)
- A bordered, 8px-rounded block with a 4px colored left edge (accent for good, danger for bad), a 15px title, a body and a "Details" disclosure with a muted summary. Output and commands are in a bordered mono block on `shell-wash` and scroll at 240px.

### Motion
- The workspace UI uses one quick duration, `--motion-quick` (140ms), plus 160ms for dialogs, backdrops, notifications and the drawer, a six-pixel slide-in for dialogs and notifications, and a 3px slide for select popups.
- Under `prefers-reduced-motion`, all transitions and animations are switched off in the workspace UI; the shell's spinner stops spinning and shows a static arc.

## Do's and Don'ts

### Do:
- **Do** choose the surface first. A screen inside the workspace window uses the workspace tokens (`src/app/colors.css`, `src/app/ui/ui.css`); a new desktop dialog or page uses the shell tokens (`desktop/src/renderer/shell.css`). Never mix the two palettes on one screen.
- **Do** size workspace controls from `--control-hit-size` (32px, 40px on touch) rather than a fixed height.
- **Do** use the semantic color roles by name (`--surface`, `--line`, `--accent-ink`) and let light, dark and increased contrast follow. Check any new screen in light and dark.
- **Do** use `accent-ink` (`#1d5b93`) for blue text on gray surfaces, and the plain accent (`#2777c1`) for fills and focus.
- **Do** keep user text and mixed Arabic and English intact: `dir="auto"`, `bdi`, logical properties, and no mirroring of the chrome.
- **Do** keep shadows to floating things: popups, dialogs, tooltips, notifications and document paper.
- **Do** give every dialog a title and a description, and keep long paths and names wrapping (`overflow-wrap: anywhere`).
- **Do** keep a visible focus ring on every control and honor `prefers-reduced-motion`.

### Don't:
- **Don't** add a second accent color or tint chrome with a document's colors; PDF pages, theme swatches and media keep their own colors in both appearances.
- **Don't** use uppercase micro-labels, decorative badges or floating arrow ornaments in the workspace UI. (The shell pages do use small uppercase section headings; that is a known difference between the two surfaces, and new shell pages may follow the existing pattern.)
- **Don't** signal an error with color alone. State it in words; in the workspace UI use the gray error or notice surface.
- **Don't** fade a disabled primary button to a pale blue; use the neutral disabled fill.
- **Don't** put app-wide settings such as appearance into a document's actions menu; they live in the sidebar footer and the Skills and appearance menu.
- **Don't** override menu type, spacing or surfaces in domain styles; use the shared `ui-menu-*` and `ui-select-*` styles and the `--menu-*` tokens.
- **Don't** apply global CSS zoom or a transform to the app to change density.
- **Don't** load web fonts in the shell pages or add shadows to them; they are flat and use the system font.
- **Don't** treat the black-and-white icon as a place for color: do not recolor the sheet or the O, add a gradient, or outline the O.
