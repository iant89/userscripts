// ==UserScript==
// @name         Arena.ai | Coding Edition
// @namespace    https://greasyfork.org/en/users/1462137-piknockyou
// @version      1.0.0
// @author       Piknockyou (vibe-coded)
// @license      AGPL-3.0
// @description  Reskins arena.ai with Claude.ai's clean web design language, virtualizes old messages, strips heavy CSS, and adds one-click Markdown export.
// @match        *://*.arena.ai/*
// @match        *://*.canaryarena.ai/*
// @match        *://chat.lmsys.org/*
// @icon         https://arena.ai/favicon.ico
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// ==/UserScript==

(() => {
	"use strict";

	// ═══════════════════════════════════════════════════════════════════
	// CONFIG
	// ═══════════════════════════════════════════════════════════════════
	const DEFAULTS = {
		visibleMessages: 8,
		virtualize: true,
		flattenCode: true,
		showExport: true,
		showStatus: true,
	};
	let cfg = { ...DEFAULTS };
	try {
		const raw = GM_getValue("ccCodingEdition", null);
		if (raw) cfg = { ...DEFAULTS, ...JSON.parse(raw) };
	} catch (_) {}
	function saveConfig() {
		try { GM_setValue("ccCodingEdition", JSON.stringify(cfg)); } catch (_) {}
	}

	// ═══════════════════════════════════════════════════════════════════
	// THEME — Claude.ai design tokens (light + dark)
	// ═══════════════════════════════════════════════════════════════════
	const STYLE_ID = "cc-coding-edition";

	function themeCSS() {
		return `
/* ══════════════════════════════════════════════════════════════
   Arena.ai | Coding Edition
   Claude.ai web design language
   ══════════════════════════════════════════════════════════════ */

:root {
  --cc-bg: #faf9f5;
  --cc-bg-elevated: #ffffff;
  --cc-bg-card: #ffffff;
  --cc-bg-user: #f0eee6;
  --cc-bg-code: #1f1e1d;
  --cc-bg-code-header: #2a2a28;
  --cc-text: #1f1e1d;
  --cc-text-secondary: #3d3c38;
  --cc-text-muted: #83837f;
  --cc-border: #e8e6dc;
  --cc-border-strong: #d6d4cc;
  --cc-accent: #d97757;
  --cc-accent-hover: #c15f3c;
  --cc-accent-bg: rgba(217, 119, 87, 0.08);
  --cc-accent-border: rgba(217, 119, 87, 0.25);
  --cc-blue: #6a9bcc;
  --cc-green: #5a8a5f;
  --cc-yellow: #d4a843;
  --cc-shadow: 0 1px 3px rgba(0, 0, 0, 0.04), 0 1px 2px rgba(0, 0, 0, 0.06);
  --cc-shadow-lg: 0 4px 16px rgba(0, 0, 0, 0.08);

  --cc-font-sans: -apple-system, BlinkMacSystemFont, "Inter", "Söhne", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --cc-font-code: "SF Mono", "JetBrains Mono", "Fira Code", "Cascadia Code", ui-monospace, Menlo, Consolas, monospace;
}

html.dark, html[data-theme="dark"], body.dark, body[data-theme="dark"] {
  --cc-bg: #262624;
  --cc-bg-elevated: #30302e;
  --cc-bg-card: #30302e;
  --cc-bg-user: #3a3a37;
  --cc-bg-code: #1a1a18;
  --cc-bg-code-header: #252524;
  --cc-text: #faf9f5;
  --cc-text-secondary: #e8e6dc;
  --cc-text-muted: #a8a8a2;
  --cc-border: #3d3c38;
  --cc-border-strong: #535350;
  --cc-accent: #d97757;
  --cc-accent-hover: #e08d70;
  --cc-accent-bg: rgba(217, 119, 87, 0.12);
  --cc-accent-border: rgba(217, 119, 87, 0.3);
  --cc-blue: #7cb3e8;
  --cc-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  --cc-shadow-lg: 0 4px 16px rgba(0, 0, 0, 0.4);
}

/* ── Base reset ── */
html, body {
  background: var(--cc-bg) !important;
  color: var(--cc-text) !important;
  font-family: var(--cc-font-sans) !important;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
body *, body *::before, body *::after {
  font-family: var(--cc-font-sans);
  transition: none !important;
  animation-duration: 0s !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}
body *:not(svg):not(svg *):not(img):not(video):not(canvas):not(pre):not(pre *) {
  background-image: none !important;
}
body *:not([class*="shadow"]):not(#cc-export-btn):not(#cc-status) {
  box-shadow: none !important;
}

/* ── Scrollbars ── */
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: var(--cc-border-strong);
  border-radius: 10px;
  border: 2px solid var(--cc-bg);
}
::-webkit-scrollbar-thumb:hover { background: var(--cc-text-muted); }

/* ── Sidebar ── */
aside, nav, [data-sidebar], [data-testid*="sidebar"], [class*="Sidebar"] {
  background: var(--cc-bg) !important;
  border-right: 1px solid var(--cc-border) !important;
  color: var(--cc-text-secondary) !important;
  font-size: 13px !important;
}
aside *, nav * { border-color: var(--cc-border) !important; }

/* ── Chat container ── */
[role="log"] {
  background: var(--cc-bg) !important;
  padding: 32px max(24px, calc(50vw - 400px)) 140px !important;
  font-size: 15px !important;
  line-height: 1.65 !important;
  scroll-behavior: auto !important;
  scroll-padding-top: 24px !important;
}
[role="log"] > * {
  background: transparent !important;
  border: none !important;
}

/* ── Message cards ── */
[role="log"] > [data-cc-role] {
  max-width: 800px;
  margin: 0 auto;
  padding: 24px 0;
  border-bottom: 1px solid var(--cc-border) !important;
}
[role="log"] > [data-cc-role]:last-child {
  border-bottom: none !important;
}

/* Role header */
[data-cc-role]::before {
  display: block;
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 10px;
  letter-spacing: -0.005em;
}
[data-cc-role="user"]::before {
  content: attr(data-cc-label);
  color: var(--cc-blue);
}
[data-cc-role="assistant"]::before {
  content: "✦  " attr(data-cc-label);
  color: var(--cc-accent);
}

/* User message tint */
[data-cc-role="user"] {
  position: relative;
}
[data-cc-role="user"] > * {
  color: var(--cc-text) !important;
}

/* ── Thinking blocks (Radix Collapsible) ── */
button[data-state] {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: var(--cc-accent-bg) !important;
  border: 1px solid var(--cc-accent-border) !important;
  border-radius: 8px !important;
  padding: 6px 12px !important;
  color: var(--cc-accent) !important;
  font-size: 13px !important;
  font-weight: 500 !important;
  cursor: pointer;
}
button[data-state="closed"]::before {
  content: "✦";
  color: var(--cc-accent);
  opacity: 0.7;
}
button[data-state="open"]::before {
  content: "✦";
  color: var(--cc-accent);
  animation: cc-pulse 1.6s ease-in-out infinite !important;
}
button[data-state]:hover {
  background: var(--cc-accent-border) !important;
}

@keyframes cc-pulse {
  0%, 100% { opacity: 0.4; }
  50%      { opacity: 1; }
}

/* Thinking content panel */
[data-state="open"] + *,
[data-state="open"] ~ .not-prose {
  background: var(--cc-accent-bg) !important;
  border-left: 2px solid var(--cc-accent-border) !important;
  padding: 12px 16px !important;
  border-radius: 0 8px 8px 0 !important;
  margin: 8px 0 !important;
  color: var(--cc-text-secondary) !important;
  font-size: 14px !important;
}

/* ── Code blocks ── */
pre {
  background: var(--cc-bg-code) !important;
  border: 1px solid var(--cc-bg-code-header) !important;
  border-radius: 10px !important;
  padding: 16px !important;
  overflow-x: auto !important;
  font-family: var(--cc-font-code) !important;
  font-size: 13px !important;
  line-height: 1.55 !important;
  margin: 12px 0 !important;
}
pre[data-cc-lang]::before {
  content: attr(data-cc-lang);
  display: block;
  font-family: var(--cc-font-sans) !important;
  font-size: 11px !important;
  font-weight: 600 !important;
  color: var(--cc-text-muted) !important;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-bottom: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--cc-bg-code-header) !important;
}
pre code {
  background: transparent !important;
  color: #e8e6dc !important;
  font-family: var(--cc-font-code) !important;
  border: none !important;
  padding: 0 !important;
}
pre * { font-family: var(--cc-font-code) !important; }

code:not(pre code) {
  background: var(--cc-bg-user) !important;
  color: var(--cc-accent) !important;
  padding: 2px 6px !important;
  border-radius: 5px !important;
  font-family: var(--cc-font-code) !important;
  font-size: 0.9em !important;
  border: 1px solid var(--cc-border) !important;
}

/* ── Prose ── */
.prose, [class*="prose"] {
  color: var(--cc-text) !important;
  max-width: none !important;
}
.prose :where(p, ul, ol, blockquote, table) {
  margin: 10px 0 !important;
}
.prose h1, .prose h2, .prose h3, .prose h4 {
  color: var(--cc-text) !important;
  font-weight: 700 !important;
  letter-spacing: -0.02em !important;
  margin: 20px 0 10px !important;
}
.prose h1 { font-size: 1.5em !important; }
.prose h2 { font-size: 1.3em !important; }
.prose h3 { font-size: 1.15em !important; }
.prose a {
  color: var(--cc-accent) !important;
  text-decoration: underline !important;
  text-underline-offset: 2px !important;
}
.prose a:hover { color: var(--cc-accent-hover) !important; }
.prose strong, .prose b { color: var(--cc-text) !important; font-weight: 600 !important; }
.prose blockquote {
  border-left: 3px solid var(--cc-border-strong) !important;
  padding-left: 16px !important;
  color: var(--cc-text-secondary) !important;
  font-style: italic;
}
.prose ul, .prose ol { padding-left: 22px !important; }
.prose li { margin: 4px 0 !important; }
.prose hr {
  border: none !important;
  border-top: 1px solid var(--cc-border) !important;
  margin: 20px 0 !important;
}
.prose table {
  border-collapse: collapse !important;
  width: 100% !important;
}
.prose th, .prose td {
  border: 1px solid var(--cc-border) !important;
  padding: 8px 12px !important;
  text-align: left !important;
}
.prose th { background: var(--cc-bg-user) !important; font-weight: 600 !important; }

/* ── Composer ── */
textarea:not(.g-recaptcha-response),
[contenteditable="true"],
[role="textbox"]:not([role="log"] *),
[data-testid*="composer"],
[data-testid*="prompt"] {
  background: var(--cc-bg-elevated) !important;
  color: var(--cc-text) !important;
  border: 1px solid var(--cc-border-strong) !important;
  border-radius: 14px !important;
  padding: 14px 16px !important;
  font-family: var(--cc-font-sans) !important;
  font-size: 15px !important;
  caret-color: var(--cc-accent) !important;
  box-shadow: var(--cc-shadow) !important;
}
textarea:not(.g-recaptcha-response):focus,
[contenteditable="true"]:focus {
  outline: none !important;
  border-color: var(--cc-accent) !important;
  box-shadow: 0 0 0 3px var(--cc-accent-bg) !important;
}
textarea::placeholder { color: var(--cc-text-muted) !important; }

/* ── Buttons ── */
button:not([data-state]):not(#cc-export-btn) {
  background: var(--cc-bg-elevated) !important;
  color: var(--cc-text) !important;
  border: 1px solid var(--cc-border) !important;
  border-radius: 8px !important;
  padding: 6px 12px !important;
  font-family: var(--cc-font-sans) !important;
  font-size: 13px !important;
  font-weight: 500 !important;
  cursor: pointer;
}
button:not([data-state]):not(#cc-export-btn):hover {
  background: var(--cc-bg-user) !important;
  border-color: var(--cc-border-strong) !important;
}

/* ── Kill leftovers ── */
[class*="backdrop-blur"] { backdrop-filter: none !important; }
[class*="animate-"] { animation: none !important; }
[data-cc-hidden="1"] { display: none !important; }

/* ── Containment ── */
[role="log"] > [data-cc-role] { contain: layout style; }
pre, code { contain: layout style; }
`;
	}

	function injectCSS() {
		let el = document.getElementById(STYLE_ID);
		if (!el) {
			el = document.createElement("style");
			el.id = STYLE_ID;
			(document.head || document.documentElement).appendChild(el);
		}
		el.textContent = themeCSS();
	}
	injectCSS();

	// ═══════════════════════════════════════════════════════════════════
	// DOM HELPERS
	// ═══════════════════════════════════════════════════════════════════
	const LOG_SELECTOR = '[role="log"]';

	function getContainer() {
		const logs = document.querySelectorAll(LOG_SELECTOR);
		if (!logs.length) return null;
		let best = logs[0];
		for (const el of logs) if (el.children.length > best.children.length) best = el;
		return best;
	}

	function isReversed(container) {
		return /\bflex-col-reverse\b/.test(container.className || "");
	}

	function getMessages(container) {
		if (!container) return [];
		return Array.from(container.children).filter((el) => {
			if (!(el instanceof HTMLElement)) return false;
			if (el.classList.contains("h-0")) return false;
			if (el.hidden) return false;
			return true;
		});
	}

	// Role detection: layered heuristics tuned to Arena's DOM
	function detectRole(msg) {
		const attr =
			msg.getAttribute("data-message-author-role") ||
			msg.getAttribute("data-role") ||
			msg.getAttribute("data-author");
		if (attr) return /user/i.test(attr) ? "user" : "assistant";

		const testId = msg.getAttribute("data-testid") || "";
		if (/user/i.test(testId)) return "user";
		if (/assistant|ai|model|bot/i.test(testId)) return "assistant";

		const cls = typeof msg.className === "string" ? msg.className : "";
		if (/user-message|human-turn|font-user/i.test(cls)) return "user";
		if (/assistant-message|ai-message|bot-message|model-message/i.test(cls)) return "assistant";

		// Thinking blocks are assistant-only in Arena
		if (msg.querySelector('button[data-state]')) return "assistant";

		// Rendered markdown (prose) is assistant-only
		if (msg.querySelector('.prose, [class*="prose"], .markdown, [class*="markdown"]')) return "assistant";

		// Short messages without code are usually user prompts
		const text = msg.textContent || "";
		if (text.length < 200 && !msg.querySelector("pre")) return "user";

		return "assistant";
	}

	function classify(container) {
		const msgs = getMessages(container);
		for (const msg of msgs) {
			if (!msg.dataset.ccRole) msg.dataset.ccRole = detectRole(msg);
			msg.dataset.ccLabel = msg.dataset.ccRole === "user" ? "You" : "Assistant";
		}
		return msgs;
	}

	// Add language labels to code blocks
	function labelCodeBlocks(msg) {
		msg.querySelectorAll("pre:not([data-cc-lang])").forEach((pre) => {
			const code = pre.querySelector("code");
			if (!code) return;
			const cls = code.className || "";
			const lang =
				(code.getAttribute("data-language") ||
					(cls.match(/language-([\w-]+)/) || [])[1] ||
					"").toLowerCase();
			if (lang) pre.setAttribute("data-cc-lang", lang);
		});
	}

	// ═══════════════════════════════════════════════════════════════════
	// VIRTUALIZATION
	// ═══════════════════════════════════════════════════════════════════
	function flattenShiki(msg) {
		if (!cfg.flattenCode) return 0;
		let n = 0;
		msg.querySelectorAll('pre.shiki code:not([data-cc-flat="1"])').forEach((code) => {
			if (!code.children.length) return;
			const lines = code.querySelectorAll(".line");
			const text = lines.length
				? Array.from(lines).map((l) => l.textContent).join("\n")
				: code.textContent;
			code.innerHTML = "";
			code.textContent = text;
			code.dataset.ccFlat = "1";
			n++;
		});
		return n;
	}

	function virtualize() {
		const container = getContainer();
		if (!container) return;

		const msgs = classify(container);
		msgs.forEach(labelCodeBlocks);

		if (!cfg.virtualize) {
			msgs.forEach((m) => delete m.dataset.ccHidden);
			updateStatus(msgs.length, 0);
			return;
		}

		const total = msgs.length;
		const keep = Math.max(1, cfg.visibleMessages);
		const reversed = isReversed(container);
		let hidden = 0;

		msgs.forEach((msg, i) => {
			const isNewest = reversed ? i < keep : i >= total - keep;
			if (isNewest) {
				if (msg.dataset.ccHidden) delete msg.dataset.ccHidden;
			} else {
				if (!msg.dataset.ccHidden) {
					flattenShiki(msg);
					msg.dataset.ccHidden = "1";
				}
				hidden++;
			}
		});

		updateStatus(total, hidden);
	}

	// ═══════════════════════════════════════════════════════════════════
	// HTML → MARKDOWN
	// ═══════════════════════════════════════════════════════════════════
	function htmlToMarkdown(root) {
		const out = [];
		const BLOCK = new Set(["p", "div", "section", "article", "ul", "ol", "table", "tr", "blockquote"]);

		function walk(node) {
			if (node.nodeType === Node.TEXT_NODE) {
				out.push(node.nodeValue.replace(/\s+/g, " "));
				return;
			}
			if (node.nodeType !== Node.ELEMENT_NODE) return;

			const tag = node.tagName.toLowerCase();
			if (["script", "style", "svg", "noscript", "button"].includes(tag)) return;
			if (node.getAttribute("aria-hidden") === "true") return;

			if (tag === "pre") {
				const code = node.querySelector("code") || node;
				const cls = code.className || "";
				const lang =
					node.getAttribute("data-cc-lang") ||
					code.getAttribute("data-language") ||
					(cls.match(/language-([\w-]+)/) || [])[1] ||
					"";
				const text = (code.innerText || code.textContent || "").replace(/\n$/, "");
				out.push(`\n\`\`\`${lang}\n${text}\n\`\`\`\n\n`);
				return;
			}

			if (tag === "code") {
				out.push("`" + (node.textContent || "") + "`");
				return;
			}
			if (tag === "br") { out.push("\n"); return; }

			if (/^h[1-6]$/.test(tag)) {
				out.push("\n" + "#".repeat(Number(tag[1])) + " ");
				node.childNodes.forEach(walk);
				out.push("\n\n");
				return;
			}

			if (tag === "strong" || tag === "b") {
				out.push("**"); node.childNodes.forEach(walk); out.push("**");
				return;
			}
			if (tag === "em" || tag === "i") {
				out.push("*"); node.childNodes.forEach(walk); out.push("*");
				return;
			}

			if (tag === "a") {
				const href = node.getAttribute("href") || "";
				out.push("[");
				node.childNodes.forEach(walk);
				out.push(`](${href})`);
				return;
			}

			if (tag === "li") {
				const ordered = node.parentElement && node.parentElement.tagName.toLowerCase() === "ol";
				out.push(ordered ? "1. " : "- ");
				node.childNodes.forEach(walk);
				out.push("\n");
				return;
			}

			if (tag === "blockquote") {
				const save = out.length;
				node.childNodes.forEach(walk);
				const text = out.splice(save).join("").trim();
				text.split("\n").forEach((l) => out.push("> " + l + "\n"));
				return;
			}

			if (tag === "hr") { out.push("\n---\n\n"); return; }

			if (BLOCK.has(tag)) {
				node.childNodes.forEach(walk);
				if (tag === "p" || tag === "div") out.push("\n");
				return;
			}

			node.childNodes.forEach(walk);
		}

		walk(root);
		return out.join("")
			.replace(/[ \t]+\n/g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
	}

	// ═══════════════════════════════════════════════════════════════════
	// EXPORT
	// ═══════════════════════════════════════════════════════════════════
	function exportMarkdown() {
		const container = getContainer();
		if (!container) { alert("No chat found to export."); return; }

		const msgs = classify(container);
		const reversed = isReversed(container);
		const ordered = reversed ? [...msgs].reverse() : msgs;

		const pageTitle = (document.title || "arena-chat")
			.replace(/\s*[|\-–—].*$/, "")
			.trim() || "arena-chat";
		const date = new Date().toISOString().slice(0, 10);

		let md = `# ${pageTitle}\n\n`;
		md += `> Exported from ${location.href}\n`;
		md += `> ${new Date().toISOString()}\n\n---\n\n`;

		ordered.forEach((msg, i) => {
			const role = msg.dataset.ccRole === "user" ? "You" : "Assistant";
			const body = htmlToMarkdown(msg);
			md += `## ${i + 1}. ${role}\n\n${body || "_(empty)_"}\n\n---\n\n`;
		});

		const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = `${pageTitle.replace(/[^\w.-]+/g, "-")}-${date}.md`;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(a.href), 1000);
	}

	// ═══════════════════════════════════════════════════════════════════
	// UI
	// ═══════════════════════════════════════════════════════════════════
	const EXPORT_ID = "cc-export-btn";
	const STATUS_ID = "cc-status";
	const POPOVER_ID = "cc-settings";

	function injectUI() {
		if (cfg.showExport && !document.getElementById(EXPORT_ID)) {
			const btn = document.createElement("button");
			btn.id = EXPORT_ID;
			btn.innerHTML = `
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/>
				</svg>
				<span>Export .md</span>`;
			btn.title = "Export chat as Markdown";
			btn.style.cssText = `
				position: fixed;
				right: 20px;
				bottom: 20px;
				z-index: 2147483647;
				display: inline-flex;
				align-items: center;
				gap: 8px;
				padding: 10px 16px;
				background: var(--cc-bg-elevated);
				color: var(--cc-text);
				border: 1px solid var(--cc-border-strong);
				border-radius: 10px;
				font-family: var(--cc-font-sans);
				font-size: 13px;
				font-weight: 500;
				cursor: pointer;
				box-shadow: var(--cc-shadow-lg);
				transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease !important;
			`;
			btn.addEventListener("mouseenter", () => {
				btn.style.background = "var(--cc-accent)";
				btn.style.color = "#ffffff";
				btn.style.borderColor = "var(--cc-accent)";
			});
			btn.addEventListener("mouseleave", () => {
				btn.style.background = "var(--cc-bg-elevated)";
				btn.style.color = "var(--cc-text)";
				btn.style.borderColor = "var(--cc-border-strong)";
			});
			btn.addEventListener("click", exportMarkdown);
			document.body.appendChild(btn);
		}

		if (cfg.showStatus && !document.getElementById(STATUS_ID)) {
			const bar = document.createElement("div");
			bar.id = STATUS_ID;
			bar.style.cssText = `
				position: fixed;
				left: 20px;
				bottom: 20px;
				z-index: 2147483646;
				padding: 6px 10px;
				background: var(--cc-bg-elevated);
				color: var(--cc-text-muted);
				border: 1px solid var(--cc-border);
				border-radius: 8px;
				font-family: var(--cc-font-sans);
				font-size: 12px;
				box-shadow: var(--cc-shadow);
				cursor: pointer;
				user-select: none;
				transition: color 0.15s ease !important;
			`;
			bar.textContent = "Arena · Coding Edition";
			bar.title = "Click to configure";
			bar.addEventListener("click", toggleSettings);
			bar.addEventListener("mouseenter", () => (bar.style.color = "var(--cc-text)"));
			bar.addEventListener("mouseleave", () => (bar.style.color = "var(--cc-text-muted)"));
			document.body.appendChild(bar);
		}
	}

	function updateStatus(total, hidden) {
		const bar = document.getElementById(STATUS_ID);
		if (!bar) return;
		const label = `Arena · ${total} msg${total === 1 ? "" : "s"}`;
		bar.textContent = hidden > 0 ? `${label} · ${hidden} hidden` : label;
	}

	function toggleSettings() {
		const existing = document.getElementById(POPOVER_ID);
		if (existing) { existing.remove(); return; }

		const panel = document.createElement("div");
		panel.id = POPOVER_ID;
		panel.style.cssText = `
			position: fixed;
			left: 20px;
			bottom: 60px;
			z-index: 2147483647;
			min-width: 240px;
			padding: 16px;
			background: var(--cc-bg-elevated);
			color: var(--cc-text);
			border: 1px solid var(--cc-border-strong);
			border-radius: 12px;
			font-family: var(--cc-font-sans);
			font-size: 13px;
			box-shadow: var(--cc-shadow-lg);
		`;

		const title = document.createElement("div");
		title.textContent = "Coding Edition";
		title.style.cssText = "font-weight:600;font-size:14px;margin-bottom:12px;";
		panel.appendChild(title);

		function row(label, on) {
			const r = document.createElement("div");
			r.style.cssText = "display:flex;justify-content:space-between;padding:6px 0;color:var(--cc-text-secondary);";
			r.innerHTML = `<span>${label}</span><span style="color:${on ? "var(--cc-accent)" : "var(--cc-text-muted)"};font-weight:600">${on ? "on" : "off"}</span>`;
			return r;
		}

		const vRow = row(`Visible messages`, false);
		vRow.querySelector("span:last-child").textContent = cfg.visibleMessages;
		vRow.querySelector("span:last-child").style.color = "var(--cc-accent)";
		vRow.style.cursor = "pointer";
		vRow.addEventListener("click", () => {
			const n = parseInt(prompt("Visible messages:", cfg.visibleMessages), 10);
			if (n && n > 0) {
				cfg.visibleMessages = n;
				saveConfig();
				vRow.querySelector("span:last-child").textContent = n;
				virtualize();
			}
		});
		panel.appendChild(vRow);

		function toggleRow(label, key) {
			const r = row(label, cfg[key]);
			r.style.cursor = "pointer";
			r.addEventListener("click", () => {
				cfg[key] = !cfg[key];
				saveConfig();
				r.querySelector("span:last-child").textContent = cfg[key] ? "on" : "off";
				r.querySelector("span:last-child").style.color = cfg[key] ? "var(--cc-accent)" : "var(--cc-text-muted)";
				virtualize();
			});
			panel.appendChild(r);
		}
		toggleRow("Virtualize", "virtualize");
		toggleRow("Flatten code", "flattenCode");

		document.body.appendChild(panel);
		setTimeout(() => {
			const close = (e) => {
				if (!panel.contains(e.target) && e.target.id !== STATUS_ID) {
					panel.remove();
					document.removeEventListener("mousedown", close);
				}
			};
			document.addEventListener("mousedown", close);
		}, 0);
	}

	// ═══════════════════════════════════════════════════════════════════
	// OBSERVER + INIT
	// ═══════════════════════════════════════════════════════════════════
	let timer = null;
	function schedule() {
		if (timer) clearTimeout(timer);
		timer = setTimeout(virtualize, 200);
	}

	function startObserver() {
		const obs = new MutationObserver(() => schedule());
		obs.observe(document.body, { childList: true, subtree: true });
	}

	let started = false;
	function init() {
		if (started || document.visibilityState !== "visible") return;
		if (!getContainer()) return;
		started = true;

		injectUI();
		schedule();
		startObserver();

		setTimeout(schedule, 1000);
		setTimeout(schedule, 3000);
		setInterval(schedule, 5000);
	}

	function waitForLog() {
		if (getContainer()) { init(); return; }
		const obs = new MutationObserver(() => {
			if (getContainer()) {
				obs.disconnect();
				setTimeout(init, 300);
			}
		});
		obs.observe(document.body, { childList: true, subtree: true });
	}

	if (document.body) {
		waitForLog();
	} else {
		const bodyObs = new MutationObserver(() => {
			if (document.body) {
				bodyObs.disconnect();
				waitForLog();
			}
		});
		bodyObs.observe(document.documentElement, { childList: true });
	}

	// Emergency init for empty chats
	setTimeout(() => {
		if (!started) {
			started = true;
			injectUI();
			startObserver();
		}
	}, 6000);

	// Re-inject UI if React nukes it
	setInterval(() => {
		if (started && !document.getElementById(EXPORT_ID)) injectUI();
	}, 3000);
})();