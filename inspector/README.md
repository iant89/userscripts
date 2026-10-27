# Web Inspector

A dependency-free, vanilla-JavaScript userscript that injects a floating inspection panel into the current webpage. The script is self-contained; install `Web Inspector.user.js` in a userscript manager such as Userscripts, Tampermonkey, or a compatible Safari extension and allow it on the pages you want to inspect.

## Current features

- Shadow-DOM UI, dark theme, persistent window geometry, floating drag/resize, four-edge snap previews/docking, collapse, hide/reopen, and viewport-aware placement.
- Elements tree with selection, scoped page-target picker, attribute and text editing, visibility toggle, add element, delete with immediate Undo, and search.
- Console output capture where the execution environment permits it, command history, and explicit page-context command execution.
- Reconstructed live-DOM source viewer with basic safe syntax coloring, source search, copy, and temporary JSON/text resource viewing.
- Local storage, session storage, and accessible document-cookie listing, filtering, refresh, copy, view, deletion, and confirmed clearing.
- Preferences use a namespaced local-storage key where available. Resource values and console history are not automatically persisted. No external requests or dependencies.

## Important limitations

This is a userscript, not Safari's privileged Web Inspector. The Source view is reconstructed from the current live DOM, not the original network response. Console capture is best-effort and cannot see native browser/network errors or other isolated execution contexts. Explicit console commands execute as page JavaScript and can change the page, navigate, or access data available to the page. `document.cookie` cannot reveal HttpOnly cookies and exposes limited cookie scope metadata. Cross-origin frames and closed shadow roots are inaccessible. Storage availability depends on the page and userscript manager.

The script deliberately does not block navigation, intercept forms, reload the page, or automatically replay commands or edits. Destructive page changes remain page changes and are not persisted for restoration.
