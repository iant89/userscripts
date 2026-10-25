# Arena.ai | Pro

**Arena.ai | Pro v3.4.0** is a zero-runtime-dependency userscript for Arena.ai conversations. It combines long-chat performance controls, code/conversation exports, agent-workflow shortcuts, and a configurable Agent Mode Manager.

## Installation

1. Install **Tampermonkey**, **Violentmonkey**, or **Greasemonkey** in your browser.
2. Open [`Arena.ai | Pro.user.js`](./Arena.ai%20%7C%20Pro.user.js) and choose the userscript manager's install option (or create a new script and paste the file contents).
3. Visit `arena.ai`, `canaryarena.ai`, or `chat.lmsys.org`. Use the small tab on the left edge to open the control panel.

The userscript requests `GM_getValue` and `GM_setValue` for settings persistence. It also supports `localStorage` when those APIs are unavailable. Settings, including saved Agent Modes, remain local to the browser/userscript manager.

## Agent Mode Manager

Open the left drawer and go to **Settings → Agent Mode Manager** to add a mode:

- **Mode name** is the label shown in the composer picker.
- **Prepended prompt** is the instruction placed before the text you type.
- Existing modes can be edited or deleted from the same section.

Use the **Mode: Off** button in the composer to choose **Off** or one of your saved modes. While a mode is active, pressing Enter or clicking Send submits:

```text
<prepended prompt>

<your message>
```

The selected prompt is inserted into the composer before submission so Arena receives it as part of the message. The userscript avoids adding it a second time if the message already starts with that prompt. **Off** leaves normal messages unchanged. The **Create PR** and **Merge PR** shortcuts also bypass Agent Mode prepending and submit their instructions through Arena's composer; they do not invoke GitHub directly.

## Features

### Conversation performance

- Virtualizes older messages while keeping the configured number of recent messages visible.
- Reveals older messages in batches when scrolling upward, with a **Reveal older messages** control as a fallback.
- Flattens token-heavy Shiki code spans in hidden messages and retains their original markup for reveal and HTML export.
- Reduces backdrop blur, transitions, and related effects in larger conversations.
- Follows streaming output when you're at the bottom, pauses when you scroll upward, and offers a jump-to-bottom button.

### Usability and exports

- Left-edge drawer with **Settings**, **Actions**, and **Statistics** tabs; outside click and Escape close it.
- Light/dark styling follows the page's theme attributes, root background CSS variables, and system preference.
- Thinking block modes: collapse older reasoning, expand reasoning, or hide reasoning.
- Code-block **⬇** downloads with language-based extensions and filename detection from nearby labels.
- Full conversation Markdown export, including virtualized history and code-language fences.
- Live message, character, estimated-token, code-block, thinking-block, and context-window statistics. Token usage is estimated at roughly four characters per token.
- Clipboard diagnostics from **Actions → Run diagnostics**.

### Agent workflow and composer controls

- **Create PR** and **Merge PR** shortcuts send instructions through Arena's composer.
- **Clear chat** removes rendered message entries from the current conversation DOM; it does not create a new chat or navigate away.
- A navbar **Export HTML** button appears beside the diff browser when detected. It creates a standalone HTML snapshot with captured page CSS/custom properties, restored message/code markup, and controls for reasoning toggles, code copy/download, and theme switching.
- **Hide composer** collapses the input panel.
- **Compact composer** keeps the text field, Send/Cancel, and an **…** menu visible. The menu provides access to detected composer controls and Agent Mode selection.

## Settings and notes

- Settings can be adjusted in the drawer and persist across reloads.
- The optional **Custom composer selector** can override automatic composer detection if Arena changes its input markup.
- **Context window** configures the denominator used for the approximate statistics bar; it is not Arena's actual token counter.
- **Clear chat** is DOM-only. Arena's React state or a later reload may reconstruct messages; this feature does not delete server-side conversation history.
- The standalone HTML exporter captures accessible stylesheet rules and custom properties, then best-effort inlines linked CSS assets and media using browser CORS access. For safety, it limits resource embedding to 48 requests, 3 MiB per resource, and 20 MiB total. Assets blocked by CORS or those limits remain as absolute URLs and may need network access when the export is viewed.
- Arena's DOM can change. If a feature stops locating the composer or conversation, run diagnostics and review the selector or DOM output.

## Development checks

The userscript has no runtime packages or build step. The local test suite uses Node's built-in test runner plus **jsdom** as a development-only dependency:

```sh
npm install
npm test
node --check "Arena.ai | Pro.user.js"
```

Tests cover persistence, Agent Mode configuration and submission, theme/drawer behavior, virtualization and Shiki restoration, thinking modes, Markdown/statistics, in-place Clear Chat, standalone HTML interactivity, and compact/hide composer controls.

## License

AGPL-3.0. See the userscript header and repository license terms.
