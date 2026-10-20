// ==UserScript==
// @name         Arena.ai | Coding Edition
// @namespace    https://greasyfork.org/en/users/1462137-piknockyou
// @version      3.2.0
// @author       Piknockyou (vibe-coded)
// @license      AGPL-3.0
// @description  Virtualizes old messages, strips heavy CSS, auto-scrolls, collapses old thinking, shows token stats, and sends agent actions (PR/merge/clear) through the composer. Export as Markdown.
// @match        *://*.arena.ai/*
// @match        *://*.canaryarena.ai/*
// @match        *://chat.lmsys.org/*
// @match        https://arena.ai
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
		autoScroll: true,
		collapseOldThinking: true,
		showExport: true,
		contextWindow: 200000,
		hideComposer: false,
		composerSelector: "",
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
	// PERF CSS
	// ═══════════════════════════════════════════════════════════════════
	const STYLE_ID = "cc-perf";
	function injectPerfCSS() {
		let el = document.getElementById(STYLE_ID);
		if (!el) {
			el = document.createElement("style");
			el.id = STYLE_ID;
			(document.head || document.documentElement).appendChild(el);
		}
		el.textContent = `
			[class*="backdrop-blur"], [style*="backdrop-filter"] {
				backdrop-filter: none !important;
				-webkit-backdrop-filter: none !important;
			}
			[data-cc-hidden="1"] { display: none !important; }
		`;
	}
	injectPerfCSS();

	// ═══════════════════════════════════════════════════════════════════
	// TOAST
	// ═══════════════════════════════════════════════════════════════════
	function toast(msg, kind = "info", ms = 3000) {
		const t = document.createElement("div");
		t.textContent = msg;
		t.style.cssText = `
			position: fixed; bottom: 90px; left: 50%; transform: translateX(-50%);
			padding: 10px 18px; border-radius: 8px;
			font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
			color: #fff; z-index: 2147483647;
			box-shadow: 0 4px 16px rgba(0,0,0,0.2);
			background: #333; opacity: 0; transition: opacity 0.2s ease;
			max-width: 80vw; text-align: center; line-height: 1.4;
		`;
		if (kind === "error") t.style.background = "#c62828";
		if (kind === "success") t.style.background = "#2e7d32";
		document.body.appendChild(t);
		requestAnimationFrame(() => { t.style.opacity = "1"; });
		setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 300); }, ms);
	}

	// ═══════════════════════════════════════════════════════════════════
	// DOM: container + messages
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

	function isMsgNode(el) {
		if (!(el instanceof HTMLElement)) return false;
		if (el.classList.contains("h-0")) return false;
		if (el.hidden) return false;
		return true;
	}

	// Detect: if direct children don't look like messages, dig one level.
	function getMessages(container) {
		if (!container) return [];
		const direct = Array.from(container.children).filter(isMsgNode);

		const looksLikeMsgs = direct.some((el) => {
			const txt = (el.textContent || "").trim();
			return (
				txt.length > 30 ||
				el.querySelector("pre, .prose, [class*='prose'], button[data-state]")
			);
		});

		if (direct.length >= 2 && looksLikeMsgs) return direct;

		// Try one level deeper
		for (const child of direct) {
			const nested = Array.from(child.children).filter(isMsgNode);
			if (nested.length >= 2) return nested;
		}
		return direct;
	}

	// ═══════════════════════════════════════════════════════════════════
	// COMPOSER FINDER (robust, scored)
	// ═══════════════════════════════════════════════════════════════════
	function findComposer() {
		// Manual override
		if (cfg.composerSelector) {
			try {
				const el = document.querySelector(cfg.composerSelector);
				if (el) return el;
			} catch (_) {}
		}

		const candidates = [];
		const all = document.querySelectorAll(
			'textarea, input[type="text"], input:not([type]), [contenteditable="true"], [contenteditable=""], [contenteditable], [role="textbox"], [role="combobox"]'
		);

		for (const el of all) {
			if (el.matches(".g-recaptcha-response")) continue;
			if (el.getAttribute("aria-hidden") === "true") continue;
			if (el.disabled) continue;
			if (el.readOnly) continue;

			const r = el.getBoundingClientRect();
			if (r.width < 60 || r.height < 14) continue;
			if (r.bottom < 0 || r.top > window.innerHeight) continue;

			let score = 0;
			// Strong preference: bottom half of viewport (chat composer)
			if (r.top > window.innerHeight * 0.4) score += 20;
			if (r.top > window.innerHeight * 0.6) score += 10;
			// Wide = multi-line composer
			if (r.width > 200) score += 10;
			if (r.width > 400) score += 5;
			// Actual textarea is preferred over input
			if (el.tagName === "TEXTAREA") score += 8;
			if (el.isContentEditable) score += 6;
			// Not in header/nav
			if (!el.closest("header, [role='banner'], nav, aside")) score += 10;
			// Not inside role=log (messages contain no editor)
			if (!el.closest('[role="log"]')) score += 15;

			candidates.push({ el, score });
		}

		candidates.sort((a, b) => b.score - a.score);
		return candidates[0]?.el || null;
	}

	function setComposerValue(input, text) {
		input.focus();
		if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
			const proto = input.tagName === "TEXTAREA"
				? HTMLTextAreaElement.prototype
				: HTMLInputElement.prototype;
			const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
			setter.call(input, text);
			input.dispatchEvent(new Event("input", { bubbles: true }));
			input.dispatchEvent(new Event("change", { bubbles: true }));
		} else if (input.isContentEditable) {
			input.innerText = text;
			input.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
		}
	}

	function submitComposer(input) {
		setTimeout(() => {
			const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
			input.dispatchEvent(new KeyboardEvent("keydown", opts));
			input.dispatchEvent(new KeyboardEvent("keypress", opts));
			input.dispatchEvent(new KeyboardEvent("keyup", opts));

			// Also try a send button near the input
			setTimeout(() => {
				const r = input.getBoundingClientRect();
				const sendSelectors = [
					'button[aria-label*="send" i]',
					'button[data-testid*="send" i]',
					'button[type="submit"]',
				];
				for (const sel of sendSelectors) {
					const btn = document.querySelector(sel);
					if (btn && btn.getBoundingClientRect().width > 0) {
						btn.click();
						return;
					}
				}
				// Fallback: button near input
				const buttons = document.querySelectorAll("button");
				for (const btn of buttons) {
					const br = btn.getBoundingClientRect();
					if (Math.abs(br.bottom - r.bottom) < 60 && br.left >= r.right - 60 && br.width > 0) {
						btn.click();
						return;
					}
				}
			}, 120);
		}, 60);
	}

	function sendAgentMessage(text) {
		const input = findComposer();
		if (!input) return false;
		setComposerValue(input, text);
		submitComposer(input);
		return true;
	}

	async function copyText(text) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch (_) { return false; }
	}

	// ═══════════════════════════════════════════════════════════════════
	// VIRTUALIZE
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
		const msgs = getMessages(container);
		if (!cfg.virtualize) { msgs.forEach((m) => delete m.dataset.ccHidden); return; }
		const total = msgs.length;
		const keep = Math.max(1, cfg.visibleMessages);
		const reversed = isReversed(container);
		msgs.forEach((msg, i) => {
			const isNewest = reversed ? i < keep : i >= total - keep;
			if (isNewest) {
				if (msg.dataset.ccHidden) delete msg.dataset.ccHidden;
			} else if (!msg.dataset.ccHidden) {
				flattenShiki(msg);
				msg.dataset.ccHidden = "1";
			}
		});
	}

	// ═══════════════════════════════════════════════════════════════════
	// THINKING AUTO-COLLAPSE
	// ═══════════════════════════════════════════════════════════════════
	let lastMsgCount = 0;
	function isThinkingButton(btn) {
		if (!btn) return false;
		const txt = (btn.textContent || "").trim().toLowerCase();
		return txt && /think|thought|reason|chain[-\s]of[-\s]thought/.test(txt);
	}
	function collapseOldThinking(container) {
		if (!cfg.collapseOldThinking) return;
		if (!container) return;
		const msgs = getMessages(container);
		const currentCount = msgs.length;
		if (currentCount <= lastMsgCount) { lastMsgCount = currentCount; return; }
		const reversed = isReversed(container);
		const newestIdx = reversed ? 0 : currentCount - 1;
		let collapsed = 0;
		msgs.forEach((msg, i) => {
			if (i === newestIdx) return;
			msg.querySelectorAll('button[data-state="open"], button[aria-expanded="true"]').forEach((btn) => {
				if (!isThinkingButton(btn)) return;
				try { btn.click(); collapsed++; } catch (_) {}
			});
		});
		if (collapsed) console.log(`[Coding Edition] Collapsed ${collapsed} thinking block(s).`);
		lastMsgCount = currentCount;
	}

	// ═══════════════════════════════════════════════════════════════════
	// AUTO-SCROLL
	// ═══════════════════════════════════════════════════════════════════
	const JUMP_ID = "cc-jump-bottom";
	let scrollObserver = null;
	function isNearBottom(c, t = 150) { return c.scrollHeight - c.scrollTop - c.clientHeight < t; }
	function scrollToBottom(c, smooth) {
		if (!c) return;
		if (smooth) c.scrollTo({ top: c.scrollHeight, behavior: "smooth" });
		else c.scrollTop = c.scrollHeight;
	}
	function updateJumpButton(show) {
		let btn = document.getElementById(JUMP_ID);
		if (show && !btn) {
			btn = document.createElement("button");
			btn.id = JUMP_ID; btn.textContent = "↓"; btn.title = "Jump to latest";
			btn.style.cssText = `position:fixed;right:20px;bottom:80px;z-index:2147483647;width:36px;height:36px;border-radius:50%;background:#fff;color:#1a1a1a;border:1px solid #d4d4d4;box-shadow:0 2px 8px rgba(0,0,0,0.12);cursor:pointer;font:16px/1 -apple-system,sans-serif;display:flex;align-items:center;justify-content:center;padding:0;`;
			btn.addEventListener("click", () => { scrollToBottom(getContainer(), true); btn.remove(); });
			document.body.appendChild(btn);
		} else if (!show && btn) btn.remove();
	}
	function setupAutoScroll(c) {
		if (!c || !cfg.autoScroll) return;
		if (c.dataset.ccScrollHooked) return;
		c.dataset.ccScrollHooked = "1";
		let stick = true;
		c.addEventListener("scroll", () => { stick = isNearBottom(c); updateJumpButton(!stick); }, { passive: true });
		if (scrollObserver) scrollObserver.disconnect();
		scrollObserver = new MutationObserver(() => {
			if (stick) requestAnimationFrame(() => { if (stick) scrollToBottom(c, false); });
			else updateJumpButton(true);
		});
		scrollObserver.observe(c, { childList: true, subtree: true, characterData: true });
		requestAnimationFrame(() => { if (stick) scrollToBottom(c, false); });
	}
	function teardownAutoScroll() {
		if (scrollObserver) { scrollObserver.disconnect(); scrollObserver = null; }
		const btn = document.getElementById(JUMP_ID); if (btn) btn.remove();
	}

	// ═══════════════════════════════════════════════════════════════════
	// MARKDOWN
	// ═══════════════════════════════════════════════════════════════════
	function htmlToMarkdown(root) {
		const out = [];
		const BLOCK = new Set(["p", "div", "section", "article", "ul", "ol", "table", "tr", "blockquote"]);
		function walk(node) {
			if (node.nodeType === Node.TEXT_NODE) { out.push(node.nodeValue.replace(/\s+/g, " ")); return; }
			if (node.nodeType !== Node.ELEMENT_NODE) return;
			const tag = node.tagName.toLowerCase();
			if (["script", "style", "svg", "noscript", "button"].includes(tag)) return;
			if (node.getAttribute("aria-hidden") === "true") return;
			if (tag === "pre") {
				const code = node.querySelector("code") || node;
				const cls = code.className || "";
				const lang = code.getAttribute("data-language") || (cls.match(/language-([\w-]+)/) || [])[1] || "";
				const text = (code.innerText || code.textContent || "").replace(/\n$/, "");
				out.push(`\n\`\`\`${lang}\n${text}\n\`\`\`\n\n`);
				return;
			}
			if (tag === "code") { out.push("`" + (node.textContent || "") + "`"); return; }
			if (tag === "br") { out.push("\n"); return; }
			if (/^h[1-6]$/.test(tag)) { out.push("\n" + "#".repeat(Number(tag[1])) + " "); node.childNodes.forEach(walk); out.push("\n\n"); return; }
			if (tag === "strong" || tag === "b") { out.push("**"); node.childNodes.forEach(walk); out.push("**"); return; }
			if (tag === "em" || tag === "i") { out.push("*"); node.childNodes.forEach(walk); out.push("*"); return; }
			if (tag === "a") { const href = node.getAttribute("href") || ""; out.push("["); node.childNodes.forEach(walk); out.push(`](${href})`); return; }
			if (tag === "li") {
				const ordered = node.parentElement && node.parentElement.tagName.toLowerCase() === "ol";
				out.push(ordered ? "1. " : "- "); node.childNodes.forEach(walk); out.push("\n"); return;
			}
			if (tag === "blockquote") {
				const save = out.length; node.childNodes.forEach(walk);
				const text = out.splice(save).join("").trim();
				text.split("\n").forEach((l) => out.push("> " + l + "\n")); return;
			}
			if (tag === "hr") { out.push("\n---\n\n"); return; }
			if (BLOCK.has(tag)) {
				node.childNodes.forEach(walk);
				if (tag === "p" || tag === "div") out.push("\n"); return;
			}
			node.childNodes.forEach(walk);
		}
		walk(root);
		return out.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
	}

	function exportMarkdown() {
		const container = getContainer();
		if (!container) { toast("No chat found to export.", "error"); return; }
		const msgs = getMessages(container);
		const reversed = isReversed(container);
		const ordered = reversed ? [...msgs].reverse() : msgs;
		const pageTitle = (document.title || "arena-chat").replace(/\s*[|\-–—].*$/, "").trim() || "arena-chat";
		const date = new Date().toISOString().slice(0, 10);
		let md = `# ${pageTitle}\n\n> Exported from ${location.href}\n> ${new Date().toISOString()}\n\n---\n\n`;
		ordered.forEach((msg, i) => {
			const body = htmlToMarkdown(msg);
			md += `## Message ${i + 1}\n\n${body || "_(empty)_"}\n\n---\n\n`;
		});
		const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = `${pageTitle.replace(/[^\w.-]+/g, "-")}-${date}.md`;
		document.body.appendChild(a); a.click(); a.remove();
		setTimeout(() => URL.revokeObjectURL(a.href), 1000);
		toast(`Exported ${ordered.length} messages.`, "success");
	}

	// ═══════════════════════════════════════════════════════════════════
	// ACTIONS (rewritten to use composer, not nonexistent buttons)
	// ═══════════════════════════════════════════════════════════════════
	async function actionCreatePR() {
		const msg = "Create a pull request for the current changes and give me the PR URL.";
		if (sendAgentMessage(msg)) toast("Sent to agent: create PR.", "success");
		else {
			const copied = await copyText(msg);
			toast(copied ? "Composer not found — message copied. Paste into chat." : "Composer not found. Type: " + msg, "error", 5000);
		}
	}

	async function actionMerge() {
		const msg = "Merge the current pull request into the main branch.";
		if (sendAgentMessage(msg)) toast("Sent to agent: merge.", "success");
		else {
			const copied = await copyText(msg);
			toast(copied ? "Composer not found — message copied. Paste into chat." : "Composer not found. Type: " + msg, "error", 5000);
		}
	}

	async function actionClearChat() {
	const container = getContainer();
	const before = container ? getMessages(container).length : 0;

	if (before === 0) {
		toast("Chat is already empty.", "info");
		return;
	}

	// Step 1: try to find and click a "New chat" button
	const btn = findNewChatButton();
	let clickedLabel = null;

	if (btn) {
		const label =
			(btn.textContent || "").trim().slice(0, 40) ||
			btn.getAttribute("aria-label") ||
			btn.getAttribute("title") ||
			btn.getAttribute("data-testid") ||
			"(icon button)";

		try {
			btn.click();
			clickedLabel = label;
			toast(`Clicked "${label}" — waiting…`, "info", 1000);
		} catch (e) {
			console.warn("[Coding Edition] New-chat click threw:", e);
		}

		// Verify the click actually did something
		await new Promise((r) => setTimeout(r, 900));
		const after = getContainer() ? getMessages(getContainer()).length : 0;
		if (after < before || after === 0) {
			toast(`Cleared (${before} → ${after}).`, "success");
			return;
		}
		console.log("[Coding Edition] Clear-click no-op:", { before, after });
	}

	// Step 2: hard navigation fallback
	const why = clickedLabel
		? `Clicked "${clickedLabel}" but the chat wasn't cleared (${before} messages still there).`
		: `No "New chat" button found in the sidebar (${before} messages present).`;

	toast(why, "error", 4000);
	await new Promise((r) => setTimeout(r, 400));

	if (confirm(`${why}\n\nReload to a fresh chat? Your current conversation stays in your history.`)) {
		try {
			location.assign("/");
		} catch (_) {
			location.reload();
		}
	}
}

function findNewChatButton() {
	const all = document.querySelectorAll('button, [role="button"], a, [role="menuitem"]');

	// Safe patterns only — generic words like "plus"/"compose" cause false matches
	const textPatterns = [
		"new chat",
		"new conversation",
		"start new chat",
		"start new conversation",
		"new thread",
		"new session",
		"clear chat",
		"clear conversation",
		"reset chat",
		"create new chat",
		"create chat",
	];

	const candidates = [];

	for (const el of all) {
		// Never match anything inside the message log (user might write "new chat")
		if (el.closest('[role="log"]')) continue;

		const text = (el.textContent || "").trim().toLowerCase();
		const aria = (el.getAttribute("aria-label") || "").toLowerCase();
		const title = (el.getAttribute("title") || "").toLowerCase();
		const testid = (el.getAttribute("data-testid") || "").toLowerCase();
		const combined = `${text} ${aria} ${title} ${testid}`;

		const hasMatch = textPatterns.some((p) => combined.includes(p));
		if (!hasMatch) continue;

		const r = el.getBoundingClientRect();
		if (r.width === 0 || r.height === 0) continue;

		// Score the candidate
		let score = 1;
		if (text.length > 0) score += 5;           // has visible text
		if (el.closest('aside, nav, [class*="sidebar" i], [data-sidebar], [role="navigation"]')) score += 5; // in sidebar
		if (r.top < 250) score += 3;               // near the top of the page
		if (el.tagName === "A") score += 1;        // links navigate reliably

		candidates.push({
			el,
			score,
			label: (text || aria || title || testid).slice(0, 40),
		});
	}

	candidates.sort((a, b) => b.score - a.score);

	if (candidates[0]) {
		console.log(
			"[Coding Edition] Clear-chat candidate:",
			candidates[0].label,
			"(score:", candidates[0].score + ")",
		);
	} else {
		console.warn("[Coding Edition] No clear-chat button found. Run Diagnostics.");
	}

	return candidates[0]?.el || null;
}

	async function actionDiagnostics() {
		const out = [];
		out.push("=== Coding Edition Diagnostics ===");
		out.push(`URL: ${location.href}`);
		out.push(`Viewport: ${window.innerWidth}x${window.innerHeight}`);

		const container = getContainer();
		out.push(`\n--- Container ---`);
		if (container) {
			out.push(`FOUND: <${container.tagName.toLowerCase()}> .${container.className}`);
			out.push(`  children: ${container.children.length}`);
			const msgs = getMessages(container);
			out.push(`  messages detected: ${msgs.length}`);
			if (msgs[0]) {
				const m = msgs[0];
				const txt = (m.textContent || "").trim().slice(0, 80);
				out.push(`  first msg: <${m.tagName.toLowerCase()}> text="${txt}..."`);
			}
		} else {
			out.push("NOT FOUND — no [role=log] on page.");
		}

		out.push(`\n--- Composer ---`);
		const input = findComposer();
		if (input) {
			const r = input.getBoundingClientRect();
			out.push(`FOUND: <${input.tagName.toLowerCase()}>`);
			out.push(`  id="${input.id}" class="${input.className}"`);
			out.push(`  rect: x=${r.x.toFixed(0)} y=${r.top.toFixed(0)} w=${r.width.toFixed(0)} h=${r.height.toFixed(0)}`);
			out.push(`  contentEditable=${input.isContentEditable}`);
		} else {
			out.push("NOT FOUND — no matching input found in viewport.");
			out.push("  Candidates seen:");
			document.querySelectorAll('textarea, [contenteditable], [role="textbox"], input').forEach(el => {
				const r = el.getBoundingClientRect();
				out.push(`    <${el.tagName.toLowerCase()}> class="${el.className}" w=${r.width.toFixed(0)} h=${r.height.toFixed(0)}`);
			});
		}

		out.push(`\n--- Visible buttons ---`);
		const btnData = [];
		document.querySelectorAll('button, [role="button"]').forEach(el => {
			const r = el.getBoundingClientRect();
			if (r.width === 0 || r.height === 0) return;
			if (r.top < 0 || r.top > window.innerHeight) return;
			const text = (el.textContent || "").trim().slice(0, 30);
			const aria = el.getAttribute("aria-label") || "";
			const testid = el.getAttribute("data-testid") || "";
			btnData.push(`  <button> text="${text}" aria="${aria}" testid="${testid}"`);
		});
		out.push(btnData.join("\n") || "  (none visible)");

		const text = out.join("\n");
		console.log(text);
		await copyText(text);
		toast("Diagnostics logged to console + copied to clipboard.", "success", 3500);
	}

	// ═══════════════════════════════════════════════════════════════════
	// COMPOSER VISIBILITY
	// ═══════════════════════════════════════════════════════════════════
	function applyComposerVisibility() {
		// Clear previous markers
		document.querySelectorAll('[data-cc-composer-hide="1"]').forEach(el => {
			el.style.removeProperty("display");
			el.removeAttribute("data-cc-composer-hide");
		});

		if (!cfg.hideComposer) return;

		const input = findComposer();
		if (!input) return;

		// Walk up to a wrapper that's ~viewport width but < 50% tall
		let target = input;
		for (let i = 0; i < 8; i++) {
			const p = target.parentElement;
			if (!p || p === document.body) break;
			const pr = p.getBoundingClientRect();
			if (pr.height > window.innerHeight * 0.5) break;
			if (pr.width < 200) break;
			target = p;
		}
		target.style.setProperty("display", "none", "important");
		target.setAttribute("data-cc-composer-hide", "1");
	}

	function toggleComposer() {
		cfg.hideComposer = !cfg.hideComposer;
		saveConfig();
		applyComposerVisibility();
		renderActiveTab();
		if (cfg.hideComposer && !findComposer()) {
			toast("Composer not detected — nothing to hide. Run Diagnostics to see why.", "error", 4000);
		} else {
			toast(cfg.hideComposer ? "Entry panel hidden." : "Entry panel shown.", "success");
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// EXPORT BUTTON (floating)
	// ═══════════════════════════════════════════════════════════════════
	const EXPORT_ID = "cc-export-btn";
	function injectExportButton() {
		if (!cfg.showExport || document.getElementById(EXPORT_ID)) return;
		const btn = document.createElement("button");
		btn.id = EXPORT_ID; btn.textContent = "⬇ export.md";
		btn.style.cssText = `position:fixed;right:20px;bottom:20px;z-index:2147483647;padding:8px 14px;background:#fff;color:#1a1a1a;border:1px solid #d4d4d4;border-radius:8px;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.12);`;
		btn.addEventListener("click", exportMarkdown);
		document.body.appendChild(btn);
	}
	function removeExportButton() { const b = document.getElementById(EXPORT_ID); if (b) b.remove(); }

	// ═══════════════════════════════════════════════════════════════════
	// STATISTICS
	// ═══════════════════════════════════════════════════════════════════
	function estimateTokens(c) { return Math.round(c / 4); }
	function fmtNum(n) {
		if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
		if (n >= 10_000) return (n / 1_000).toFixed(1) + "K";
		return n.toLocaleString();
	}
	function computeStats() {
		const container = getContainer();
		if (!container) return null;
		const msgs = getMessages(container);
		let totalChars = 0, visibleChars = 0, hiddenChars = 0;
		let visibleMsgs = 0, hiddenMsgs = 0, codeBlocks = 0, thinkingBlocks = 0;
		for (const msg of msgs) {
			const chars = (msg.textContent || "").length;
			totalChars += chars;
			if (msg.dataset.ccHidden === "1") { hiddenChars += chars; hiddenMsgs++; }
			else { visibleChars += chars; visibleMsgs++; }
			codeBlocks += msg.querySelectorAll("pre").length;
			thinkingBlocks += msg.querySelectorAll("button[data-state]").length;
		}
		const totalTokens = estimateTokens(totalChars);
		const max = cfg.contextWindow || DEFAULTS.contextWindow;
		return {
			totalMsgs: msgs.length, visibleMsgs, hiddenMsgs,
			totalChars, visibleChars, hiddenChars,
			totalTokens, visibleTokens: estimateTokens(visibleChars), hiddenTokens: estimateTokens(hiddenChars),
			contextWindow: max, contextPct: max > 0 ? (totalTokens / max) * 100 : 0,
			codeBlocks, thinkingBlocks,
		};
	}

	// ═══════════════════════════════════════════════════════════════════
	// DRAWER
	// ═══════════════════════════════════════════════════════════════════
	const DRAWER_ID = "cc-drawer";
	const DRAWER_TOGGLE_ID = "cc-drawer-toggle";
	const CHEVRON_RIGHT = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;
	const CHEVRON_LEFT = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`;

	let drawerOpen = false;
	let activeTab = "settings";

	function applyDrawerState() {
		const drawer = document.getElementById(DRAWER_ID);
		const toggle = document.getElementById(DRAWER_TOGGLE_ID);
		if (!drawer || !toggle) return;
		drawer.style.transform = drawerOpen ? "translateX(0)" : "translateX(-100%)";
		toggle.innerHTML = drawerOpen ? CHEVRON_LEFT : CHEVRON_RIGHT;
	}
	function toggleDrawer() {
		drawerOpen = !drawerOpen;
		applyDrawerState();
		if (drawerOpen) { renderActiveTab(); if (activeTab === "stats") updateStats(); }
	}
	function switchTab(tab) {
		activeTab = tab;
		const drawer = document.getElementById(DRAWER_ID);
		if (!drawer) return;
		drawer.querySelectorAll(".cc-drawer-tabs button").forEach((b) => {
			const isActive = b.dataset.tab === tab;
			b.style.color = isActive ? "#1a1a1a" : "#888";
			b.style.fontWeight = isActive ? "600" : "400";
			b.style.borderBottomColor = isActive ? "#d97757" : "transparent";
		});
		renderActiveTab();
		if (tab === "stats") updateStats();
	}

	function makeRow(opts) {
		const row = document.createElement("div");
		row.style.cssText = `display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:13px;${opts.onClick ? "cursor:pointer;" : ""}`;
		const label = document.createElement("span");
		label.textContent = opts.label; label.style.color = "#333";
		row.appendChild(label);
		const val = document.createElement("span");
		if (opts.isToggle) {
			const on = !!opts.value;
			val.textContent = on ? "ON" : "OFF";
			val.style.cssText = `font-weight:600;font-size:11px;padding:2px 8px;border-radius:4px;background:${on ? "#e8f5e9" : "#f5f5f5"};color:${on ? "#2e7d32" : "#888"};`;
		} else {
			val.textContent = opts.value;
			val.style.color = "#1a1a1a"; val.style.fontWeight = "600";
		}
		row.appendChild(val);
		if (opts.onClick) {
			row.addEventListener("click", opts.onClick);
			row.addEventListener("mouseenter", () => (row.style.background = "#fafafa"));
			row.addEventListener("mouseleave", () => (row.style.background = "transparent"));
		}
		return row;
	}
	function makeActionButton(label, onClick) {
		const btn = document.createElement("button");
		btn.textContent = label;
		btn.style.cssText = `display:block;width:100%;text-align:left;padding:10px 12px;margin-top:8px;background:#fafafa;color:#1a1a1a;border:1px solid #e0e0e0;border-radius:6px;font:inherit;cursor:pointer;`;
		btn.addEventListener("mouseenter", () => { btn.style.background = "#f0f0f0"; btn.style.borderColor = "#c0c0c0"; });
		btn.addEventListener("mouseleave", () => { btn.style.background = "#fafafa"; btn.style.borderColor = "#e0e0e0"; });
		btn.addEventListener("click", onClick);
		return btn;
	}
	function makeSectionLabel(text) {
		const el = document.createElement("div");
		el.textContent = text;
		el.style.cssText = `font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#888;font-weight:600;margin:16px 0 4px;`;
		return el;
	}

	// ── Settings ──
	function renderSettings(container) {
		container.innerHTML = "";
		container.appendChild(makeSectionLabel("Virtualization"));
		container.appendChild(makeRow({
			label: "Visible messages", value: String(cfg.visibleMessages),
			onClick: () => {
				const n = parseInt(prompt("Visible messages to keep:", cfg.visibleMessages), 10);
				if (n && n > 0) { cfg.visibleMessages = n; saveConfig(); virtualize(); renderActiveTab(); }
			},
		}));
		container.appendChild(makeRow({
			label: "Virtualize old messages", isToggle: true, value: cfg.virtualize,
			onClick: () => { cfg.virtualize = !cfg.virtualize; saveConfig(); virtualize(); renderActiveTab(); },
		}));
		container.appendChild(makeRow({
			label: "Flatten code blocks", isToggle: true, value: cfg.flattenCode,
			onClick: () => { cfg.flattenCode = !cfg.flattenCode; saveConfig(); virtualize(); renderActiveTab(); },
		}));
		container.appendChild(makeSectionLabel("Behavior"));
		container.appendChild(makeRow({
			label: "Auto-scroll to bottom", isToggle: true, value: cfg.autoScroll,
			onClick: () => { cfg.autoScroll = !cfg.autoScroll; saveConfig(); renderActiveTab(); },
		}));
		container.appendChild(makeRow({
			label: "Collapse old thinking", isToggle: true, value: cfg.collapseOldThinking,
			onClick: () => { cfg.collapseOldThinking = !cfg.collapseOldThinking; saveConfig(); renderActiveTab(); },
		}));
		container.appendChild(makeSectionLabel("Interface"));
		container.appendChild(makeRow({
			label: "Floating export button", isToggle: true, value: cfg.showExport,
			onClick: () => {
				cfg.showExport = !cfg.showExport; saveConfig();
				if (cfg.showExport) injectExportButton(); else removeExportButton();
				renderActiveTab();
			},
		}));
		container.appendChild(makeRow({
			label: "Context window", value: fmtNum(cfg.contextWindow) + " tokens",
			onClick: () => {
				const n = parseInt(prompt("Context window size (tokens):", cfg.contextWindow), 10);
				if (n && n > 0) { cfg.contextWindow = n; saveConfig(); renderActiveTab(); updateStats(); }
			},
		}));
		container.appendChild(makeRow({
			label: "Composer selector (adv)", value: cfg.composerSelector || "(auto)",
			onClick: () => {
				const v = prompt("CSS selector for the chat input (blank = auto-detect):", cfg.composerSelector);
				if (v !== null) { cfg.composerSelector = v.trim(); saveConfig(); renderActiveTab(); }
			},
		}));
	}

	// ── Actions ──
	function renderActions(container) {
		container.innerHTML = "";
		container.appendChild(makeSectionLabel("Agent actions"));
		container.appendChild(makeActionButton("⊕ Create PR", actionCreatePR));
		container.appendChild(makeActionButton("⇲ Merge", actionMerge));

		container.appendChild(makeSectionLabel("Session"));
		container.appendChild(makeActionButton("✕ Clear chat", actionClearChat));
		container.appendChild(makeRow({
			label: "Entry panel hidden", isToggle: true, value: cfg.hideComposer,
			onClick: toggleComposer,
		}));

		container.appendChild(makeSectionLabel("Export"));
		container.appendChild(makeActionButton("⬇ Export as Markdown", exportMarkdown));

		container.appendChild(makeSectionLabel("Debug"));
		container.appendChild(makeActionButton("🔍 Run diagnostics (copies to clipboard)", actionDiagnostics));

		const note = document.createElement("div");
		note.style.cssText = "margin-top:16px;font-size:11px;color:#999;line-height:1.5;";
		note.innerHTML = `PR/Merge are sent to the agent through the composer — Arena has no such buttons in its UI. If the composer isn't found, the text is copied to your clipboard so you can paste manually. Run diagnostics if actions fail.`;
		container.appendChild(note);
	}

	// ── Stats ──
	function renderStats(container) {
		const s = computeStats();
		container.innerHTML = "";
		if (!s) { container.appendChild(makeSectionLabel("No chat detected")); return; }
		container.appendChild(makeSectionLabel("Messages"));
		container.appendChild(makeRow({ label: "Total", value: String(s.totalMsgs) }));
		container.appendChild(makeRow({ label: "Visible", value: String(s.visibleMsgs) }));
		container.appendChild(makeRow({ label: "Hidden (virtualized)", value: String(s.hiddenMsgs) }));
		container.appendChild(makeSectionLabel("Tokens (estimated)"));
		container.appendChild(makeRow({ label: "Total", value: fmtNum(s.totalTokens) }));
		container.appendChild(makeRow({ label: "Visible", value: fmtNum(s.visibleTokens) }));
		container.appendChild(makeRow({ label: "Hidden", value: fmtNum(s.hiddenTokens) }));
		container.appendChild(makeSectionLabel("Context window"));
		const pct = s.contextPct;
		const barColor = pct > 90 ? "#e53935" : pct > 70 ? "#fb8c00" : "#43a047";
		const contextRow = document.createElement("div");
		contextRow.style.cssText = "padding: 8px 0; font-size: 13px;";
		contextRow.innerHTML = `
			<div style="display:flex;justify-content:space-between;margin-bottom:6px;">
				<span style="color:#666;">Usage</span>
				<span style="font-weight:600;">${fmtNum(s.totalTokens)} / ${fmtNum(s.contextWindow)}</span>
			</div>
			<div style="height:6px;background:#f0f0f0;border-radius:3px;overflow:hidden;">
				<div style="height:100%;width:${Math.min(100, pct).toFixed(1)}%;background:${barColor};transition:width 0.3s;"></div>
			</div>
			<div style="text-align:right;font-size:11px;color:#888;margin-top:4px;">${pct.toFixed(1)}%</div>
		`;
		container.appendChild(contextRow);
		container.appendChild(makeSectionLabel("Content"));
		container.appendChild(makeRow({ label: "Total characters", value: s.totalChars.toLocaleString() }));
		container.appendChild(makeRow({ label: "Code blocks", value: String(s.codeBlocks) }));
		container.appendChild(makeRow({ label: "Thinking blocks", value: String(s.thinkingBlocks) }));
		const footer = document.createElement("div");
		footer.style.cssText = "margin-top:16px;font-size:11px;color:#999;line-height:1.5;";
		footer.innerHTML = `Token counts are estimates (~4 chars/token).`;
		container.appendChild(footer);
	}

	function renderActiveTab() {
		const drawer = document.getElementById(DRAWER_ID);
		if (!drawer) return;
		const content = drawer.querySelector(".cc-drawer-content");
		if (!content) return;
		if (activeTab === "settings") renderSettings(content);
		else if (activeTab === "actions") renderActions(content);
		else renderStats(content);
	}
	function updateStats() {
		if (!drawerOpen || activeTab !== "stats") return;
		const drawer = document.getElementById(DRAWER_ID);
		if (!drawer) return;
		const content = drawer.querySelector(".cc-drawer-content");
		if (!content) return;
		renderStats(content);
	}

	function createDrawer() {
		if (document.getElementById(DRAWER_ID)) return;
		const drawer = document.createElement("aside");
		drawer.id = DRAWER_ID;
		drawer.style.cssText = `position:fixed;top:0;left:0;bottom:0;width:320px;z-index:2147483645;transform:translateX(-100%);transition:transform 0.24s cubic-bezier(0.4,0,0.2,1);font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1a1a1a;`;
		drawer.innerHTML = `
			<div class="cc-drawer-panel" style="position:absolute;inset:0;background:#ffffff;border-right:1px solid #d4d4d4;box-shadow:2px 0 12px rgba(0,0,0,0.08);display:flex;flex-direction:column;overflow:hidden;">
				<div style="padding:16px 20px;border-bottom:1px solid #e5e5e5;font-weight:600;font-size:14px;display:flex;align-items:center;gap:8px;">
					<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#d97757;"></span>
					Coding Edition
				</div>
				<div class="cc-drawer-tabs" style="display:flex;border-bottom:1px solid #e5e5e5;background:#fafafa;">
					<button data-tab="settings">Settings</button>
					<button data-tab="actions">Actions</button>
					<button data-tab="stats">Statistics</button>
				</div>
				<div class="cc-drawer-content" style="flex:1;overflow-y:auto;padding:8px 20px 20px;"></div>
			</div>
			<button id="${DRAWER_TOGGLE_ID}" aria-label="Open panel"></button>
		`;
		const tabStyle = `flex:1;padding:10px 0;border:none;background:transparent;cursor:pointer;font:inherit;color:#888;border-bottom:2px solid transparent;font-size:12px;`;
		drawer.querySelectorAll(".cc-drawer-tabs button").forEach((b) => {
			b.style.cssText = tabStyle;
			b.addEventListener("click", () => switchTab(b.dataset.tab));
		});
		const toggle = drawer.querySelector(`#${DRAWER_TOGGLE_ID}`);
		toggle.style.cssText = `position:absolute;top:50%;left:320px;transform:translateY(-50%);width:30px;height:52px;background:#ffffff;color:#333;border:1px solid #d4d4d4;border-left:none;border-radius:0 8px 8px 0;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;box-shadow:2px 0 8px rgba(0,0,0,0.06);`;
		toggle.addEventListener("click", toggleDrawer);
		document.body.appendChild(drawer);
		switchTab("settings");
		applyDrawerState();
	}

	// ═══════════════════════════════════════════════════════════════════
	// OBSERVER + INIT
	// ═══════════════════════════════════════════════════════════════════
	let timer = null;
	let currentContainer = null;
	let composerHiddenApplied = false;

	function schedule() {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			const container = getContainer();
			if (container && container !== currentContainer) {
				teardownAutoScroll();
				currentContainer = container;
				lastMsgCount = 0;
				requestAnimationFrame(() => setupAutoScroll(container));
			}
			if (container) { virtualize(); collapseOldThinking(container); }
			// Re-apply composer hiding only if previously applied successfully
			if (cfg.hideComposer && composerHiddenApplied) {
				if (!document.querySelector('[data-cc-composer-hide="1"]')) {
					applyComposerVisibility();
				}
			}
		}, 200);
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
		createDrawer();
		injectExportButton();
		if (cfg.hideComposer) {
			const before = findComposer();
			applyComposerVisibility();
			composerHiddenApplied = !!before && !!document.querySelector('[data-cc-composer-hide="1"]');
		}
		schedule();
		startObserver();
		setTimeout(schedule, 1000);
		setTimeout(schedule, 3000);
		setInterval(schedule, 5000);
		setInterval(updateStats, 1000);
	}

	function waitForLog() {
		if (getContainer()) { init(); return; }
		const obs = new MutationObserver(() => {
			if (getContainer()) { obs.disconnect(); setTimeout(init, 300); }
		});
		obs.observe(document.body, { childList: true, subtree: true });
	}

	if (document.body) { waitForLog(); }
	else {
		const bodyObs = new MutationObserver(() => {
			if (document.body) { bodyObs.disconnect(); waitForLog(); }
		});
		bodyObs.observe(document.documentElement, { childList: true });
	}

	setTimeout(() => {
		if (!started) {
			started = true;
			createDrawer();
			injectExportButton();
			startObserver();
			setInterval(updateStats, 1000);
		}
	}, 6000);

	setInterval(() => {
		if (started && !document.getElementById(DRAWER_ID)) createDrawer();
		if (started && cfg.showExport && !document.getElementById(EXPORT_ID)) injectExportButton();
	}, 3000);
})();