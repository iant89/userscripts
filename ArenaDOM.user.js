// ==UserScript==
// @name         Arena.ai | DOM Performance Optimizer
// @namespace    https://greasyfork.org/en/users/1462137-piknockyou
// @version      3.0.0
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
		keepThinkingExpanded: false,
	};

	function getConfig() {
		const stored = GM_getValue("arenaPerfConfigDOM", null);
		if (stored) {
			try { return { ...DEFAULT_CONFIG, ...JSON.parse(stored) }; } catch (_e) {}
		}
		return { ...DEFAULT_CONFIG };
	}
	function saveConfig(cfg) { GM_setValue("arenaPerfConfigDOM", JSON.stringify(cfg)); }

	const config = getConfig();

	// ═══════════════════════════════════════════════════════════════════
	// CONSTANTS
	// ═══════════════════════════════════════════════════════════════════
	const SURGEON_ID = "arena-perf-surgeon";
	const LOG_SELECTOR = '[role="log"]';

	// ⚡ INSTANT CSS INJECTION (before body exists)
	// NOTE: we no longer do CSS-based message hiding — the JS virtualizer is
	// the single source of truth (role=log + flex-col makes CSS thresholds
	// fragile). The flash window is tiny because chat hydrates after JS runs.
	try {
		let css = "";
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
		let css = `/* ── Arena Perf v3 ── */\n`;

		if (config.killTransitions) {
			css += `
				*, *::before, *::after {
					transition-property: color, background-color, border-color, opacity, transform !important;
					transition-duration: 150ms !important;
					animation-duration: 0s !important;
				}
				[class*="transition-[max-height]"] { transition: none !important; }
				${LOG_SELECTOR}, [class*="overflow-"], [class*="scroller"] {
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
			`;
		}

		if (config.addContainment) {
			css += `
				${LOG_SELECTOR} > * { contain: layout style; }
				pre, code, [class*="prose"] { contain: layout style; }
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
	// MODULE B — MESSAGE CONTAINER / NODE HELPERS
	// ═══════════════════════════════════════════════════════════════════

	// Diagnostic confirmed the chat container is [role="log"].
	// There's typically only one, but defensive: pick the one with the most children.
	function getMessageContainer() {
		const logs = document.querySelectorAll(LOG_SELECTOR);
		if (logs.length === 0) return null;
		if (logs.length === 1) return logs[0];
		let best = logs[0];
		for (const el of logs) if (el.children.length > best.children.length) best = el;
		return best;
	}

	// Container class tells us ordering:
	//   flex-col-reverse → index 0 is newest (old layout)
	//   flex-col         → last index is newest (current layout)
	function isReversed(container) {
		if (!container) return false;
		const cls = typeof container.className === "string" ? container.className : "";
		return /\bflex-col-reverse\b/.test(cls);
	}

	// Filter direct children that are actual messages (skip spacers, hidden, empty wrappers)
	function getMessages(container) {
		if (!container) return [];
		return Array.from(container.children).filter((el) => {
			if (!(el instanceof HTMLElement)) return false;
			if (el.classList.contains("h-0")) return false;
			if (el.hidden) return false;
			return true;
		});
	}

	// Strips Shiki <span> tags from code blocks in a message (perf win).
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
	// Diagnostic confirmed trigger shape:
	//   <button data-state="closed" aria-expanded="false">Thought for 14 seconds</button>
	// Content sibling has data-state="closed" too (Radix Collapsible).
	const THINKING_RE = /\b(?:think|thought|reason|chain[-\s]of[-\s]thought)/i;

	function isThinkingTrigger(el) {
		if (!el || !el.getAttribute) return false;
		const text = (el.textContent || "").trim();
		if (text && THINKING_RE.test(text)) return true;
		const label = el.getAttribute("aria-label") || "";
		if (label && THINKING_RE.test(label)) return true;
		return false;
	}

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

		// 2. Radix Collapsible triggers — diag shows data-state="closed" on the button
		root.querySelectorAll('button[data-state="closed"]').forEach((btn) => {
			if (isThinkingTrigger(btn)) {
				try {
					btn.click();
					count++;
				} catch (_e) {}
			}
		});

		return count;
	}

	// Scans only currently-visible messages (respects virtualization).
	function expandThinkingBlocks() {
		if (!config.keepThinkingExpanded) return 0;
		const container = getMessageContainer();
		if (!container) return 0;

		const msgs = getMessages(container);
		const keep = isPaused ? msgs.length : config.visibleMessages;
		const reversed = isReversed(container);

		let start, end;
		if (reversed) {
			start = 0;
			end = Math.min(keep, msgs.length);
		} else {
			start = Math.max(0, msgs.length - keep);
			end = msgs.length;
		}

		let count = 0;
		for (let i = start; i < end; i++) {
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
				// Paused: show all, do not flatten (user is inspecting)
				for (const m of msgs) {
					if (m.style.display === "none") m.style.display = "";
				}
				stats.hiddenMsgs = 0;
			} else {
				const keep = config.visibleMessages;
				const total = msgs.length;
				const reversed = isReversed(container);

				let hidden = 0;
				let newFlattened = 0;

				msgs.forEach((msg, index) => {
					// Determine if this message is "newest" (kept visible)
					const isNewest = reversed
						? index < keep
						: index >= total - keep;

					if (isNewest) {
						if (msg.style.display === "none") msg.style.display = "";
					} else {
						newFlattened += flattenShikiBlocks(msg);
						if (msg.style.display !== "none") msg.style.display = "none";
						hidden++;
					}
				});

				stats.hiddenMsgs = hidden;
				stats.nodesFlattened += newFlattened;

				if (newFlattened > 0) {
					console.log(`[ArenaPerf] Flattened ${newFlattened} codeblocks in hidden messages.`);
				}
			}

			if (config.keepThinkingExpanded) expandThinkingBlocks();
		} finally {
			startObserver();
			updateToolbar();
		}
	}

	function setPaused(paused) {
		isPaused = paused;
		cleanMessages(true); // always run so pause state is applied immediately
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
		head.style.cssText = "font-weight:bold; font-size:14px; margin-bottom:4px; text-align:center;";
		head.textContent = "DOM Optimizer Settings";
		panel.appendChild(head);

		addToggle("⚡", "Kill Transitions", () => config.killTransitions, () => {
			config.killTransitions = !config.killTransitions;
			applySurgeryCSS();
		});

		addToggle("🌫️", "Kill GPU Blurs", () => config.killBlurs, () => {
			config.killBlurs = !config.killBlurs;
			applySurgeryCSS();
		});

		addToggle("🔥", "Flatten Shiki Spans", () => config.flattenCodeblocks, () => {
			config.flattenCodeblocks = !config.flattenCodeblocks;
			if (config.flattenCodeblocks) cleanMessages(true);
		});

		addToggle("📦", "CSS Containment", () => config.addContainment, () => {
			config.addContainment = !config.addContainment;
			applySurgeryCSS();
		});

		addToggle("🧠", "Keep Thinking Expanded", () => config.keepThinkingExpanded, () => {
			config.keepThinkingExpanded = !config.keepThinkingExpanded;
			if (config.keepThinkingExpanded) expandThinkingBlocks();
		}).title = "Force reasoning/thinking blocks to stay open. Overrides manual collapses.";

		panel.appendChild(document.createElement("hr"));

		const numRow = document.createElement("div");
		numRow.className = "perf-row";
		numRow.innerHTML = `<span>📝 Visible Messages</span><span style="color:#60a5fa;font-weight:bold">${config.visibleMessages}</span>`;
		numRow.addEventListener("click", () => {
			const val = prompt("Number of recent messages to keep visible?", config.visibleMessages);
			const num = parseInt(val, 10);
			if (num && num > 0) {
				config.visibleMessages = num;
				saveConfig(config);
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
			const log = getMessageContainer();
			if (!log) return;

			let shouldClean = false;
			let shouldExpand = false;

			for (const m of mutations) {
				if (m.type === "childList") {
					// A message list change: additions/removals directly on the log
					if (m.target === log && (m.addedNodes.length > 0 || m.removedNodes.length > 0)) {
						shouldClean = true;
						shouldExpand = true;
						continue;
					}
					// Container swap (SPA nav replaces role=log itself)
					for (const node of m.addedNodes) {
						if (node instanceof Element && node.matches && node.matches(LOG_SELECTOR)) {
							shouldClean = true;
							break;
						}
					}
				} else if (m.type === "attributes" && config.keepThinkingExpanded) {
					// A thinking block collapsed → re-expand
					const t = m.target;
					if (!(t instanceof Element)) continue;
					if (!log.contains(t)) continue;
					const state = t.getAttribute("data-state");
					const aria = t.getAttribute("aria-expanded");
					const isClosed =
						state === "closed" ||
						aria === "false" ||
						(t.tagName === "DETAILS" && !t.open);
					if (!isClosed) continue;
					if (isThinkingTrigger(t)) shouldExpand = true;
				}
			}

			if (shouldClean) scheduleClean();
			if (shouldExpand) scheduleExpand();
		});

		observer.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["data-state", "aria-expanded", "open"],
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

		console.log("[ArenaPerf] Booting DOM Virtualizer v3...");
		applySurgeryCSS();
		if (config.showToolbar) createToolbar();
		startObserver();

		setTimeout(() => cleanMessages(true), 500);
		setTimeout(() => cleanMessages(true), 2000);
		if (config.keepThinkingExpanded) {
			setTimeout(expandThinkingBlocks, 800);
			setTimeout(expandThinkingBlocks, 2500);
		}

		// Safety poll: catches anything the observer misses
		// (e.g. if messages turn out NOT to be direct children of role=log)
		setInterval(() => {
			if (isPaused || !config.autoClean) return;
			const container = getMessageContainer();
			if (!container) return;
			const count = getMessages(container).length;
			if (count !== stats.totalMsgs) cleanMessages(true);
		}, 3000);
	}

	function scheduleInit() {
		if (document.visibilityState !== "visible") {
			pendingStart = true;
			return;
		}
		if (window.requestIdleCallback) {
			const idleId = window.requestIdleCallback(initializeUI, { timeout: 1000 });
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

	// Diagnostic confirmed: no form/textarea exists. [role=log] is the ready marker.
	function isAppReady() {
		return !!document.querySelector(LOG_SELECTOR);
	}

	function waitForReady() {
		if (isAppReady()) {
			scheduleInit();
			return;
		}
		const readyObserver = new MutationObserver(() => {
			if (isAppReady()) {
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

	// Emergency init: if [role=log] never appears (empty chat / different page), still start
	setTimeout(() => {
		if (!hasStarted) {
			console.warn("[ArenaPerf] Emergency init after 5s (role=log not found)");
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