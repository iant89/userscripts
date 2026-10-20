// ==UserScript==
// @name         Arena.ai | DOM Performance Optimizer
// @namespace    https://greasyfork.org/en/users/1462137-piknockyou
// @version      2.5.0
// @author       Piknockyou (vibe-coded)
// @license      AGPL-3.0
// @description  Fixes sluggish scrolling in Arena by virtualizing old messages, flattening 30k+ node Shiki codeblocks, neutralizing CSS blurs/transitions, and optionally keeping thinking blocks expanded.
// @match        *://*.arena.ai/*
// @match        *://*.canaryarena.ai/*
// @match        *://chat.lmsys.org/*
// @icon         https://arena.ai/favicon.ico
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// @downloadURL  https://update.greasyfork.org/scripts/577694/Arenaai%20%7C%20DOM%20Performance%20Optimizer.user.js
// @updateURL    https://update.greasyfork.org/scripts/577694/Arenaai%20%7C%20DOM%20Performance%20Optimizer.meta.js
// ==/UserScript==

(() => {
	let hasStarted = false;
	let pendingStart = false;

	// ═══════════════════════════════════════════════════════════════════
	// CONFIGURATION
	// ═══════════════════════════════════════════════════════════════════
	const DEFAULT_CONFIG = {
		visibleMessages: 6,
		flattenCodeblocks: true,
		killTransitions: true,
		killBlurs: true,
		addContainment: true,
		autoClean: true,
		autoCleanDelay: 1000,
		showToolbar: true,
		keepThinkingExpanded: false, // NEW: force-open reasoning/thinking blocks
	};

	function getConfig() {
		const stored = GM_getValue("arenaPerfConfigDOM", null);
		if (stored) {
			try {
				return { ...DEFAULT_CONFIG, ...JSON.parse(stored) };
			} catch (_e) {}
		}
		return { ...DEFAULT_CONFIG };
	}

	function saveConfig(cfg) {
		GM_setValue("arenaPerfConfigDOM", JSON.stringify(cfg));
	}

	const config = getConfig();

	// ═══════════════════════════════════════════════════════════════════
	// CONSTANTS
	// ═══════════════════════════════════════════════════════════════════
	const SURGEON_ID = "arena-perf-surgeon";
	const PAUSED_CLASS = "arena-perf-paused";

	function hideNth() {
		return config.visibleMessages + 2;
	}

	// ⚡ INSTANT CSS INJECTION (before body exists)
	try {
		const nth = hideNth();
		let css = `
			body:not(.${PAUSED_CLASS}) ol.flex-col-reverse > div:nth-child(n+${nth}),
			body:not(.${PAUSED_CLASS}) ol.flex-col-reverse > li:nth-child(n+${nth}) {
				display: none !important;
			}
		`;
		if (config.killTransitions)
			css += `*, *::before, *::after { transition: none !important; animation-duration: 0s !important; }`;
		if (config.killBlurs)
			css += `[class*="backdrop-blur"], [style*="backdrop-filter"] { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }`;
		const style = document.createElement("style");
		style.id = SURGEON_ID;
		style.textContent = css;
		(document.head || document.documentElement).appendChild(style);
	} catch (e) {
		console.error("[ArenaPerf] Early CSS fail", e);
	}

	// ═══════════════════════════════════════════════════════════════════
	// INTERNAL STATE
	// ═══════════════════════════════════════════════════════════════════
	let isPaused = false;
	const stats = { hiddenMsgs: 0, totalMsgs: 0, nodesFlattened: 0 };
	let observer = null;
	let cleanTimeout = null;
	let expandTimeout = null;
	let _settingsPopover = null;

	// ═══════════════════════════════════════════════════════════════════
	// MODULE A — CSS SURGEON
	// ═══════════════════════════════════════════════════════════════════
	function buildSurgeonCSS() {
		const nth = hideNth();
		let css = `/* ── Arena Perf: Base ── */\n`;

		css += `
			body:not(.${PAUSED_CLASS}) ol.flex-col-reverse > div:nth-child(n+${nth}),
			body:not(.${PAUSED_CLASS}) ol.flex-col-reverse > li:nth-child(n+${nth}) {
				display: none !important;
			}
		`;

		if (config.killTransitions) {
			css += `
				*, *::before, *::after {
					transition-property: color, background-color, border-color, opacity, transform !important;
					transition-duration: 150ms !important;
					animation-duration: 0s !important;
				}
				[class*="transition-[max-height]"] { transition: none !important; }
				[class*="overflow-"], [class*="scroller"], [data-radix-scroll-area-viewport] {
					scroll-behavior: auto !important;
				}
			`;
		}

		if (config.killBlurs) {
			css += `
				[class*="backdrop-blur"], [style*="backdrop-filter"] {
					backdrop-filter: none !important;
					-webkit-backdrop-filter: none !important;
				}
				.bg-white\\/50 { background-color: rgba(255,255,255,0.95) !important; }
				.bg-black\\/50 { background-color: rgba(0,0,0,0.95) !important; }
			`;
		}

		if (config.addContainment) {
			css += `
				[data-radix-scroll-area-viewport] { contain: layout paint; }
				ol.flex-col-reverse > div { contain: content; }
				pre, code, [class*="prose"] { contain: content; }
			`;
		}

		return css;
	}

	function applySurgeryCSS() {
		let el = document.getElementById(SURGEON_ID);
		if (!el) {
			el = document.createElement("style");
			el.id = SURGEON_ID;
			(document.head || document.documentElement).appendChild(el);
		}
		el.textContent = buildSurgeonCSS();
	}

	// ═══════════════════════════════════════════════════════════════════
	// MODULE B — DOM VIRTUALIZER & FLATTENER
	// ═══════════════════════════════════════════════════════════════════
	function getMessageContainer() {
		return document.querySelector("ol.flex-col-reverse");
	}

	function getMessages(container) {
		if (!container) return [];
		return Array.from(container.children).filter((el) => {
			const isMsg = el.tagName === "DIV" || el.tagName === "LI";
			const isNotSpacer = !el.classList.contains("h-0");
			return isMsg && isNotSpacer;
		});
	}

	function flattenShikiBlocks(msgNode) {
		if (!config.flattenCodeblocks) return 0;
		let flattened = 0;
		const codes = msgNode.querySelectorAll(
			'pre.shiki code:not([data-perf-flat="1"])',
		);
		codes.forEach((code) => {
			if (code.children.length > 0) {
				const lines = code.querySelectorAll(".line");
				let rawText = "";
				if (lines.length > 0) {
					rawText = Array.from(lines).map((l) => l.textContent).join("\n");
				} else {
					rawText = code.textContent;
				}
				code.innerHTML = "";
				code.textContent = rawText;
				code.dataset.perfFlat = "1";
				flattened++;
			}
		});
		return flattened;
	}

	// ═══════════════════════════════════════════════════════════════════
	// MODULE B2 — THINKING / REASONING BLOCK EXPANDER
	// ═══════════════════════════════════════════════════════════════════
	// Matches trigger text like "Thinking…", "Thought for 8s", "Reasoning",
	// "Show thinking", "Hide thinking". Will NOT match "Show more", "Load more", etc.
	const THINKING_RE = /\b(?:think|thought|reason|chain[-\s]of[-\s]thought)/i;

	function isThinkingTrigger(el) {
		if (!el || !el.getAttribute) return false;
		const text = (el.textContent || "").trim();
		if (text && THINKING_RE.test(text)) return true;
		const label = el.getAttribute("aria-label") || "";
		if (label && THINKING_RE.test(label)) return true;
		const cls = typeof el.className === "string" ? el.className : "";
		if (cls && /think|reason/i.test(cls)) return true;
		for (const a of ["data-testid", "data-test-id", "data-slot"]) {
			const v = el.getAttribute(a) || "";
			if (v && THINKING_RE.test(v)) return true;
		}
		return false;
	}

	// Scans a single message node and expands any collapsed thinking blocks.
	// Returns number of blocks expanded.
	function expandThinkingInNode(root) {
		if (!root) return 0;
		let count = 0;

		// 1. Native <details>
		root.querySelectorAll("details:not([open])").forEach((d) => {
			if (isThinkingTrigger(d.querySelector("summary") || d)) {
				d.open = true;
				count++;
			}
		});

		// 2. Radix Collapsible / aria-expanded toggles
		const triggers = root.querySelectorAll(
			'[data-radix-collapsible-trigger], button[aria-expanded], [data-state][role="button"]',
		);
		triggers.forEach((t) => {
			const state = t.getAttribute("data-state");
			const aria = t.getAttribute("aria-expanded");
			// Already open → leave alone
			if (state === "open" || aria === "true") return;
			if (!isThinkingTrigger(t)) return;
			try {
				t.click();
				count++;
			} catch (_e) {}
		});

		return count;
	}

	// Scans only the currently-visible messages (respects virtualization).
	function expandThinkingBlocks() {
		if (!config.keepThinkingExpanded) return 0;
		const container = getMessageContainer();
		if (!container) return 0;

		const msgs = getMessages(container);
		const limit = isPaused ? msgs.length : config.visibleMessages;
		const end = Math.min(limit, msgs.length);

		let count = 0;
		for (let i = 0; i < end; i++) {
			count += expandThinkingInNode(msgs[i]);
		}

		if (count > 0) {
			console.log(`[ArenaPerf] Expanded ${count} thinking block(s).`);
		}
		return count;
	}

	function scheduleExpand() {
		if (expandTimeout) clearTimeout(expandTimeout);
		expandTimeout = setTimeout(() => expandThinkingBlocks(), 150);
	}

	// ═══════════════════════════════════════════════════════════════════
	// MODULE B3 — CLEAN CYCLE
	// ═══════════════════════════════════════════════════════════════════
	function cleanMessages(force = false) {
		if (!force && !config.autoClean) return;

		const container = getMessageContainer();
		if (!container) return;

		if (observer) observer.disconnect();

		try {
			const msgs = getMessages(container);
			stats.totalMsgs = msgs.length;

			if (isPaused) {
				stats.hiddenMsgs = Math.max(0, msgs.length - config.visibleMessages);
			} else {
				let hidden = 0;
				let newFlattened = 0;

				msgs.forEach((msg, index) => {
					if (index >= config.visibleMessages) {
						newFlattened += flattenShikiBlocks(msg);
						hidden++;
					}
					if (msg.style.display === "none") msg.style.display = "";
				});

				stats.hiddenMsgs = hidden;
				stats.nodesFlattened += newFlattened;

				if (newFlattened > 0) {
					console.log(
						`[ArenaPerf] Flattened ${newFlattened} codeblocks in hidden messages.`,
					);
				}
			}

			// NEW: expand thinking blocks on visible messages
			if (config.keepThinkingExpanded) expandThinkingBlocks();
		} finally {
			startObserver();
			updateToolbar();
		}
	}

	function setPaused(paused) {
		isPaused = paused;
		if (document.body) document.body.classList.toggle(PAUSED_CLASS, paused);
		if (!paused) cleanMessages();
		if (config.keepThinkingExpanded) expandThinkingBlocks();
		updateToolbar();
	}

	// ═══════════════════════════════════════════════════════════════════
	// MODULE C — TOOLBAR UI
	// ═══════════════════════════════════════════════════════════════════
	const TOOLBAR_ID = "arena-perf-toolbar";
	const POPOVER_ID = "arena-perf-settings";

	let toolbarEl, statsEl, toggleBtn;

	function createToolbar() {
		if (!config.showToolbar || document.getElementById(TOOLBAR_ID)) return;

		GM_addStyle(`
			#${TOOLBAR_ID} {
				position: fixed; bottom: 0; left: 50%; transform: translateX(-50%);
				z-index: 2147483647; background: #09090b; color: #4ade80;
				padding: 0 4px; border-radius: 6px 6px 0 0;
				font: 11px/1.4 system-ui, sans-serif; display: flex; align-items: center; gap: 2px;
				border: 1px solid #27272a; border-bottom: none; box-shadow: 0 -2px 10px rgba(0,0,0,0.5);
				user-select: none;
			}
			#${TOOLBAR_ID} button {
				all: unset; cursor: pointer; padding: 2px 8px; border-radius: 4px;
				color: #e4e4e7; white-space: nowrap; transition: background 0.1s;
			}
			#${TOOLBAR_ID} button:hover { background: rgba(255,255,255,0.1); }
			#${TOOLBAR_ID} .perf-stats { padding: 3px 6px; pointer-events: none; }

			#${POPOVER_ID} {
				position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%);
				z-index: 2147483647; background: #18181b; color: #e4e4e7;
				border-radius: 10px; padding: 14px 18px; font: 13px/1.5 system-ui, sans-serif;
				box-shadow: 0 -4px 24px rgba(0,0,0,0.6); border: 1px solid #27272a;
				display: flex; flex-direction: column; gap: 8px; min-width: 280px;
			}
			#${POPOVER_ID} .perf-row {
				display: flex; align-items: center; justify-content: space-between; gap: 12px;
				padding: 6px 8px; border-radius: 6px; cursor: pointer;
			}
			#${POPOVER_ID} .perf-row:hover { background: rgba(255,255,255,0.05); }
			#${POPOVER_ID} .perf-on { color: #4ade80; font-weight: bold; }
			#${POPOVER_ID} .perf-off { color: #a1a1aa; font-weight: bold; }
			#${POPOVER_ID} hr { border: 0; border-top: 1px solid #27272a; margin: 4px 0; }
		`);

		toolbarEl = document.createElement("div");
		toolbarEl.id = TOOLBAR_ID;

		toggleBtn = document.createElement("button");
		toggleBtn.addEventListener("click", () => setPaused(!isPaused));

		statsEl = document.createElement("span");
		statsEl.className = "perf-stats";

		const forceBtn = document.createElement("button");
		forceBtn.textContent = "🧹";
		forceBtn.title = "Force Clean Now";
		forceBtn.addEventListener("click", () => {
			if (isPaused) setPaused(false);
			cleanMessages(true);
		});

		const settingsBtn = document.createElement("button");
		settingsBtn.textContent = "⚙️";
		settingsBtn.addEventListener("click", toggleSettingsPopover);

		toolbarEl.appendChild(toggleBtn);
		toolbarEl.appendChild(statsEl);
		toolbarEl.appendChild(forceBtn);
		toolbarEl.appendChild(settingsBtn);

		document.body.appendChild(toolbarEl);
		updateToolbar();

		setInterval(() => {
			if (toolbarEl && !document.body.contains(toolbarEl)) {
				console.log("[ArenaPerf] Watchdog: Re-attaching toolbar");
				document.body.appendChild(toolbarEl);
			}
		}, 2000);
	}

	function updateToolbar() {
		if (!statsEl) return;

		toggleBtn.textContent = isPaused ? "👁️ All" : "🔒 Hide";
		toggleBtn.style.color = isPaused ? "#fcd34d" : "#e4e4e7";

		const statText = isPaused
			? `${stats.totalMsgs} msgs · paused`
			: `${stats.totalMsgs - stats.hiddenMsgs}/${stats.totalMsgs} msgs`;

		statsEl.textContent = statText;
		statsEl.style.color = isPaused
			? "#fcd34d"
			: stats.hiddenMsgs > 0
				? "#4ade80"
				: "#a1a1aa";
	}

	function toggleSettingsPopover() {
		if (_settingsPopover) {
			_settingsPopover.remove();
			_settingsPopover = null;
			return;
		}

		const panel = document.createElement("div");
		panel.id = POPOVER_ID;

		function addToggle(icon, label, getValue, onToggle) {
			const row = document.createElement("div");
			row.className = "perf-row";
			const render = () => {
				const on = getValue();
				row.innerHTML = `<span>${icon} ${label}</span><span class="${on ? "perf-on" : "perf-off"}">${on ? "ON" : "OFF"}</span>`;
			};
			render();
			row.addEventListener("click", () => {
				onToggle();
				render();
				saveConfig(config);
			});
			panel.appendChild(row);
			return row;
		}

		const head = document.createElement("div");
		head.style.cssText =
			"font-weight:bold; font-size:14px; margin-bottom:4px; text-align:center;";
		head.textContent = "DOM Optimizer Settings";
		panel.appendChild(head);

		addToggle(
			"⚡",
			"Kill Transitions",
			() => config.killTransitions,
			() => {
				config.killTransitions = !config.killTransitions;
				applySurgeryCSS();
			},
		);

		addToggle(
			"🌫️",
			"Kill GPU Blurs",
			() => config.killBlurs,
			() => {
				config.killBlurs = !config.killBlurs;
				applySurgeryCSS();
			},
		);

		addToggle(
			"🔥",
			"Flatten Shiki Spans",
			() => config.flattenCodeblocks,
			() => {
				config.flattenCodeblocks = !config.flattenCodeblocks;
				if (config.flattenCodeblocks) cleanMessages();
			},
		);

		addToggle(
			"📦",
			"CSS Containment",
			() => config.addContainment,
			() => {
				config.addContainment = !config.addContainment;
				applySurgeryCSS();
			},
		);

		// ── NEW: Keep Thinking Expanded ──
		const thinkRow = addToggle(
			"🧠",
			"Keep Thinking Expanded",
			() => config.keepThinkingExpanded,
			() => {
				config.keepThinkingExpanded = !config.keepThinkingExpanded;
				if (config.keepThinkingExpanded) expandThinkingBlocks();
			},
		);
		thinkRow.title =
			"Force reasoning/thinking blocks to stay open. Overrides manual collapses.";

		panel.appendChild(document.createElement("hr"));

		const numRow = document.createElement("div");
		numRow.className = "perf-row";
		numRow.innerHTML = `<span>📝 Visible Messages</span><span style="color:#60a5fa;font-weight:bold">${config.visibleMessages}</span>`;
		numRow.addEventListener("click", () => {
			const val = prompt(
				"Number of recent messages to keep visible?",
				config.visibleMessages,
			);
			const num = parseInt(val, 10);
			if (num && num > 0) {
				config.visibleMessages = num;
				saveConfig(config);
				applySurgeryCSS();
				cleanMessages(true);
				panel.remove();
				_settingsPopover = null;
			}
		});
		panel.appendChild(numRow);

		document.body.appendChild(panel);
		_settingsPopover = panel;

		setTimeout(() => {
			const closeHandler = (e) => {
				if (!panel.contains(e.target) && !toolbarEl.contains(e.target)) {
					panel.remove();
					_settingsPopover = null;
					document.removeEventListener("mousedown", closeHandler);
				}
			};
			document.addEventListener("mousedown", closeHandler);
		}, 0);
	}

	// ═══════════════════════════════════════════════════════════════════
	// MODULE D — OBSERVER & ORCHESTRATOR
	// ═══════════════════════════════════════════════════════════════════

	function scheduleClean() {
		if (cleanTimeout) clearTimeout(cleanTimeout);
		cleanTimeout = setTimeout(() => cleanMessages(), config.autoCleanDelay);
	}

	function startObserver() {
		if (observer) observer.disconnect();

		observer = new MutationObserver((mutations) => {
			let shouldClean = false;
			let shouldExpand = false;

			for (const m of mutations) {
				if (m.type === "childList" && m.addedNodes.length > 0) {
					if (
						m.target instanceof Element &&
						m.target.matches("ol.flex-col-reverse")
					) {
						shouldClean = true;
						shouldExpand = true;
					} else {
						for (const node of m.addedNodes) {
							if (
								node.nodeType !== 1 ||
								typeof node.querySelector !== "function"
							)
								continue;
							if (
								node.matches?.("ol.flex-col-reverse") ||
								node.querySelector("ol.flex-col-reverse")
							) {
								shouldClean = true;
								shouldExpand = true;
								break;
							}
						}
					}
				} else if (
					m.type === "attributes" &&
					config.keepThinkingExpanded
				) {
					// A thinking block collapsed (or was collapsed by Arena) → re-expand
					const t = m.target;
					if (!(t instanceof Element)) continue;
					const state = t.getAttribute("data-state");
					const aria = t.getAttribute("aria-expanded");
					if (
						(state === "closed" || aria === "false") &&
						isThinkingTrigger(t)
					) {
						shouldExpand = true;
					} else if (
						t.tagName === "DETAILS" &&
						!t.open &&
						isThinkingTrigger(t.querySelector("summary") || t)
					) {
						shouldExpand = true;
					}
				}
			}

			if (shouldClean) scheduleClean();
			if (shouldExpand) scheduleExpand();
		});

		observer.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["data-state", "aria-expanded", "open", "hidden"],
		});
	}

	function initializeUI() {
		if (document.visibilityState !== "visible") {
			pendingStart = true;
			console.log("[ArenaPerf] Deferring init until tab is visible");
			return;
		}

		if (hasStarted) return;
		hasStarted = true;

		console.log("[ArenaPerf] Booting DOM Virtualizer & Flattener...");
		applySurgeryCSS();
		if (config.showToolbar) createToolbar();
		startObserver();

		setTimeout(cleanMessages, 1000);
		setTimeout(cleanMessages, 3000);
		if (config.keepThinkingExpanded) {
			setTimeout(expandThinkingBlocks, 1200);
			setTimeout(expandThinkingBlocks, 3200);
		}
	}

	function scheduleInit() {
		if (document.visibilityState !== "visible") {
			pendingStart = true;
			return;
		}

		if (window.requestIdleCallback) {
			const idleId = window.requestIdleCallback(initializeUI, {
				timeout: 1000,
			});
			setTimeout(() => {
				if (!hasStarted) {
					window.cancelIdleCallback(idleId);
					initializeUI();
				}
			}, 1500);
		} else {
			setTimeout(initializeUI, 100);
		}
	}

	function waitForReady() {
		const READY_SELECTOR = "form textarea";

		if (document.querySelector(READY_SELECTOR)) {
			scheduleInit();
			return;
		}

		const readyObserver = new MutationObserver(() => {
			if (document.querySelector(READY_SELECTOR)) {
				readyObserver.disconnect();
				setTimeout(scheduleInit, 200);
			}
		});

		readyObserver.observe(document.body, { childList: true, subtree: true });
	}

	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState !== "visible") return;

		if (pendingStart && !hasStarted) {
			pendingStart = false;
			setTimeout(initializeUI, 250);
		}
	});

	setTimeout(() => {
		if (document.visibilityState !== "visible") {
			pendingStart = true;
			return;
		}
		if (!hasStarted && document.querySelector("form textarea")) {
			console.warn("[ArenaPerf] Emergency init after 5s");
			initializeUI();
		}
	}, 5000);

	// Ultra-fast body detection
	if (document.body) {
		waitForReady();
	} else {
		const bodyObserver = new MutationObserver(() => {
			if (document.body) {
				bodyObserver.disconnect();
				waitForReady();
			}
		});
		bodyObserver.observe(document.documentElement, { childList: true });
	}
})();