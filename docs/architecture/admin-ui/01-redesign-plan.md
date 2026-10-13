# Admin UI redesign — plan

Status: implemented (phases 0–4) on branch `admin-ui-redesign`, 2026-10-13. See §11.

## 1. Goal and the one hard rule

Restyle the admin dashboard (port 19816) to match the Sieve landing page
(https://sieve-landing-sable.vercel.app/): warm paper palette, Geist / JetBrains
Mono, the dot-grid logo, a shadcn-style component look, and
light + dark themes.

**No functionality changes.** Every route, handler, form `action`, input
`name`, element `id`, `hx-*` attribute, `data-*` attribute, and inline script
behaviour stays as it is. The existing e2e suites select by form actions and
input names, never by CSS classes, so they must pass unchanged; that is the
proof the redesign changed only the look.

## 2. What the admin UI is today

- **Not React.** Server-rendered Go `html/template` files embedded with
  `//go:embed templates/*` (`internal/web/server.go`), 13 templates, about
  4,800 lines. `nav.html` is the shared sidebar shell.
- Styling: the **Tailwind Play CDN** script (`cdn.tailwindcss.com`) on 11
  pages, which compiles classes in the browser at runtime. Tailwind documents
  it as not for production. It is also a hard dependency on the network,
  which the desktop app should not have.
- Colour: hard-coded `slate` / `indigo` / `emerald` / `amber` / `red`
  utilities, about 1,600 uses, dark-only. There are no theme tokens.
- Behaviour: htmx 2 (approvals page), marked + DOMPurify (docs), and 30
  inline `<script>` blocks, some of which build markup with class strings
  (31 in `iam.html`, 7 in `nav.html`).
- The login and first-run setup pages are HTML strings inside
  `internal/web/auth.go`, not templates.
- Fonts: Inter from Google Fonts.

## 3. Can we use shadcn?

shadcn/ui is not a package. It copies React component source (`.tsx`, built
on Radix primitives) into a React project. Those components need React at
runtime, so they **cannot be used directly in Go-rendered HTML**.

What does carry over, and is what makes shadcn look like shadcn:

1. **Its theme model**: semantic CSS variables (`--background`,
   `--foreground`, `--card`, `--primary`, `--muted`, `--border`, `--ring`,
   `--destructive`, …) with a `.dark` override, consumed by Tailwind.
2. **Its component recipes**: the exact Tailwind class lists for each
   component and variant (button default/secondary/outline/ghost/destructive,
   input, select, card, table, badge, alert, tabs, dialog).
3. **Its visual language**: 1px borders, small radii, quiet shadows, focus
   rings, dense tables.

Options considered:

| Option | What it means | Verdict |
|---|---|---|
| A. shadcn design system in Go templates | Port shadcn's CSS variables and component recipes into Tailwind `@layer components` classes (`.btn`, `.btn-outline`, `.input`, `.card`, `.badge-success`, …) and use them in the existing templates | **Recommended.** Same look, zero behaviour change, no JS framework |
| B. Basecoat UI | An open-source library that already re-implements shadcn components as plain HTML + Tailwind classes + small vanilla JS, aimed at server-rendered apps | Strong shortcut for A. Evaluate in Phase 0; adopt if its classes and JS fit our CSP and inline-script constraints |
| C. React islands | Mount real shadcn components into specific DOM nodes | Adds a JS bundler and a second rendering model for little gain |
| D. Rewrite the admin UI as a React SPA | Real shadcn everywhere | Rewrites forms, CSRF handling, htmx flows and server rendering. Breaks the no-functionality-change rule. Out of scope |

## 4. Brand tokens (from the landing page)

Fonts: **Geist** (UI text), **JetBrains Mono** (wordmark, code, token values,
IDs, operation names). **Instrument Serif was removed at the user's request**
(2026-10-13): page titles, card titles and the login/setup headings use
Geist 600 with -0.02em tracking. The admin UI ships Geist + JetBrains Mono only.
Both are SIL Open Font License, so they are self-hosted.

Light theme is the landing page's default palette. Dark theme was first built
around `#161513` (the landing ink); **the user then changed the dark
background to the near-neutral `#0e0e0d`** because `#161513` read brownish, and
moved every dark surface to a neutral scale with only a hint of warmth
(`#0e0e0d` / `#161615` / `#1e1e1c` / `#2a2a27` / `#3a3a36`). Other dark
values: secondary text `#c9c7bf`, input background `#121211`, sidebar
`#121211`; status colours and link (`#5fb06b`, `#e07a45`, `#ec6d63`,
`#6f8fff`) unchanged, with `#0e0e0d` text on their fills.

| Token (shadcn name) | Landing source | Light | Dark |
|---|---|---|---|
| `--background` | `--bg` | `#f3f0e8` | `#0e0e0d` |
| `--foreground` | `--ink` | `#161513` | `#f3f0e8` |
| `--card` / `--popover` | `--paper` | `#faf8f2` | `#161615` |
| `--muted` / `--secondary` / `--accent` (hover) | `--bg-2` | `#ebe7dc` (accent `#e4dfd2`) | `#1e1e1c` |
| `--muted-foreground` | `--ink-3` | `#6b675e` | `#9a9890` |
| `--subtle-foreground` (decorative only) | `--ink-4` | `#9e9a8e` | `#6f6d66` |
| `--border` / `--input` | `--rule` | `#d9d3c3` | `#2a2a27` |
| `--border-strong` | `--rule-2` | `#c5bea9` | `#3a3a36` |
| `--primary` (buttons, strong selection) | `--ink` | `#161513` | `#f3f0e8` |
| `--primary-foreground` | `--bg` | `#f3f0e8` | `#0e0e0d` |
| `--primary-hover` | 88% ink toward bg | `#2f2e2b` | `#d8d5ce` |
| `--link` (accent as small text) | darker accent | `#1f4fd6` | `#6f8fff` |
| `--ring` / `--focus` (focus outline) | `--ink` (outline at 60% / 50%) | `#161513` | `#f3f0e8` |
| `--brand` (landing blue; never a button) | `--accent` | `#2b5fff` | `#6f8fff` |
| `--success` | `--good`, darkened | `#2a7034` | `#5fb06b` |
| `--warning` (as text) | `--warn`, darkened | `#a8410f` | `#e07a45` |
| `--destructive` | `--bad` | `#b3261e` | `#ec6d63` |

Contrast (WCAG, measured): body text 16:1 both themes; muted text 4.95:1
light / 6.1:1 dark; primary button text 5.0:1 light / 6.1:1 dark; status
colours ≥ 4.6:1 as text. The landing accent `#2b5fff` is 4.41:1 on the light
background, just under the 4.5:1 minimum for small text, so links use the
darker `--link`; the landing `--warn` (3.99:1) gets the same treatment.
`--subtle-foreground` is below 4.5:1 by design and is only for decoration
(dividers, placeholder dots), never for text that carries meaning.

Radius: 6px controls, 10px cards. Shadows: none on light (borders do the
work), a 1px inner highlight on dark cards.

## 5. Logo

The landing mark is a 4×4 dot grid with the centre 2×2 removed (a sieve),
followed by the lowercase wordmark in JetBrains Mono. In the admin UI it uses
`currentColor` so it follows the theme:

```html
<a href="/" class="flex items-center gap-2.5 text-foreground" aria-label="Sieve home">
  <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" fill="currentColor">
    <!-- ring of 12 dots; the inner 2×2 is the "hole" -->
    <circle cx="3" cy="3" r="1.3"/><circle cx="8.3" cy="3" r="1.3"/><circle cx="13.6" cy="3" r="1.3"/><circle cx="18.9" cy="3" r="1.3"/>
    <circle cx="3" cy="8.3" r="1.3"/><circle cx="18.9" cy="8.3" r="1.3"/>
    <circle cx="3" cy="13.6" r="1.3"/><circle cx="18.9" cy="13.6" r="1.3"/>
    <circle cx="3" cy="18.9" r="1.3"/><circle cx="8.3" cy="18.9" r="1.3"/><circle cx="13.6" cy="18.9" r="1.3"/><circle cx="18.9" cy="18.9" r="1.3"/>
  </svg>
  <span class="font-mono text-[13px] font-medium tracking-[0.02em]">sieve</span>
</a>
```

The same mark becomes the favicon (SVG with a `prefers-color-scheme` style
block) and the desktop tray icon, replacing the funnel placeholder in
`desktop/assets/`.

## 6. Architecture changes (build, not behaviour)

1. **Compile Tailwind instead of the Play CDN.** Use Tailwind v4's standalone
   CLI (a single binary, no Node project needed in the Go repo) driven by
   `go generate`, scanning `internal/web/templates/*.html` and
   `internal/web/*.go`. Output `internal/web/static/admin.css`, committed,
   embedded with `go:embed`, and served at `/static/admin.css` with a content
   hash for caching. A CI check fails if the committed CSS is stale, mirroring
   the existing Cedar-schema staleness test.
2. **Theme file** `internal/web/styles/theme.css`: the tokens in §4 as CSS
   variables on `:root` and `.dark`, mapped into Tailwind v4 with `@theme
   inline` exactly as shadcn does, plus the component layer (§7).
3. **Self-hosted fonts** (woff2, subset to Latin) under `static/fonts/`.
   Removes the Google Fonts dependency and makes the desktop app work fully
   offline.
4. **Theme switching**: **dark by default** (when nothing is saved), with a
   Light / Dark / System control in the sidebar footer. The choice is stored
   in `localStorage` and applied by a tiny inline script in `<head>` before
   first paint (no flash). Inside the desktop app, System follows the OS via
   Electron's `nativeTheme`, which drives `prefers-color-scheme`.
5. **CSP tightens**: `cdn.tailwindcss.com`, Google Fonts, and their
   `connect-src` entries leave `writeSecurityHeaders`. htmx, marked and
   DOMPurify should be vendored into `static/` too, after which
   `script-src` no longer needs any third-party host.

## 7. Component layer

Semantic classes in `@layer components`, each a port of the shadcn recipe,
so templates shrink and stay consistent:

- **Button**: `.btn` + `.btn-primary | -secondary | -outline | -ghost |
  -destructive`, sizes `.btn-sm | -icon`.
- **Form**: `.input`, `.select`, `.textarea`, `.checkbox`, `.label`,
  `.field-help`, `.field-error`.
- **Surfaces**: `.card`, `.card-header`, `.card-title`, `.card-content`,
  `.card-footer`; `.alert` + `-info | -success | -warning | -destructive`.
- **Data**: `.table` (dense, sticky header, mono for IDs/ops), `.badge` +
  status variants (allow / deny / approval / reauth / disabled).
- **Navigation**: `.sidebar`, `.nav-item`, `.nav-item-active`, tabs.
- **Code**: `.code`, `.kbd`, token display (mono, select-all).

Go template partials (`{{template "badge" …}}`) only where markup is
repeated with logic, such as the status badge.

## 8. Phases

| Phase | Scope | Done when |
|---|---|---|
| 0 | Evaluate Basecoat vs hand-ported recipes; Tailwind standalone build via `go generate`; `theme.css`; fonts; `/static` route; CSP update; staleness check | A blank page renders with tokens in both themes; CDN script removed from one pilot page; all Go tests pass |
| 1 | Shell: `nav.html` sidebar, logo, theme toggle, favicon, login + setup pages in `auth.go` | Every page shows the new shell; theme persists across reloads; no first-paint flash |
| 2 | Component layer (§7) and a hidden `/docs`-style style guide page listing every component in both themes | Style guide reviewed and signed off |
| 3 | Page migration, smallest to largest: approvals, audit, tokens/tokens_edit, settings, connection_edit, iam_filter_edit, iam_edit, docs, connections, iam. Includes class strings built by inline scripts | Per page: existing e2e passes unchanged; screenshot review in both themes |
| 4 | Polish: empty states, focus-visible rings, reduced motion, 760px window width (the desktop minimum), WCAG contrast pass, remove all leftover `slate`/`indigo` literals | `grep` finds no legacy colour utilities; axe scan clean |

Pages are migrated one at a time and each can merge independently, because the
new CSS and the old utilities can coexist during Phase 3.

## 9. Verification (proving "no functionality change")

1. The root Playwright suite (`e2e/*.spec.ts`) and the desktop suite
   (`desktop/tests`) pass with **no edits**.
2. A structural diff per page: a small script renders each template before
   and after with fixed data and compares the set of
   `(form action, input name, id, hx-*, data-*)` tuples. Any difference fails.
3. Playwright screenshots of every page in light and dark, reviewed by hand,
   then kept as visual-regression baselines.
4. `go test ./internal/web/...` passes (handlers and templates).

## 10. Open questions

1. **Basecoat or hand-ported recipes?** Basecoat saves work but adds a
   dependency and its own JS conventions. Decide after the Phase 0 spike.
2. **Instrument Serif in an admin tool**: use it only for page titles, or not
   at all? It is distinctive on the landing page but can feel decorative in
   dense admin screens.
3. **Accent in dark mode**: `#6f8fff` is a lightened landing blue for
   contrast. Confirm with whoever owns the brand.
4. **Pre-existing e2e failures**: the root suite already fails on `main` for
   tests that target the removed `/policies` and role editors (see the desktop
   plan, §10.4). Those need fixing or deleting first, or the "suite passes
   unchanged" gate in §9 is meaningless.

## 11. Implementation status (2026-10-13)

All four phases are implemented and uncommitted on `admin-ui-redesign`.

**Decision on §10.1 — hand-ported recipes, not Basecoat.** Basecoat
(`basecoat-css` 1.0.2) was evaluated: its CSS is a Tailwind v4 layer with
shadcn variables, which fits, but its form styling keys off attribute
selectors (`.input[type=text]`, `.field > input`) and markup conventions,
it ships nine theme variants and ~30 component files we would not use, and
its interactive parts (select, dropdown, tabs, toast) need its own JS and
markup. The admin UI needs none of that JS (the only overlay is the existing
command palette), so we ported the shadcn recipes we need by hand into
`@layer components`. No new runtime or build dependency beyond the Tailwind
CLI.

What landed:

| Area | Where |
|---|---|
| Theme tokens (§4), `@theme inline` mapping, base layer, component layer (§7) | `internal/web/styles/theme.css` |
| Compiled CSS (committed), fonts (Geist, JetBrains Mono; woff2 + OFL licences), favicon, vendored htmx 2.0.4 / marked 12.0.2 / DOMPurify 3.1.6 (same bytes as the old CDN SRI hashes) | `internal/web/static/` |
| Build: Tailwind v4.3.3 standalone CLI, pinned per-platform SHA-256, cached in gitignored `.tools/` | `go generate ./internal/web` → `internal/web/tools/genadmincss` |
| Staleness check: admin.css carries a SHA-256 of its inputs (theme.css + templates) | `internal/web/assetsum`, `TestAdminCSSFresh` |
| `/static/` route (admin port only, auth-exempt like `/docs`, cache-busted `?v=` URLs, immutable caching, no directory listing) | `internal/web/static.go`, `TestStaticAssetsServed` |
| CSP: every third-party script/style/font/connect host removed; OAuth `form-action` hosts kept | `headers.go`, `TestCSPSelfHostedAssets` |
| Shared `<head>` (stylesheet, favicon, no-flash theme bootstrap) and logo | `templates/layout.html`, `theme.go` |
| Theme: dark default, Light/Dark/System toggle in the sidebar footer, `localStorage["sieve-theme"]`, applied before first paint | `theme.go`, `nav.html` |
| Sidebar shell with dot-grid logo; login and setup pages | `nav.html`, `auth.go` |
| Style guide, session-gated, not linked | `GET /styleguide`, `templates/styleguide.html` |
| All 13 templates migrated, including class strings built in inline JS; zero legacy `slate`/`indigo`/`emerald`/`amber`/… utilities remain | `templates/*.html`, `linkify.go` |

Answers to the other open questions as implemented: Instrument Serif was
first used for page titles, then removed entirely at the user's request
(titles are Geist 600); the dark accent is `#6f8fff` as proposed (still worth a brand sign-off).
Per-connector accent colours (orange AWS, violet Anthropic, sky Gemini…)
were folded into the single primary accent, which is the shadcn look; brand
logos keep their own SVG fills.

**No-functionality-change proof.** `go run ./internal/web/tools/structcheck
-old <pre-restyle templates dir>` compares every template action (in order),
every behaviour attribute (form action/method, name, value, id, for, type,
href, hx-*, data-*, on*, aria-*, role, …) and every inline script with class
names removed. All 13 templates pass; the only additions are in `nav.html`
(the theme toggle buttons and three aria labels), passed with `-allow`.

Known follow-ups:

- Two Documentation IA tests in `e2e/web-ui.spec.ts` selected by colour
  class (`span.text-slate-200`, `toHaveClass(/text-indigo-400/)`); their
  selectors were updated to the new tokens. The four other Documentation IA
  failures are pre-existing on `main`.
- Templates still carry long utility strings in places where the automated
  migration mapped colours to tokens without collapsing them into component
  classes (badges, alert-style boxes). Converting those to `.badge-*` /
  `.alert-*` is a follow-up cleanup, not a visual change.
- The desktop tray icon in `desktop/assets/` still uses the old funnel.
- Tables are not horizontally scrollable at the 760px desktop minimum on
  every page (tokens list compresses columns instead).

Contrast pass (WCAG 2.x, computed from the tokens): body text 16:1 both
themes; muted text 5.3:1 on cards (light) / 5.6:1 (dark), ≥4.56:1 on the
muted and sidebar surfaces; links 6.3:1 / 5.7:1; primary button text
5.0:1 / 6.1:1; status badge text on its own 10% tint ≥4.9:1. To get there,
light `--success` moved from `#2f7a3a` to `#2a7034` and dark `--destructive`
from `#e5645a` to `#ec6d63`, and active nav/filter chips use a 10% primary
tint (a 20% tint dropped dark-mode link text to 4.1:1). An automated axe
scan was not run.

### Buttons and the ink primary (2026-10-13 revision)

Buttons now copy the landing page's `Btn` primitive: radius 4px, Geist 500,
-0.005em tracking, 9px 14px at 13.5px (`.btn-sm` 6px 10px at 12px), a 1px
press on `:active` (skipped under reduced motion), and 80ms / 120ms
transitions. `--primary` is ink and inverts with the theme (light `#161513`
fill with `#f3f0e8` text, dark the reverse). Outline/secondary buttons are
transparent with a `--border-strong` (landing `--rule-2`) border; ghost is
transparent with `--secondary-foreground` (`--ink-2`) text; `.btn-mono` is
the landing's GitHub-button variant for identifier-like buttons (used on the
token Copy button). shadcn naming is kept: `--accent` is still the neutral
hover surface, and the landing blue lives on as `--link` (text links) and
`--brand`.

Blue is still used only for: text links (`.link`, `text-link` on `<a>`
elements such as "Edit"/"Edit roles", docs prose links, linkified help
text), the docs rail's active page and category (they are links, and an
existing e2e test keys on `text-link`), `.btn-link`, and the text-selection
tint. It is no longer used on any button, selected chip, nav item, tab,
checkbox, accordion, badge, icon tile or focus ring.

Contrast (WCAG): primary 16.0:1 (hover 11.9 / 12.9); outline and secondary
16.0 on the background, 17.2 / 14.8 on cards; ghost 10.3 / 10.5;
destructive 6.5 / 6.0 (hover 5.5 / 4.9); success 6.1 / 6.9; warning 6.1 /
6.1; links 6.3 / 5.7; focus outline vs background 4.6 / 4.8. The outline
button's border (1.7:1, same as the landing page) is decorative; the label
carries the meaning.

Dark contrast after the neutral-black change (on `#0e0e0d` / `#161615`):
text 17.0 / 15.9; secondary text 11.4 / 10.7; muted text 6.7 / 6.3 (5.8 on
`#1e1e1c`); links 6.5 / 6.1; success 7.3 / 6.8; warning 6.5 / 6.1;
destructive 6.4 / 6.0; primary button 17.0 (hover 13.2); destructive /
success / warning buttons 6.4 / 7.3 / 6.5 (hover 5.2 / 5.9 / 5.2); badges
on their 10% tint over cards 5.3 / 5.9 / 5.3; ghost 11.4; focus outline 4.8.

### Later additions (2026-10-13)

- **Connector rows** on `/connections` are native `<details>` accordions
  (`.accordion*` recipe), collapsed by default; `#<type>` / `?type=<type>`
  open the matching row. Brand logos (Devicon MIT / Simple Icons CC0, see
  `internal/web/static/icons/connectors/SOURCES.md`) are drawn by CSS keyed
  on the row id, with cream variants for near-black marks in dark mode;
  connectors without a logo keep a neutral plug tile.
- **Styled error pages**: `errorpage.go` re-renders plain-text admin errors
  (http.Error, the mux 404) as `templates/error.html` for top-level browser
  navigations only. Status codes and message text are unchanged; fetch/htmx
  callers, `/events`, JSON/API endpoints and `/static/` are untouched, and
  the agent API port is not affected.
- **Docs embedded**: `/docs` reads from the embedded `docs` package (ported
  from main) so it works from the desktop app's working directory.
