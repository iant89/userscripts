// ==UserScript==
// @name         Arena.ai | Coding Edition
// @namespace    https://greasyfork.org/en/users/1462137-piknockyou
// @version      3.4.0
// @author       Piknockyou (vibe-coded)
// @license      AGPL-3.0
// @description  Virtualizes old messages, strips heavy CSS, auto-scrolls, manages thinking blocks, exports code blocks and chat as files, and provides a themed slide-out drawer with settings, actions, and statistics.
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
		autoScroll: true,
		collapseOldThinking: true,
		showExport: true,
		contextWindow: 200000,
		hideComposer: false,
		composerSelector: "",
		// Thinking modes (mutually exclusive)
		keepThinkingExpanded: false,
		hideThinking: false,
		// Scrolling
		smoothScroll: false,
		scrollThreshold: 150,
		// Display
		compactMode: false,
		fontSize: 0,
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
	// THEME (Arena-matching CSS vars; auto-follows html.dark)
	// ═══════════════════════════════════════════════════════════════════
	const THEME_CSS_ID = "cc-theme";
	function injectThemeCSS() {
		let el = document.getElementById(THEME_CSS_ID);
		if (!el) {
			el = document.createElement("style");
			el.id = THEME_CSS_ID;
			(document.head || document.documentElement).appendChild(el);
		}
		el.textContent = `
			html {
				--cc-bg: #ffffff;
				--cc-surface: #fafafa;
				--cc-surface-2: #f4f4f5;
				--cc-text: #18181b;
				--cc-text-muted: #71717a;
				--cc-text-subtle: #a1a1aa;
				--cc-border: #e4e4e7;
				--cc-border-faint: #f0f0f0;
				--cc-hover: rgba(0, 0, 0, 0.04);
				--cc-accent: #f97316;
				--cc-accent-hover: #ea580c;
				--cc-accent-bg: rgba(249, 115, 22, 0.08);
				--cc-accent-border: rgba(249, 115, 22, 0.25);
				--cc-success: #16a34a;
				--cc-danger: #dc2626;
				--cc-shadow: 0 1px 3px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.04);
				--cc-shadow-lg: 0 4px 16px rgba(0, 0, 0, 0.10);
			}
			html.dark, html[data-theme="dark"] {
				--cc-bg: #09090b;
				--cc-surface: #18181b;
				--cc-surface-2: #27272a;
				--cc-text: #fafafa;
				--cc-text-muted: #a1a1aa;
				--cc-text-subtle: #71717a;
				--cc-border: #27272a;
				--cc-border-faint: #1f1f23;
				--cc-hover: rgba(255, 255, 255, 0.05);
				--cc-accent: #fb923c;
				--cc-accent-hover: #f97316;
				--cc-accent-bg: rgba(251, 146, 60, 0.10);
				--cc-accent-border: rgba(251, 146, 60, 0.30);
				--cc-success: #22c55e;
				--cc-danger: #ef4444;
				--cc-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
				--cc-shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.6);
			}
		`;
	}
	injectThemeCSS();

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

	// Dynamic CSS for hide-thinking / compact / font-size
	function applyDynamicCSS() {
		let el = document.getElementById("cc-dynamic");
		if (!el) {
			el = document.createElement("style");
			el.id = "cc-dynamic";
			(document.head || document.documentElement).appendChild(el);
		}
		let css = "";
		if (cfg.hideThinking) {
			css += `[data-cc-thinking="1"] { display: none !important; }`;
		}
		if (cfg.compactMode) {
			css += `[role="log"] > * { padding-top: 4px !important; padding-bottom: 4px !important; }`;
			css += `[role="log"] [class*="prose"] > * { margin-top: 6px !important; margin-bottom: 6px !important; }`;
		}
		if (cfg.fontSize > 0) {
			css += `[role="log"] { font-size: ${cfg.fontSize}px !important; }`;
		}
		el.textContent = css;
	}

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
			color: #fafafa; z-index: 2147483647;
			box-shadow: 0 4px 16px rgba(0,0,0,0.3);
			background: #18181b; opacity: 0; transition: opacity 0.2s ease;
			max-width: 80vw; text-align: center; line-height: 1.4;
		`;
		if (kind === "error") t.style.background = "#dc2626";
		if (kind === "success") t.style.background = "#16a34a";
		document.body.appendChild(t);
		requestAnimationFrame(() => { t.style.opacity = "1"; });
		setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 300); }, ms);
	}

	// ═══════════════════════════════════════════════════════════════════
	// DOM: container + messages (deep descent + direction detection)
	// ═══════════════════════════════════════════════════════════════════
	const LOG_SELECTOR = '[role="log"]';

	function getContainer() {
		const logs = document.querySelectorAll(LOG_SELECTOR);
		if (!logs.length) return null;
		let best = logs[0];
		for (const el of logs) if (el.children.length > best.children.length) best = el;
		return best;
	}

	function isMsgNode(el) {
		if (!(el instanceof HTMLElement)) return false;
		if (el.classList.contains("h-0")) return false;
		if (el.hidden) return false;
		return true;
	}

	function isReversed(el) {
		return /\bflex-col-reverse\b/.test(el?.className || "");
	}

	function detectReversed(msgs, container) {
		const parent = msgs[0]?.parentElement;
		if (parent && parent !== container && parent.children.length > 1) {
			if (isReversed(parent)) return true;
			if (/\bflex-col\b/.test(parent.className || "")) return false;
		}
		return isReversed(container);
	}

	function looksLikeMessage(el) {
		if (!el || !el.textContent) return false;
		const txt = el.textContent.trim();
		if (txt.length > 40) return true;
		if (el.querySelector('pre, .prose, [class*="prose"], [class*="markdown"], button[data-state], [data-state]')) return true;
		if (el.getAttribute("data-message-author-role")) return true;
		if (/message|turn|response|prompt/i.test(el.className || "")) return true;
		return false;
	}

	function getMessages(container) {
		if (!container) return [];
		let current = container;
		for (let depth = 0; depth < 6; depth++) {
			const children = Array.from(current.children).filter(isMsgNode);
			if (children.length === 0) return [];
			if (children.length === 1) { current = children[0]; continue; }
			const msgCount = children.filter(looksLikeMessage).length;
			if (msgCount >= 2 && msgCount >= children.length * 0.5) return children;
			const biggest = children.reduce((a, b) =>
				(a.textContent || "").length >= (b.textContent || "").length ? a : b
			);
			const totalLen = children.reduce((s, c) => s + (c.textContent || "").length, 0);
			if (totalLen > 100 && (biggest.textContent || "").length > totalLen * 0.85) {
				current = biggest;
				continue;
			}
			console.warn(
				"[Coding Edition] getMessages: ambiguous at depth", depth,
				"children:", children.length, "lookLikeMsgs:", msgCount
			);
			return children;
		}
		return Array.from(current.children).filter(isMsgNode);
	}

	// ═══════════════════════════════════════════════════════════════════
	// COMPOSER FINDER
	// ═══════════════════════════════════════════════════════════════════
	function findComposer() {
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
			if (r.top > window.innerHeight * 0.4) score += 20;
			if (r.top > window.innerHeight * 0.6) score += 10;
			if (r.width > 200) score += 10;
			if (r.width > 400) score += 5;
			if (el.tagName === "TEXTAREA") score += 8;
			if (el.isContentEditable) score += 6;
			if (!el.closest("header, [role='banner'], nav, aside")) score += 10;
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
			setTimeout(() => {
				const r = input.getBoundingClientRect();
				for (const sel of ['button[aria-label*="send" i]', 'button[data-testid*="send" i]', 'button[type="submit"]']) {
					const btn = document.querySelector(sel);
					if (btn && btn.getBoundingClientRect().width > 0) { btn.click(); return; }
				}
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
		try { await navigator.clipboard.writeText(text); return true; }
		catch (_) { return false; }
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

	let lastVirtualizeLog = "";
	let warnedOnce = false;

	function logVirtualize(state) {
		const sig = JSON.stringify(state);
		if (sig === lastVirtualizeLog) return;
		lastVirtualizeLog = sig;
		console.log("[Coding Edition] Virtualize:", state);
	}

	function virtualize() {
		const container = getContainer();
		if (!container) return { hidden: 0, total: 0, reversed: false };
		const msgs = getMessages(container);
		if (!cfg.virtualize) {
			msgs.forEach((m) => delete m.dataset.ccHidden);
			logVirtualize({ mode: "off", total: msgs.length, hidden: 0, reversed: false });
			return { hidden: 0, total: msgs.length, reversed: false };
		}
		const total = msgs.length;
		const keep = Math.max(1, cfg.visibleMessages);
		const reversed = detectReversed(msgs, container);
		msgs.forEach((msg, i) => {
			const isNewest = reversed ? i < keep : i >= total - keep;
			if (isNewest) {
				if (msg.dataset.ccHidden) delete msg.dataset.ccHidden;
			} else if (!msg.dataset.ccHidden) {
				flattenShiki(msg);
				msg.dataset.ccHidden = "1";
			}
		});
		const actualHidden = msgs.filter((m) => m.dataset.ccHidden === "1").length;
		if (total > keep && actualHidden === 0 && !warnedOnce) {
			console.warn(
				"[Coding Edition] Virtualize found", total, "messages but hid 0.",
				"DOM structure doesn't match. Run Actions → 🔍 Diagnostics."
			);
			warnedOnce = true;
		}
		logVirtualize({ mode: "on", total, hidden: actualHidden, reversed, keep });
		return { hidden: actualHidden, total, reversed };
	}

	// ═══════════════════════════════════════════════════════════════════
	// THINKING BLOCKS
	// ═══════════════════════════════════════════════════════════════════
	function isThinkingButton(btn) {
		if (!btn) return false;
		const txt = (btn.textContent || "").trim().toLowerCase();
		return txt && /think|thought|reason|chain[-\s]of[-\s]thought/.test(txt);
	}

	let lastCollapseCount = 0;
	function collapseOldThinking(container) {
		if (!container) return;
		const msgs = getMessages(container);
		const currentCount = msgs.length;
		if (currentCount <= lastCollapseCount) { lastCollapseCount = currentCount; return; }
		const reversed = detectReversed(msgs, container);
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
		lastCollapseCount = currentCount;
	}

	let lastExpandCount = 0;
	function expandAllThinking(container, force = false) {
		if (!container) container = getContainer();
		if (!container) return;
		const msgs = getMessages(container);
		if (!force) {
			if (msgs.length <= lastExpandCount) { lastExpandCount = msgs.length; return; }
			lastExpandCount = msgs.length;
		}
		let count = 0;
		msgs.forEach(msg => {
			msg.querySelectorAll('button[data-state="closed"], button[aria-expanded="false"]').forEach(btn => {
				if (!isThinkingButton(btn)) return;
				try { btn.click(); count++; } catch (_) {}
			});
		});
		if (count) console.log(`[Coding Edition] Expanded ${count} thinking block(s).`);
	}

	function markThinkingBlocks() {
		const container = getContainer();
		if (!container) return;
		if (!cfg.hideThinking) {
			document.querySelectorAll('[data-cc-thinking="1"]').forEach(el => el.removeAttribute("data-cc-thinking"));
			return;
		}
		container.querySelectorAll('button[data-state], button[aria-expanded]').forEach(btn => {
			if (!isThinkingButton(btn)) return;
			const wrapper = btn.closest(".not-prose") || btn.parentElement;
			if (wrapper && wrapper !== btn) wrapper.setAttribute("data-cc-thinking", "1");
		});
	}

	function setThinkingMode(mode) {
		cfg.collapseOldThinking = mode === "collapse";
		cfg.keepThinkingExpanded = mode === "expand";
		cfg.hideThinking = mode === "hide";
		saveConfig();
		if (mode !== "hide") {
			document.querySelectorAll('[data-cc-thinking="1"]').forEach(el => el.removeAttribute("data-cc-thinking"));
		}
		if (mode === "hide") markThinkingBlocks();
		if (mode === "expand") { lastExpandCount = 0; expandAllThinking(null, true); }
		applyDynamicCSS();
	}

	// ═══════════════════════════════════════════════════════════════════
	// AUTO-SCROLL
	// ═══════════════════════════════════════════════════════════════════
	const JUMP_ID = "cc-jump-bottom";
	let scrollObserver = null;

	function isNearBottom(c) {
		const t = cfg.scrollThreshold || 150;
		return c.scrollHeight - c.scrollTop - c.clientHeight < t;
	}

	function scrollToBottom(c, smooth) {
		if (!c) return;
		if (smooth || cfg.smoothScroll) c.scrollTo({ top: c.scrollHeight, behavior: "smooth" });
		else c.scrollTop = c.scrollHeight;
	}

	function updateJumpButton(show) {
		let btn = document.getElementById(JUMP_ID);
		if (show && !btn) {
			btn = document.createElement("button");
			btn.id = JUMP_ID; btn.textContent = "↓"; btn.title = "Jump to latest";
			btn.style.cssText = `position:fixed;right:20px;bottom:80px;z-index:2147483647;width:36px;height:36px;border-radius:50%;background:var(--cc-bg);color:var(--cc-text);border:1px solid var(--cc-border);box-shadow:var(--cc-shadow-lg);cursor:pointer;font:16px/1 -apple-system,sans-serif;display:flex;align-items:center;justify-content:center;padding:0;`;
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
		if (!msgs.length) { toast("No messages detected to export.", "error"); return; }
		const reversed = detectReversed(msgs, container);
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
	// AGENT ACTIONS
	// ═══════════════════════════════════════════════════════════════════
	async function actionCreatePR() {
		const msg = "Create a pull request for the current changes and give me the PR URL.";
		if (sendAgentMessage(msg)) toast("Sent to agent: create PR.", "success");
		else {
			const copied = await copyText(msg);
			toast(copied ? "Composer not found — message copied." : "Composer not found.", "error", 5000);
		}
	}

	async function actionMerge() {
		const msg = "Merge the current pull request into the main branch.";
		if (sendAgentMessage(msg)) toast("Sent to agent: merge.", "success");
		else {
			const copied = await copyText(msg);
			toast(copied ? "Composer not found — message copied." : "Composer not found.", "error", 5000);
		}
	}

	function findNewChatButton() {
		const all = document.querySelectorAll('button, [role="button"], a, [role="menuitem"]');
		const textPatterns = [
			"new chat", "new conversation", "start new chat", "start new conversation",
			"new thread", "new session", "clear chat", "clear conversation",
			"reset chat", "create new chat", "create chat",
		];
		const candidates = [];
		for (const el of all) {
			if (el.closest('[role="log"]')) continue;
			const text = (el.textContent || "").trim().toLowerCase();
			const aria = (el.getAttribute("aria-label") || "").toLowerCase();
			const title = (el.getAttribute("title") || "").toLowerCase();
			const testid = (el.getAttribute("data-testid") || "").toLowerCase();
			const combined = `${text} ${aria} ${title} ${testid}`;
			if (!textPatterns.some((p) => combined.includes(p))) continue;
			const r = el.getBoundingClientRect();
			if (r.width === 0 || r.height === 0) continue;
			let score = 1;
			if (text.length > 0) score += 5;
			if (el.closest('aside, nav, [class*="sidebar" i], [data-sidebar], [role="navigation"]')) score += 5;
			if (r.top < 250) score += 3;
			if (el.tagName === "A") score += 1;
			candidates.push({ el, score, label: (text || aria || title || testid).slice(0, 40) });
		}
		candidates.sort((a, b) => b.score - a.score);
		return candidates[0]?.el || null;
	}

	async function actionClearChat() {
		const container = getContainer();
		const before = container ? getMessages(container).length : 0;
		if (before === 0) { toast("Chat is already empty.", "info"); return; }

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
			} catch (e) { console.warn("[Coding Edition] New-chat click threw:", e); }
			await new Promise((r) => setTimeout(r, 900));
			const after = getContainer() ? getMessages(getContainer()).length : 0;
			if (after < before || after === 0) { toast(`Cleared (${before} → ${after}).`, "success"); return; }
			console.log("[Coding Edition] Clear-click no-op:", { before, after });
		}

		const why = clickedLabel
			? `Clicked "${clickedLabel}" but the chat wasn't cleared (${before} messages still there).`
			: `No "New chat" button found in the sidebar (${before} messages present).`;
		toast(why, "error", 4000);
		await new Promise((r) => setTimeout(r, 400));
		if (confirm(`${why}\n\nReload to a fresh chat? Your current conversation stays in your history.`)) {
			try { location.assign("/"); } catch (_) { location.reload(); }
		}
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
			out.push(`  direct children: ${container.children.length}`);
			const msgs = getMessages(container);
			out.push(`  messages detected: ${msgs.length}`);
			out.push(`  reversed: ${msgs.length ? detectReversed(msgs, container) : "n/a"}`);
			if (msgs[0]) {
				const m = msgs[0];
				const txt = (m.textContent || "").trim().slice(0, 80);
				out.push(`  first msg parent: <${m.parentElement.tagName.toLowerCase()}> .${m.parentElement.className}`);
				out.push(`  first msg: <${m.tagName.toLowerCase()}> text="${txt}..."`);
			}
		} else {
			out.push("NOT FOUND — no [role=log] on page.");
		}

		out.push(`\n--- Composer ---`);
		const input = findComposer();
		if (input) {
			const r = input.getBoundingClientRect();
			out.push(`FOUND: <${input.tagName.toLowerCase()}> id="${input.id}" class="${input.className}"`);
			out.push(`  rect: x=${r.x.toFixed(0)} y=${r.top.toFixed(0)} w=${r.width.toFixed(0)} h=${r.height.toFixed(0)}`);
			out.push(`  contentEditable=${input.isContentEditable}`);
		} else {
			out.push("NOT FOUND — no matching input found in viewport.");
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
			btnData.push(`  text="${text}" aria="${aria}" testid="${testid}"`);
		});
		out.push(btnData.join("\n") || "  (none visible)");

		const text = out.join("\n");
		console.log(text);
		await copyText(text);
		toast("Diagnostics logged + copied to clipboard.", "success", 3500);
	}

	// ═══════════════════════════════════════════════════════════════════
	// COMPOSER VISIBILITY
	// ═══════════════════════════════════════════════════════════════════
	function applyComposerVisibility() {
		document.querySelectorAll('[data-cc-composer-hide="1"]').forEach(el => {
			el.style.removeProperty("display");
			el.removeAttribute("data-cc-composer-hide");
		});
		if (!cfg.hideComposer) return;
		const input = findComposer();
		if (!input) return;
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

	// ═══════════════════════════════════════════════════════════════════
	// CODE BLOCK EXPORT
	// ═══════════════════════════════════════════════════════════════════
	const LANG_EXT = {
		javascript: "js", js: "js", jsx: "jsx", mjs: "mjs", cjs: "cjs",
		typescript: "ts", ts: "ts", tsx: "tsx",
		python: "py", py: "py",
		ruby: "rb", rb: "rb",
		go: "go", golang: "go",
		rust: "rs", rs: "rs",
		java: "java", kotlin: "kt", kt: "kt", swift: "swift", scala: "scala",
		c: "c", h: "h",
		cpp: "cpp", "c++": "cpp", cc: "cpp", hpp: "hpp",
		csharp: "cs", "c#": "cs", cs: "cs", php: "php",
		r: "r", perl: "pl", lua: "lua",
		shell: "sh", sh: "sh", bash: "sh", zsh: "sh", console: "sh", terminal: "sh",
		powershell: "ps1", ps1: "ps1", pwsh: "ps1",
		sql: "sql", html: "html", htm: "html", css: "css",
		scss: "scss", sass: "sass", less: "less",
		json: "json", jsonc: "jsonc", yaml: "yml", yml: "yml", toml: "toml", xml: "xml",
		markdown: "md", md: "md", diff: "diff", patch: "patch",
		dockerfile: "Dockerfile", docker: "Dockerfile", makefile: "Makefile",
		ini: "ini", env: "env", dotenv: "env",
		graphql: "graphql", gql: "graphql", vue: "vue", svelte: "svelte",
		astro: "astro", prisma: "prisma",
		text: "txt", txt: "txt", plaintext: "txt", plain: "txt",
	};

	function getCodeMeta(pre) {
		const code = pre.querySelector("code") || pre;
		const cls = `${code.className || ""} ${pre.className || ""}`;
		const lang = (
			code.getAttribute("data-language") ||
			code.getAttribute("data-lang") ||
			pre.getAttribute("data-language") ||
			pre.getAttribute("data-cc-lang") ||
			(cls.match(/language-([\w-]+)/i) || [])[1] ||
			(cls.match(/lang-([\w-]+)/i) || [])[1] ||
			""
		).toLowerCase();
		const ext = LANG_EXT[lang] || "txt";

		let name = "";
		const pathRe = /([\w./-]+\.(?:ts|tsx|js|jsx|py|rb|go|rs|java|kt|swift|scala|c|cpp|h|hpp|cs|php|r|pl|lua|sh|ps1|sql|html|css|scss|sass|less|json|yml|yaml|toml|xml|md|vue|svelte|astro|prisma))/i;
		const header = pre.previousElementSibling || pre.parentElement?.previousElementSibling;
		if (header && header.textContent && header.textContent.length < 200) {
			const m = header.textContent.match(pathRe);
			if (m) name = m[1];
		}
		if (!name) {
			const m = (code.getAttribute("aria-label") || pre.getAttribute("title") || "").match(pathRe);
			if (m) name = m[1];
		}
		if (!name) {
			name = code.getAttribute("data-filename") || pre.getAttribute("data-filename") || "";
		}
		return { lang: lang || "text", ext, filename: name };
	}

	function downloadBlob(text, filename, mime = "text/plain;charset=utf-8") {
		const blob = new Blob([text], { type: mime });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	let _codeSnippetCounter = 0;

	function decorateCodeBlocks() {
		const container = getContainer();
		if (!container) return;

		container.querySelectorAll('[data-cc-wrap="1"]').forEach((w) => {
			if (!w.querySelector(":scope > pre")) w.remove();
		});

		const pres = container.querySelectorAll("pre:not([data-cc-decorated])");
		pres.forEach((pre) => {
			if (pre.closest('[data-cc-hidden="1"]')) return;
			if (pre.parentElement && pre.parentElement.closest("pre")) return;
			if (pre.parentElement?.dataset.ccWrap === "1") {
				pre.dataset.ccDecorated = "1";
				return;
			}
			pre.dataset.ccDecorated = "1";

			const wrap = document.createElement("div");
			wrap.dataset.ccWrap = "1";
			wrap.style.cssText = "position: relative; display: block;";
			pre.parentNode.insertBefore(wrap, pre);
			wrap.appendChild(pre);

			const meta = getCodeMeta(pre);

			const btn = document.createElement("button");
			btn.type = "button";
			btn.textContent = "⬇";
			btn.title = `Export ${meta.lang} (${meta.filename || `snippet.${meta.ext}`})`;
			btn.setAttribute("aria-label", "Export code block");
			btn.style.cssText = `
				position: absolute; top: 8px; right: 8px; z-index: 10;
				width: 28px; height: 28px;
				display: flex; align-items: center; justify-content: center;
				padding: 0; background: var(--cc-bg); color: var(--cc-text);
				border: 1px solid var(--cc-border); border-radius: 6px;
				cursor: pointer; font-size: 13px; line-height: 1;
				opacity: 0.55;
				transition: opacity 0.15s ease, background 0.15s ease, border-color 0.15s ease;
				box-shadow: var(--cc-shadow);
			`;
			btn.addEventListener("mouseenter", () => {
				btn.style.opacity = "1";
				btn.style.background = "var(--cc-surface)";
				btn.style.borderColor = "var(--cc-accent)";
			});
			btn.addEventListener("mouseleave", () => {
				btn.style.opacity = "0.55";
				btn.style.background = "var(--cc-bg)";
				btn.style.borderColor = "var(--cc-border)";
			});
			wrap.addEventListener("mouseenter", () => (btn.style.opacity = "1"));
			wrap.addEventListener("mouseleave", () => (btn.style.opacity = "0.55"));

			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				e.preventDefault();
				const code = pre.querySelector("code") || pre;
				const text = (code.innerText || code.textContent || "").replace(/\n$/, "");
				if (!text.trim()) { toast("Empty code block.", "info"); return; }
				const filename = meta.filename || `snippet-${++_codeSnippetCounter}.${meta.ext}`;
				downloadBlob(text, filename);
				toast(`Saved ${filename}`, "success", 1800);
			});

			wrap.appendChild(btn);
		});
	}

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
	// FLOATING EXPORT BUTTON
	// ═══════════════════════════════════════════════════════════════════
	const EXPORT_ID = "cc-export-btn";
	function injectExportButton() {
		if (!cfg.showExport || document.getElementById(EXPORT_ID)) return;
		const btn = document.createElement("button");
		btn.id = EXPORT_ID; btn.textContent = "⬇ export.md";
		btn.style.cssText = `position:fixed;right:20px;bottom:20px;z-index:2147483647;padding:8px 14px;background:var(--cc-bg);color:var(--cc-text);border:1px solid var(--cc-border);border-radius:8px;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;cursor:pointer;box-shadow:var(--cc-shadow-lg);`;
		btn.addEventListener("mouseenter", () => { btn.style.background = "var(--cc-surface)"; });
		btn.addEventListener("mouseleave", () => { btn.style.background = "var(--cc-bg)"; });
		btn.addEventListener("click", exportMarkdown);
		document.body.appendChild(btn);
	}
	function removeExportButton() { const b = document.getElementById(EXPORT_ID); if (b) b.remove(); }

	// ═══════════════════════════════════════════════════════════════════
	// DRAWER STATE
	// ═══════════════════════════════════════════════════════════════════
	const DRAWER_ID = "cc-drawer";
	const DRAWER_TOGGLE_ID = "cc-drawer-toggle";
	const CHEVRON_RIGHT = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;
	const CHEVRON_LEFT = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`;

	let drawerOpen = false;
	let activeTab = "settings";
	let outsideClickHandler = null;

	function applyDrawerState() {
		const drawer = document.getElementById(DRAWER_ID);
		const toggle = document.getElementById(DRAWER_TOGGLE_ID);
		if (!drawer || !toggle) return;
		drawer.style.transform = drawerOpen ? "translateX(0)" : "translateX(-100%)";
		toggle.innerHTML = drawerOpen ? CHEVRON_LEFT : CHEVRON_RIGHT;
	}

	function closeDrawer() {
		if (!drawerOpen) return;
		drawerOpen = false;
		applyDrawerState();
		removeOutsideListener();
	}

	function openDrawer() {
		if (drawerOpen) return;
		drawerOpen = true;
		applyDrawerState();
		renderActiveTab();
		if (activeTab === "stats") updateStats();
		setTimeout(attachOutsideListener, 0);
	}

	function toggleDrawer() {
		if (drawerOpen) closeDrawer();
		else openDrawer();
	}

	function attachOutsideListener() {
		removeOutsideListener();
		outsideClickHandler = (e) => {
			if (e.button !== 0) return;
			if (e.target instanceof Element && e.target.closest(`#${DRAWER_ID}`)) return;
			closeDrawer();
		};
		document.addEventListener("mousedown", outsideClickHandler, true);
	}

	function removeOutsideListener() {
		if (outsideClickHandler) {
			document.removeEventListener("mousedown", outsideClickHandler, true);
			outsideClickHandler = null;
		}
	}

	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && drawerOpen) closeDrawer();
	});

	function switchTab(tab) {
		activeTab = tab;
		const drawer = document.getElementById(DRAWER_ID);
		if (!drawer) return;
		drawer.querySelectorAll(".cc-drawer-tabs button").forEach((b) => {
			const isActive = b.dataset.tab === tab;
			b.style.color = isActive ? "var(--cc-text)" : "var(--cc-text-muted)";
			b.style.fontWeight = isActive ? "600" : "400";
			b.style.borderBottomColor = isActive ? "var(--cc-accent)" : "transparent";
		});
		renderActiveTab();
		if (tab === "stats") updateStats();
	}

	// ═══════════════════════════════════════════════════════════════════
	// UI HELPERS
	// ═══════════════════════════════════════════════════════════════════
	function makeSectionLabel(container, text) {
		const el = document.createElement("div");
		el.textContent = text;
		el.style.cssText = `font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:var(--cc-text-muted);font-weight:600;margin:16px 0 6px;`;
		container.appendChild(el);
		return el;
	}

	function makeSection(container, label, rows) {
		makeSectionLabel(container, label);
		const card = document.createElement("div");
		card.style.cssText = `background:var(--cc-surface);border:1px solid var(--cc-border);border-radius:8px;overflow:hidden;`;
		rows.forEach((row, i) => {
			if (i > 0) {
				const div = document.createElement("div");
				div.style.cssText = "height:1px;background:var(--cc-border-faint);margin:0 12px;";
				card.appendChild(div);
			}
			card.appendChild(row);
		});
		container.appendChild(card);
		return card;
	}

	function makeToggleRow(label, value, onChange) {
		let on = !!value;
		const row = document.createElement("div");
		row.style.cssText = `display:flex;align-items:center;justify-content:space-between;padding:11px 12px;font-size:13px;cursor:pointer;user-select:none;`;
		const lbl = document.createElement("span");
		lbl.textContent = label;
		lbl.style.color = "var(--cc-text)";
		row.appendChild(lbl);
		const sw = document.createElement("div");
		sw.style.cssText = `position:relative;width:34px;height:20px;border-radius:10px;flex-shrink:0;transition:background 0.15s ease;background:${on ? "var(--cc-accent)" : "var(--cc-text-subtle)"};`;
		const knob = document.createElement("div");
		knob.style.cssText = `position:absolute;top:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,0.2);transition:left 0.15s ease;left:${on ? "16px" : "2px"};`;
		sw.appendChild(knob);
		row.appendChild(sw);
		const paint = () => {
			sw.style.background = on ? "var(--cc-accent)" : "var(--cc-text-subtle)";
			knob.style.left = on ? "16px" : "2px";
		};
		row.addEventListener("mouseenter", () => (row.style.background = "var(--cc-hover)"));
		row.addEventListener("mouseleave", () => (row.style.background = "transparent"));
		row.addEventListener("click", () => {
			on = !on;
			paint();
			try {
				const result = onChange(on);
				if (result === false) { on = !on; paint(); }
			} catch (e) {
				console.error("[Coding Edition] toggle handler failed:", e);
				on = !on; paint();
			}
		});
		return row;
	}

	function makeValueRow(label, value, onClick) {
		const row = document.createElement("div");
		row.style.cssText = `display:flex;align-items:center;justify-content:space-between;padding:11px 12px;font-size:13px;cursor:pointer;`;
		const lbl = document.createElement("span");
		lbl.textContent = label; lbl.style.color = "var(--cc-text)";
		row.appendChild(lbl);
		const val = document.createElement("span");
		val.textContent = value;
		val.style.cssText = "color:var(--cc-text);font-weight:500;font-size:12px;";
		row.appendChild(val);
		row.addEventListener("mouseenter", () => (row.style.background = "var(--cc-hover)"));
		row.addEventListener("mouseleave", () => (row.style.background = "transparent"));
		row.addEventListener("click", onClick);
		return row;
	}

	function makeInfoRow(label, value) {
		const row = document.createElement("div");
		row.style.cssText = `display:flex;align-items:center;justify-content:space-between;padding:11px 12px;font-size:13px;`;
		const lbl = document.createElement("span");
		lbl.textContent = label; lbl.style.color = "var(--cc-text)";
		row.appendChild(lbl);
		const val = document.createElement("span");
		val.textContent = value;
		val.style.cssText = "color:var(--cc-text-muted);font-weight:500;font-size:12px;";
		row.appendChild(val);
		return row;
	}

	function makeActionItem(label, icon, onClick) {
		const btn = document.createElement("button");
		btn.style.cssText = `display:flex;align-items:center;gap:10px;width:100%;padding:11px 12px;background:transparent;border:none;text-align:left;font:inherit;font-size:13px;color:var(--cc-text);cursor:pointer;`;
		if (icon) {
			const ic = document.createElement("span");
			ic.textContent = icon;
			ic.style.cssText = "color:var(--cc-text-muted);font-size:13px;width:16px;text-align:center;flex-shrink:0;";
			btn.appendChild(ic);
		}
		const lbl = document.createElement("span");
		lbl.textContent = label;
		btn.appendChild(lbl);
		btn.addEventListener("mouseenter", () => (btn.style.background = "var(--cc-hover)"));
		btn.addEventListener("mouseleave", () => (btn.style.background = "transparent"));
		btn.addEventListener("click", onClick);
		return btn;
	}

	function makeStatHero(label, value, subValue, pct, color) {
		const card = document.createElement("div");
		card.style.cssText = `background:linear-gradient(135deg, var(--cc-surface) 0%, var(--cc-accent-bg) 100%);border:1px solid var(--cc-accent-border);border-radius:10px;padding:14px 16px;`;
		const lbl = document.createElement("div");
		lbl.textContent = label;
		lbl.style.cssText = "font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:var(--cc-text-muted);font-weight:600;";
		card.appendChild(lbl);
		const row = document.createElement("div");
		row.style.cssText = "display:flex;align-items:baseline;justify-content:space-between;margin-top:6px;gap:8px;";
		const v = document.createElement("div");
		v.textContent = value;
		v.style.cssText = "font-size:18px;font-weight:600;color:var(--cc-text);letter-spacing:-0.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
		row.appendChild(v);
		const sub = document.createElement("div");
		sub.textContent = subValue;
		sub.style.cssText = "font-size:12px;color:var(--cc-text-muted);font-weight:500;flex-shrink:0;";
		row.appendChild(sub);
		card.appendChild(row);
		const track = document.createElement("div");
		track.style.cssText = "height:6px;background:var(--cc-border-faint);border-radius:3px;margin-top:10px;overflow:hidden;";
		const fill = document.createElement("div");
		fill.style.cssText = `height:100%;width:${Math.min(100, pct).toFixed(1)}%;background:${color};border-radius:3px;transition:width 0.3s ease;`;
		track.appendChild(fill);
		card.appendChild(track);
		return card;
	}

	function makeStatGrid(items) {
		const grid = document.createElement("div");
		grid.style.cssText = "display:grid;grid-template-columns:repeat(3,1fr);gap:6px;";
		items.forEach(({ label, value }) => {
			const cell = document.createElement("div");
			cell.style.cssText = "background:var(--cc-surface-2);border-radius:8px;padding:10px 6px;text-align:center;";
			const v = document.createElement("div");
			v.textContent = value;
			v.style.cssText = "font-size:15px;font-weight:600;color:var(--cc-text);letter-spacing:-0.01em;line-height:1.2;";
			cell.appendChild(v);
			const l = document.createElement("div");
			l.textContent = label;
			l.style.cssText = "font-size:9px;color:var(--cc-text-muted);margin-top:3px;text-transform:uppercase;letter-spacing:0.06em;font-weight:600;";
			cell.appendChild(l);
			grid.appendChild(cell);
		});
		return grid;
	}

	// ═══════════════════════════════════════════════════════════════════
	// RENDER TABS
	// ═══════════════════════════════════════════════════════════════════
	function renderSettings(container) {
		container.innerHTML = "";

		makeSection(container, "Virtualization", [
			makeValueRow("Visible messages", String(cfg.visibleMessages), () => {
				const n = parseInt(prompt("Visible messages to keep:", cfg.visibleMessages), 10);
				if (n && n > 0) { cfg.visibleMessages = n; saveConfig(); virtualize(); renderActiveTab(); }
			}),
			makeToggleRow("Virtualize old messages", cfg.virtualize, (on) => {
				cfg.virtualize = on; saveConfig(); virtualize();
			}),
			makeToggleRow("Flatten code blocks", cfg.flattenCode, (on) => {
				cfg.flattenCode = on; saveConfig(); virtualize();
			}),
		]);

		const thinkingMode = cfg.hideThinking ? "hide"
			: cfg.keepThinkingExpanded ? "expand"
			: cfg.collapseOldThinking ? "collapse" : "none";

		makeSection(container, "Thinking blocks", [
			makeToggleRow("Collapse old thinking", cfg.collapseOldThinking, (on) => {
				setThinkingMode(on ? "collapse" : "none");
				setTimeout(renderActiveTab, 180);
				return true;
			}),
			makeToggleRow("Keep thoughts expanded", cfg.keepThinkingExpanded, (on) => {
				setThinkingMode(on ? "expand" : "none");
				setTimeout(renderActiveTab, 180);
				return true;
			}),
			makeToggleRow("Hide thinking entirely", cfg.hideThinking, (on) => {
				setThinkingMode(on ? "hide" : "none");
				setTimeout(renderActiveTab, 180);
				return true;
			}),
		]);

		makeSection(container, "Scrolling", [
			makeToggleRow("Auto-scroll to bottom", cfg.autoScroll, (on) => {
				cfg.autoScroll = on; saveConfig();
			}),
			makeToggleRow("Smooth scrolling", cfg.smoothScroll, (on) => {
				cfg.smoothScroll = on; saveConfig();
			}),
			makeValueRow("Scroll threshold", `${cfg.scrollThreshold} px`, () => {
				const v = prompt("Auto-scroll triggers when within N px of bottom (20–500):", cfg.scrollThreshold);
				if (v === null) return;
				const n = parseInt(v, 10);
				if (n >= 20 && n <= 500) { cfg.scrollThreshold = n; saveConfig(); renderActiveTab(); }
			}),
		]);

		makeSection(container, "Display", [
			makeToggleRow("Compact mode", cfg.compactMode, (on) => {
				cfg.compactMode = on; saveConfig(); applyDynamicCSS();
			}),
			makeValueRow("Font size", cfg.fontSize > 0 ? `${cfg.fontSize} px` : "inherit", () => {
				const v = prompt("Message font size in px (0 = inherit, 10–24):", cfg.fontSize || 0);
				if (v === null) return;
				const n = parseInt(v, 10);
				if (n >= 0 && n <= 24) { cfg.fontSize = n; saveConfig(); applyDynamicCSS(); renderActiveTab(); }
			}),
			makeToggleRow("Floating export button", cfg.showExport, (on) => {
				cfg.showExport = on; saveConfig();
				if (on) injectExportButton(); else removeExportButton();
			}),
		]);

		makeSection(container, "Interface", [
			makeValueRow("Context window", fmtNum(cfg.contextWindow) + " tokens", () => {
				const n = parseInt(prompt("Context window size (tokens):", cfg.contextWindow), 10);
				if (n && n > 0) { cfg.contextWindow = n; saveConfig(); renderActiveTab(); updateStats(); }
			}),
			makeValueRow("Composer selector", cfg.composerSelector || "(auto)", () => {
				const v = prompt("CSS selector for the chat input (blank = auto-detect):", cfg.composerSelector);
				if (v !== null) { cfg.composerSelector = v.trim(); saveConfig(); renderActiveTab(); }
			}),
		]);

		const log = getContainer();
		const allMsgs = log ? getMessages(log) : [];
		const hiddenCount = allMsgs.filter((m) => m.dataset.ccHidden === "1").length;
		makeSection(container, "Status", [
			makeInfoRow("Messages detected", allMsgs.length > 0 ? `${allMsgs.length} total · ${hiddenCount} hidden` : "none"),
			makeInfoRow("Direction", allMsgs.length > 0 ? (detectReversed(allMsgs, log) ? "reversed" : "normal") : "n/a"),
			makeInfoRow("Composer", findComposer() ? "found" : "not found"),
			makeInfoRow("Virtualization", cfg.virtualize ? "active" : "off"),
			makeInfoRow("Thinking mode", thinkingMode),
		]);

		const resetWrap = document.createElement("div");
		resetWrap.style.cssText = "margin-top:20px;padding:0 4px;";
		const resetBtn = document.createElement("button");
		resetBtn.textContent = "Reset all settings";
		resetBtn.style.cssText = "width:100%;padding:10px;background:transparent;color:var(--cc-danger);border:1px solid var(--cc-border);border-radius:8px;font:inherit;font-size:12px;cursor:pointer;";
		resetBtn.addEventListener("mouseenter", () => {
			resetBtn.style.background = "var(--cc-hover)";
			resetBtn.style.borderColor = "var(--cc-danger)";
		});
		resetBtn.addEventListener("mouseleave", () => {
			resetBtn.style.background = "transparent";
			resetBtn.style.borderColor = "var(--cc-border)";
		});
		resetBtn.addEventListener("click", () => {
			if (!confirm("Reset all settings to defaults?")) return;
			Object.assign(cfg, DEFAULTS);
			saveConfig();
			applyDynamicCSS();
			virtualize();
			if (cfg.showExport) injectExportButton(); else removeExportButton();
			applyComposerVisibility();
			renderActiveTab();
			toast("Settings reset to defaults.", "success");
		});
		resetWrap.appendChild(resetBtn);
		container.appendChild(resetWrap);
	}

	function renderActions(container) {
		container.innerHTML = "";

		makeSection(container, "Agent", [
			makeActionItem("Create PR", "⊕", actionCreatePR),
			makeActionItem("Merge", "⇲", actionMerge),
		]);

		makeSection(container, "Session", [
			makeActionItem("Clear chat", "✕", actionClearChat),
			makeToggleRow("Hide Composer", cfg.hideComposer, (on) => {
				cfg.hideComposer = on;
				saveConfig();
				applyComposerVisibility();
				if (on && !document.querySelector('[data-cc-composer-hide="1"]')) {
					cfg.hideComposer = false;
					saveConfig();
					toast("Composer not detected — nothing to hide.", "error", 4000);
					return false;
				}
				toast(on ? "Composer hidden." : "Composer shown.", "success");
				return true;
			}),
		]);

		makeSection(container, "Export", [
			makeActionItem("Export chat as Markdown", "⬇", exportMarkdown),
		]);

		makeSection(container, "Debug", [
			makeActionItem("Run diagnostics", "🔍", actionDiagnostics),
		]);

		const note = document.createElement("div");
		note.style.cssText = "margin-top:14px;font-size:11px;color:var(--cc-text-muted);line-height:1.5;padding:0 4px;";
		note.textContent = "PR / Merge are sent to the agent through the composer. If the composer isn't found, the text is copied to your clipboard.";
		container.appendChild(note);
	}

	function renderStats(container) {
		const s = computeStats();
		container.innerHTML = "";

		if (!s) {
			const empty = document.createElement("div");
			empty.textContent = "No chat detected.";
			empty.style.cssText = "padding:24px 8px;text-align:center;color:var(--cc-text-muted);font-size:12px;";
			container.appendChild(empty);
			return;
		}

		const pct = s.contextPct;
		const barColor = pct > 90 ? "#e53935" : pct > 70 ? "#fb8c00" : "#43a047";
		const hero = makeStatHero(
			"Context usage",
			`${fmtNum(s.totalTokens)} / ${fmtNum(s.contextWindow)}`,
			`${pct.toFixed(1)}%`,
			pct,
			barColor
		);
		hero.style.marginBottom = "4px";
		container.appendChild(hero);

		makeSectionLabel(container, "Messages");
		container.appendChild(makeStatGrid([
			{ label: "Total", value: String(s.totalMsgs) },
			{ label: "Visible", value: String(s.visibleMsgs) },
			{ label: "Hidden", value: String(s.hiddenMsgs) },
		]));

		makeSectionLabel(container, "Tokens (est.)");
		container.appendChild(makeStatGrid([
			{ label: "Total", value: fmtNum(s.totalTokens) },
			{ label: "Visible", value: fmtNum(s.visibleTokens) },
			{ label: "Hidden", value: fmtNum(s.hiddenTokens) },
		]));

		makeSection(container, "Content", [
			makeInfoRow("Characters", s.totalChars.toLocaleString()),
			makeInfoRow("Code blocks", String(s.codeBlocks)),
			makeInfoRow("Thinking blocks", String(s.thinkingBlocks)),
		]);

		const footer = document.createElement("div");
		footer.style.cssText = "margin-top:14px;font-size:10.5px;color:var(--cc-text-muted);line-height:1.5;padding:0 4px;";
		footer.textContent = "Token counts are estimates (~4 chars/token). Refreshes once per second while this tab is open.";
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

	// ═══════════════════════════════════════════════════════════════════
	// CREATE DRAWER
	// ═══════════════════════════════════════════════════════════════════
	function createDrawer() {
		if (document.getElementById(DRAWER_ID)) return;
		const drawer = document.createElement("aside");
		drawer.id = DRAWER_ID;
		drawer.style.cssText = `position:fixed;top:0;left:0;bottom:0;width:320px;z-index:2147483645;transform:translateX(-100%);transition:transform 0.24s cubic-bezier(0.4,0,0.2,1);font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--cc-text);`;
		drawer.innerHTML = `
			<div class="cc-drawer-panel" style="position:absolute;inset:0;background:var(--cc-bg);border-right:1px solid var(--cc-border);box-shadow:var(--cc-shadow);display:flex;flex-direction:column;overflow:hidden;">
				<div style="padding:16px 20px;border-bottom:1px solid var(--cc-border);font-weight:600;font-size:14px;display:flex;align-items:center;gap:8px;color:var(--cc-text);">
					<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--cc-accent);"></span>
					Coding Edition
				</div>
				<div class="cc-drawer-tabs" style="display:flex;border-bottom:1px solid var(--cc-border);background:var(--cc-surface);">
					<button data-tab="settings">Settings</button>
					<button data-tab="actions">Actions</button>
					<button data-tab="stats">Statistics</button>
				</div>
				<div class="cc-drawer-content" style="flex:1;overflow-y:auto;padding:8px 20px 20px;color:var(--cc-text);"></div>
			</div>
			<button id="${DRAWER_TOGGLE_ID}" aria-label="Open panel"></button>
		`;
		const tabStyle = `flex:1;padding:10px 0;border:none;background:transparent;cursor:pointer;font:inherit;color:var(--cc-text-muted);border-bottom:2px solid transparent;font-size:12px;`;
		drawer.querySelectorAll(".cc-drawer-tabs button").forEach((b) => {
			b.style.cssText = tabStyle;
			b.addEventListener("click", () => switchTab(b.dataset.tab));
		});
		const toggle = drawer.querySelector(`#${DRAWER_TOGGLE_ID}`);
		toggle.style.cssText = `position:absolute;top:50%;left:320px;transform:translateY(-50%);width:30px;height:52px;background:var(--cc-bg);color:var(--cc-text);border:1px solid var(--cc-border);border-left:none;border-radius:0 8px 8px 0;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;box-shadow:var(--cc-shadow);`;
		toggle.addEventListener("mouseenter", () => (toggle.style.background = "var(--cc-surface)"));
		toggle.addEventListener("mouseleave", () => (toggle.style.background = "var(--cc-bg)"));
		toggle.addEventListener("click", toggleDrawer);
		document.body.appendChild(drawer);
		switchTab("settings");
		applyDrawerState();
	}

	// ═══════════════════════════════════════════════════════════════════
	// SCHEDULE + INIT
	// ═══════════════════════════════════════════════════════════════════
	let timer = null;
	let currentContainer = null;

	function schedule() {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			const container = getContainer();
			if (container && container !== currentContainer) {
				teardownAutoScroll();
				currentContainer = container;
				lastCollapseCount = 0;
				lastExpandCount = 0;
				requestAnimationFrame(() => setupAutoScroll(container));
			}
			if (container) {
				virtualize();
				decorateCodeBlocks();
				if (cfg.hideThinking) markThinkingBlocks();
				else if (cfg.keepThinkingExpanded) expandAllThinking(container);
				else if (cfg.collapseOldThinking) collapseOldThinking(container);
			}
			if (cfg.hideComposer && !document.querySelector('[data-cc-composer-hide="1"]')) {
				applyComposerVisibility();
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
		applyDynamicCSS();
		if (cfg.hideComposer) applyComposerVisibility();
		decorateCodeBlocks();
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
			applyDynamicCSS();
			if (cfg.hideComposer) applyComposerVisibility();
			decorateCodeBlocks();
			startObserver();
			setInterval(updateStats, 1000);
		}
	}, 6000);

	setInterval(() => {
		if (started && !document.getElementById(DRAWER_ID)) createDrawer();
		if (started && cfg.showExport && !document.getElementById(EXPORT_ID)) injectExportButton();
	}, 3000);
})();