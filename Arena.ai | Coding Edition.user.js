// ==UserScript==
// @name         Arena.ai | Coding Edition
// @namespace    https://greasyfork.org/en/users/1462137-piknockyou
// @version      3.1.0
// @author       Piknockyou (vibe-coded)
// @license      AGPL-3.0
// @description  Virtualizes old messages, strips heavy CSS, auto-scrolls, collapses old thinking, shows token stats, and adds action buttons (PR / merge / clear / hide composer) in a slide-out drawer. Export as Markdown.
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
			html[data-cc-hide-composer="1"] [data-cc-composer="1"] { display: none !important; }
		`;
	}
	injectPerfCSS();

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

	// ═══════════════════════════════════════════════════════════════════
	// TOAST
	// ═══════════════════════════════════════════════════════════════════
	function toast(msg, kind = "info") {
		const t = document.createElement("div");
		t.textContent = msg;
		t.style.cssText = `
			position: fixed; bottom: 90px; left: 50%; transform: translateX(-50%);
			padding: 10px 18px; border-radius: 8px;
			font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
			color: #fff; z-index: 2147483647;
			box-shadow: 0 4px 16px rgba(0,0,0,0.2);
			background: #333;
			opacity: 0; transition: opacity 0.2s ease;
			max-width: 80vw; text-align: center;
		`;
		if (kind === "error") t.style.background = "#c62828";
		if (kind === "success") t.style.background = "#2e7d32";
		document.body.appendChild(t);
		requestAnimationFrame(() => { t.style.opacity = "1"; });
		setTimeout(() => {
			t.style.opacity = "0";
			setTimeout(() => t.remove(), 300);
		}, 2600);
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
	// MARKDOWN EXPORT
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
			if (/^h[1-6]$/.test(tag)) {
				out.push("\n" + "#".repeat(Number(tag[1])) + " ");
				node.childNodes.forEach(walk); out.push("\n\n"); return;
			}
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
		toast("Exported " + ordered.length + " messages.", "success");
	}

	// ═══════════════════════════════════════════════════════════════════
	// COMPOSER (find / hide / show)
	// ═══════════════════════════════════════════════════════════════════
	function findComposerInput() {
		const selectors = [
			'form textarea:not(.g-recaptcha-response)',
			'textarea:not(.g-recaptcha-response)',
			'[contenteditable="true"]:not([role="log"] *)',
			'[role="textbox"]:not([role="log"] *)',
			'input[type="text"]:not(.g-recaptcha-response)',
			'input:not([type]):not(.g-recaptcha-response)',
		];
		for (const sel of selectors) {
			const els = document.querySelectorAll(sel);
			for (const el of els) {
				const r = el.getBoundingClientRect();
				if (r.width > 40 && r.height > 12) return el;
			}
		}
		// Fallback: bottom-of-viewport input
		const all = document.querySelectorAll('textarea:not(.g-recaptcha-response), [contenteditable="true"], input[type="text"], [role="textbox"]');
		for (const el of all) {
			const r = el.getBoundingClientRect();
			if (r.width > 40 && r.height > 12 && r.top > window.innerHeight * 0.55) return el;
		}
		return null;
	}

	function findComposerWrapper() {
		const input = findComposerInput();
		if (!input) return null;

		// Prefer a form ancestor if present
		const form = input.closest("form");
		if (form) return form;

		// Otherwise walk up a small number of levels, stopping before we get too big
		let wrapper = input;
		for (let i = 0; i < 6; i++) {
			if (!wrapper.parentElement || wrapper.parentElement === document.body) break;
			const parent = wrapper.parentElement;
			const pr = parent.getBoundingClientRect();
			if (pr.height > window.innerHeight * 0.5) break;
			wrapper = parent;
		}
		return wrapper;
	}

	function applyComposerVisibility() {
		const hide = !!cfg.hideComposer;
		document.documentElement.toggleAttribute("data-cc-hide-composer", hide);
		// Clear old markers
		document.querySelectorAll('[data-cc-composer="1"]').forEach((el) => el.removeAttribute("data-cc-composer"));
		if (!hide) return;
		const wrapper = findComposerWrapper();
		if (wrapper) wrapper.setAttribute("data-cc-composer", "1");
	}

	function toggleComposer() {
		cfg.hideComposer = !cfg.hideComposer;
		saveConfig();
		applyComposerVisibility();
		renderActiveTab();
		toast(cfg.hideComposer ? "Entry panel hidden." : "Entry panel shown.", "success");
	}

	// ═══════════════════════════════════════════════════════════════════
	// ARENA ACTION HELPERS
	// ═══════════════════════════════════════════════════════════════════
	function clickFirstMatching(patterns) {
		const els = document.querySelectorAll('button, [role="button"], a');
		for (const el of els) {
			const txt = ((el.textContent || "") + " " + (el.getAttribute("aria-label") || "")).trim().toLowerCase();
			if (!txt) continue;
			const r = el.getBoundingClientRect();
			if (r.width === 0 || r.height === 0) continue;
			// Must be inside viewport-ish
			if (r.bottom < 0 || r.top > window.innerHeight) continue;
			for (const p of patterns) {
				if (txt.includes(p.toLowerCase())) {
					el.click();
					return el;
				}
			}
		}
		return null;
	}

	function actionCreatePR() {
		const patterns = [
			"create pull request", "create pr", "open pull request", "open pr",
			"submit pull request", "submit pr", "new pull request", "new pr",
		];
		const el = clickFirstMatching(patterns);
		if (el) toast(`Clicked "${(el.textContent || "").trim().slice(0, 30)}".`, "success");
		else toast("No 'Create PR' button visible. Open the workspace panel or ask the agent to create a PR.", "error");
	}

	function actionMerge() {
		const patterns = [
			"merge pull request", "merge pr", "merge changes",
			"merge into main", "merge branch", "merge",
		];
		const el = clickFirstMatching(patterns);
		if (el) toast(`Clicked "${(el.textContent || "").trim().slice(0, 30)}".`, "success");
		else toast("No 'Merge' button visible. A PR may not exist yet.", "error");
	}

	function actionClearChat() {
		const patterns = [
			"new chat", "new conversation", "start new chat",
			"clear chat", "reset chat", "delete chat",
		];
		const el = clickFirstMatching(patterns);
		if (el) { toast("Started a new chat.", "success"); return; }
		if (confirm("Could not find a 'New chat' button in the current view. Navigate to a fresh chat instead?")) {
			location.href = "/";
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// FLOATING EXPORT BUTTON
	// ═══════════════════════════════════════════════════════════════════
	const EXPORT_ID = "cc-export-btn";
	function injectExportButton() {
		if (!cfg.showExport || document.getElementById(EXPORT_ID)) return;
		const btn = document.createElement("button");
		btn.id = EXPORT_ID; btn.textContent = "⬇ export.md"; btn.title = "Export chat as Markdown";
		btn.style.cssText = `position:fixed;right:20px;bottom:20px;z-index:2147483647;padding:8px 14px;background:#fff;color:#1a1a1a;border:1px solid #d4d4d4;border-radius:8px;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.12);`;
		btn.addEventListener("mouseenter", () => { btn.style.background = "#f5f5f5"; btn.style.borderColor = "#b0b0b0"; });
		btn.addEventListener("mouseleave", () => { btn.style.background = "#fff"; btn.style.borderColor = "#d4d4d4"; });
		btn.addEventListener("click", exportMarkdown);
		document.body.appendChild(btn);
	}
	function removeExportButton() { const b = document.getElementById(EXPORT_ID); if (b) b.remove(); }

	// ═══════════════════════════════════════════════════════════════════
	// STATISTICS
	// ═══════════════════════════════════════════════════════════════════
	function estimateTokens(chars) { return Math.round(chars / 4); }
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
		toggle.setAttribute("aria-label", drawerOpen ? "Close panel" : "Open panel");
		toggle.title = drawerOpen ? "Close panel" : "Open Coding Edition";
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

	// ── Settings tab ──
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
		container.appendChild(makeSectionLabel("Actions"));
		container.appendChild(makeActionButton("⬇ Export chat as Markdown", exportMarkdown));
		container.appendChild(makeActionButton("↻ Force re-virtualize now", () => {
			virtualize(); collapseOldThinking(getContainer());
			if (activeTab === "stats") updateStats();
			toast("Re-virtualized.", "success");
		}));
		container.appendChild(makeActionButton("⤓ Scroll to bottom", () => scrollToBottom(getContainer(), true)));
	}

	// ── Actions tab (NEW) ──
	function renderActions(container) {
		container.innerHTML = "";

		container.appendChild(makeSectionLabel("Pull request"));
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

		const note = document.createElement("div");
		note.style.cssText = "margin-top:16px;font-size:11px;color:#999;line-height:1.5;";
		note.innerHTML = `PR / Merge / Clear actions look for Arena's own buttons in the current view and click them. If a button isn't present (e.g. no PR exists yet), you'll get a toast.`;
		container.appendChild(note);
	}

	// ── Statistics tab ──
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
		footer.innerHTML = `Token counts are estimates (~4 chars/token).<br>Refreshes once per second while this tab is open.`;
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
		drawer.setAttribute("aria-label", "Coding Edition panel");
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
		toggle.addEventListener("mouseenter", () => (toggle.style.background = "#f5f5f5"));
		toggle.addEventListener("mouseleave", () => (toggle.style.background = "#ffffff"));
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
			if (container) {
				virtualize();
				collapseOldThinking(container);
			}
			// Re-apply composer hiding (React may have re-rendered the composer node)
			if (cfg.hideComposer) applyComposerVisibility();
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
		applyComposerVisibility();
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
			applyComposerVisibility();
			startObserver();
			setInterval(updateStats, 1000);
		}
	}, 6000);

	setInterval(() => {
		if (started && !document.getElementById(DRAWER_ID)) createDrawer();
		if (started && cfg.showExport && !document.getElementById(EXPORT_ID)) injectExportButton();
	}, 3000);
})();