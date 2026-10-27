# Web Inspector

A dependency-free, vanilla-JavaScript userscript that injects a floating inspection panel into the current webpage. The script is self-contained; install `Web Inspector.user.js` in a userscript manager such as Userscripts, Tampermonkey, or a compatible Safari extension and allow it on the pages you want to inspect.

## Current features

- Shadow-DOM UI, dark theme, persistent window geometry, floating drag/resize, four-edge snap previews/docking, collapse, hide/reopen, and viewport-aware placement.
- Elements tree with selection, a page-target picker with green hover/selection highlights, attribute and text editing, visibility toggle, add element, delete with immediate Undo, and search.
- Console output capture where the execution environment permits it, command history, and explicit command execution.
- Reconstructed live-DOM source viewer with basic safe syntax coloring, source search, copy, and temporary JSON/text resource viewing.
- Local storage, session storage, and accessible document-cookie listing, filtering, refresh, copy, view, deletion, and confirmed clearing.
- Saved window preferences across navigation, including between sites when userscript-manager storage is available. No external requests or runtime dependencies.

The title-bar control switches between collapse and expand. A collapsed top- or bottom-docked window keeps its title bar at the viewport edge so its controls remain reachable. The circular reopen button appears only while the inspector is hidden, not while it is open or collapsed.

When a mobile keyboard changes the visible viewport, the inspector adjusts temporarily and restores its preferred position and size afterward. Deliberate moves and resizes still update the saved geometry.

## Window state and storage

The inspector remembers whether it is hidden, along with its position, size, dock, collapsed state, active tab, and resource category. Hiding it keeps it hidden on subsequent pages until it is reopened with the circle or the `Ctrl`/`Command` + `Shift` + `I` shortcut. Existing per-site preferences can be migrated when manager storage has no saved preferences.

To share preferences between websites, the script requests userscript-manager value storage (`GM.getValue`, `GM.setValue`, `GM.listValues`, and `GM.deleteValue`, with legacy equivalents). It also requests `unsafeWindow` where supported to preserve page access if a site blocks the page-context bridge. Updating from an earlier version may require approving these grants in your userscript manager. The manager stores only window preferences—not page content, resource values, selected elements, or console history. The manager's own storage and sync settings apply.

A namespaced page-local storage entry is also used as a fallback. If manager storage is unavailable, preferences are limited to the current origin; if page storage is also unavailable, they last only for the current page. Very slow manager storage may cause a restored preference to appear shortly after navigation. Clearing page storage does not necessarily clear the manager's shared preferences.

## Picking elements

Click or tap **Pick**, then move over a page element and click or tap it. You can also press and drag directly from **Pick** onto an element, then release; after tapping Pick, a touch drag can preview multiple elements before you release. Press **Escape** to cancel. Touch scrolling is paused while Pick mode is active.

The element under the picker receives a light-green preview. A selected element, including one chosen from the tree or search, gets a padded, pulsing green border that follows it as the page scrolls or its layout changes. The border is hidden when the element has no box, has hidden visibility, is removed, or the inspector is hidden. With reduced motion enabled, the border remains visible without pulsing. Highlights are non-interactive overlays and do not modify the element's styles or layout.

## Icons and attribution

The interface uses [Font Awesome Free](https://fontawesome.com/) solid icons by Fonticons, Inc. The SVG/JavaScript icon artwork is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The original, unmodified icon paths are embedded as inline SVGs in the userscript, so no icon font, CDN, network request, or runtime library is needed.

For development, the pinned `@fortawesome/free-solid-svg-icons` package supplies the icon data. After `npm ci`, edit the icon mapping in `scripts/update-icons.cjs` and run `npm run update:icons` to regenerate the embedded paths. `npm test` checks that the generated data is up to date.

## Testing

The userscript has no runtime dependencies. To run the browser regression tests, use Node.js 20 or later:

```sh
cd inspector
npm ci
npx playwright install chromium
npm test
```

To use an existing Chromium executable instead, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` when running `npm test`.

## Important limitations

This is a userscript, not Safari's privileged Web Inspector. The Source view is reconstructed from the current live DOM, not the original network response. Console capture is best-effort and cannot see native browser/network errors or other isolated execution contexts. Commands normally execute as page JavaScript and can change the page, navigate, or access data available to the page. If a site's Content Security Policy blocks the page-context bridge and the manager does not provide page access, the inspector falls back to the isolated userscript context and labels the console accordingly; page JavaScript globals may then be unavailable. `document.cookie` cannot reveal HttpOnly cookies and exposes limited cookie scope metadata. Cross-origin frames and closed shadow roots are inaccessible. Storage availability depends on the page and userscript manager.

Outside of Pick mode, the script does not block navigation or intercept forms; it does not reload the page or automatically replay commands or edits. Destructive page changes remain page changes and are not persisted for restoration.
