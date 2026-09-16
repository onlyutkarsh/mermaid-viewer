/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import mermaid from 'mermaid';

const MERMAID_PREVIEW_CLASS = 'mermaid-live-preview';

// Capture the script's own URL synchronously — document.currentScript is null inside async callbacks.
const _SCRIPT_BASE =
	typeof document !== 'undefined'
		? ((document.currentScript as HTMLScriptElement | null)?.src ?? '').replace(
				/\/[^/]+$/,
				'/',
			)
		: '';

// Register ELK layout loaders once. The heavy render chunk (~1.6 MB) is loaded
// lazily by mermaid only when a diagram actually requests layout: elk.
const _elkReady: Promise<void> = _SCRIPT_BASE
	? (async () => {
			try {
				// Template-literal URL keeps esbuild from bundling this import.
				const elkUrl = `${_SCRIPT_BASE}mermaid-layout-elk/dist/mermaid-layout-elk.esm.min.mjs`;
				// eslint-disable-next-line no-unsanitized/method
				const mod = (await import(elkUrl)) as {
					default: Parameters<typeof mermaid.registerLayoutLoaders>[0];
				};
				mermaid.registerLayoutLoaders(mod.default);
			} catch {
				// ELK unavailable — diagrams that request elk layout will fall back to dagre.
			}
		})()
	: Promise.resolve();

if (typeof window !== 'undefined') {
	let currentController: AbortController | undefined;

	function getStoredTheme(): 'light' | 'dark' | null {
		const theme = localStorage.getItem('mermaid-preview-theme');
		if (theme === 'light' || theme === 'dark') {
			return theme;
		}
		return null;
	}

	function setStoredTheme(theme: 'light' | 'dark'): void {
		localStorage.setItem('mermaid-preview-theme', theme);
	}

	function getEffectiveTheme(): 'light' | 'dark' {
		const stored = getStoredTheme();
		if (stored) {
			return stored;
		}
		const vscodeDark =
			document.body.classList.contains('vscode-dark') ||
			document.body.classList.contains('vscode-high-contrast');
		return vscodeDark ? 'dark' : 'light';
	}

	function isDark(): boolean {
		return getEffectiveTheme() === 'dark';
	}

	function applyThemeToAll(theme: 'light' | 'dark'): void {
		setStoredTheme(theme);
		void init();
	}

	function openFullscreenOverlay(svg: SVGElement, isDarkTheme: boolean): void {
		const overlay = document.createElement('div');
		overlay.className = 'mermaid-fullscreen-overlay';
		overlay.setAttribute('tabindex', '-1');

		const body = document.createElement('div');
		body.className = 'mermaid-fullscreen-body';

		const uid = `fs-${Date.now()}`;
		const clone = svg.cloneNode(true) as SVGElement;
		clone.querySelectorAll('[id]').forEach((el) => {
			const oldId = el.id;
			const newId = `${oldId}-${uid}`;
			el.id = newId;
			clone
				.querySelectorAll(`[href="#${oldId}"], [xlink\\:href="#${oldId}"]`)
				.forEach((ref) => {
					if (ref.hasAttribute('href')) {
						ref.setAttribute('href', `#${newId}`);
					}
					if (ref.hasAttributeNS('http://www.w3.org/1999/xlink', 'href')) {
						ref.setAttributeNS(
							'http://www.w3.org/1999/xlink',
							'xlink:href',
							`#${newId}`,
						);
					}
				});
		});
		body.appendChild(clone);

		const closeBtn = document.createElement('button');
		closeBtn.className = 'mermaid-fullscreen-close';
		closeBtn.textContent = '✕';
		closeBtn.title = 'Close (Esc)';

		overlay.appendChild(closeBtn);
		overlay.appendChild(body);

		if (isDarkTheme) {
			overlay.classList.add('dark-theme');
		}

		document.body.appendChild(overlay);
		overlay.focus();

		let zoom = 1;
		let tx = 0;
		let ty = 0;
		let dragging = false;
		let startX = 0;
		let startY = 0;

		function applyTransform(): void {
			body.style.transform = `translate(${tx}px, ${ty}px) scale(${zoom})`;
		}

		overlay.addEventListener(
			'wheel',
			(ev: WheelEvent) => {
				ev.preventDefault();
				if (ev.ctrlKey) {
					const delta = ev.deltaY > 0 ? -0.1 : 0.1;
					zoom = Math.max(0.2, Math.min(10, zoom + delta));
					applyTransform();
				} else {
					const multiplier =
						ev.deltaMode === 1
							? 16
							: ev.deltaMode === 2
								? window.innerHeight
								: 1;
					tx -= ev.deltaX * multiplier;
					ty -= ev.deltaY * multiplier;
					applyTransform();
				}
			},
			{ passive: false },
		);

		body.addEventListener('mousedown', (ev: MouseEvent) => {
			if (ev.button === 0) {
				dragging = true;
				startX = ev.clientX - tx;
				startY = ev.clientY - ty;
				ev.preventDefault();
			}
		});

		const onMouseMove = (ev: MouseEvent): void => {
			if (dragging) {
				tx = ev.clientX - startX;
				ty = ev.clientY - startY;
				applyTransform();
			}
		};

		const onMouseUp = (): void => {
			dragging = false;
		};

		window.addEventListener('mousemove', onMouseMove);
		window.addEventListener('mouseup', onMouseUp);

		function removeOverlay(): void {
			overlay.remove();
			window.removeEventListener('mousemove', onMouseMove);
			window.removeEventListener('mouseup', onMouseUp);
			document.removeEventListener('keydown', onEsc);
		}

		function onEsc(ev: KeyboardEvent): void {
			if (ev.key === 'Escape') removeOverlay();
		}

		closeBtn.addEventListener('click', removeOverlay);
		overlay.addEventListener('click', (ev: MouseEvent) => {
			if (ev.target === overlay) removeOverlay();
		});
		document.addEventListener('keydown', onEsc);
	}

	function createToolbar(): HTMLElement {
		const toolbar = document.createElement('div');
		toolbar.className = 'mermaid-toolbar-container';
		toolbar.innerHTML = `
			<button class="mermaid-theme-btn" data-theme="light" title="Light theme">☼</button>
			<button class="mermaid-theme-btn" data-theme="dark" title="Dark theme">☾</button>
			<button class="mermaid-theme-btn mermaid-fullscreen-btn" title="Fullscreen">⤢</button>
		`;

		const fullscreenBtn = toolbar.querySelector(
			'.mermaid-fullscreen-btn',
		) as HTMLButtonElement;
		fullscreenBtn.addEventListener('click', function () {
			if (document.querySelector('.mermaid-fullscreen-overlay')) return;

			const wrapper = this.closest('.mermaid-preview-wrapper');
			if (!wrapper) return;
			const svg = wrapper.querySelector('.mermaid-preview-content svg');
			if (!svg) return;

			openFullscreenOverlay(
				svg as SVGElement,
				wrapper.classList.contains('dark-theme'),
			);
		});

		const lightBtn = toolbar.querySelector(
			'[data-theme="light"]',
		) as HTMLButtonElement;
		const darkBtn = toolbar.querySelector(
			'[data-theme="dark"]',
		) as HTMLButtonElement;
		const currentTheme: 'light' | 'dark' = getEffectiveTheme();
		lightBtn.classList.toggle('active', currentTheme === 'light');
		darkBtn.classList.toggle('active', currentTheme === 'dark');
		toolbar.classList.toggle('dark-theme', currentTheme === 'dark');

		lightBtn.addEventListener('click', () => applyThemeToAll('light'));
		darkBtn.addEventListener('click', () => applyThemeToAll('dark'));

		return toolbar;
	}

	const BLOCK_DISPLAY_TAGS = new Set([
		'DIV',
		'P',
		'LI',
		'TR',
		'PRE',
		'SECTION',
		'ARTICLE',
	]);

	/**
	 * Reconstructs source text from a rendered code element, inserting a line break
	 * at each block-level child boundary (and each <br>). Some renderers — notably
	 * Copilot Chat's code block view — lay out one line per block element without a
	 * literal '\n' text node between them, so plain `.textContent` would merge every
	 * line into one, breaking Mermaid parsing.
	 */
	function extractTextPreservingLines(root: HTMLElement): string {
		const lines: string[] = [];
		let current = '';

		function flush(): void {
			lines.push(current);
			current = '';
		}

		function walk(node: Node): void {
			if (node.nodeType === Node.TEXT_NODE) {
				current += node.textContent ?? '';
				return;
			}
			if (node.nodeType !== Node.ELEMENT_NODE) {
				return;
			}
			const el = node as HTMLElement;
			if (el.tagName === 'BR') {
				flush();
				return;
			}
			const isBlock = BLOCK_DISPLAY_TAGS.has(el.tagName);
			if (isBlock && current !== '') {
				flush();
			}
			for (const child of Array.from(el.childNodes)) {
				walk(child);
			}
			if (isBlock) {
				flush();
			}
		}

		for (const child of Array.from(root.childNodes)) {
			walk(child);
		}
		flush();

		return lines.map((line) => line.replace(/\s+$/, '')).join('\n');
	}

	/**
	 * Finds all extension-owned Mermaid elements OR falls back when extendMarkdownIt hasn't run.
	 *
	 * Two fallbacks:
	 * 1. <pre><code class="language-mermaid">  — VS Code default for ```mermaid
	 * 2. :::mermaid blocks rendered as paragraphs — VS Code default for :::mermaid
	 *    a) single <p> containing ":::mermaid\ncontent\n:::" (no blank lines)
	 *    b) separate <p>:::mermaid</p> ... <p>:::</p> (blank lines in source)
	 */
	function collectMermaidElements(): HTMLElement[] {
		// Primary: our extendMarkdownIt plugin produced extension-owned elements
		const primary = Array.from(
			document.querySelectorAll<HTMLElement>(`.${MERMAID_PREVIEW_CLASS}`),
		);
		if (primary.length > 0) {
			return primary;
		}

		const result: HTMLElement[] = [];

		// Fallback 1: <pre><code class="language-mermaid"> — VS Code default for ```mermaid
		// Also used by Copilot Chat, which renders each source line as a separate
		// block-level child (no literal '\n' text nodes), so plain textContent
		// would concatenate every line together. extractTextPreservingLines()
		// walks the DOM and reinserts a line break at each block boundary.
		for (const code of Array.from(
			document.querySelectorAll<HTMLElement>('code[class*="language-mermaid"]'),
		)) {
			const pre = code.parentElement;
			if (pre?.tagName !== 'PRE') {
				continue;
			}
			const source = extractTextPreservingLines(code).trim();
			if (!source) {
				continue;
			}
			const div = document.createElement('div');
			div.className = MERMAID_PREVIEW_CLASS;
			div.textContent = source;
			div.dataset.mermaidSource = source;
			pre.replaceWith(div);
			result.push(div);
		}

		// Fallback 2: :::mermaid blocks rendered as paragraph(s).
		// Handles all shapes:
		// - single paragraph: ":::mermaid\ncontent\n:::"
		// - opener+content in first paragraph, closer later
		// - opener-only paragraph with content in following paragraphs
		const paras = Array.from(document.body.querySelectorAll<HTMLElement>('p'));
		for (let i = 0; i < paras.length; i++) {
			const p = paras[i];
			const text = p.textContent || '';

			// Case 1: full container in one paragraph:
			// ::: mermaid\n...diagram...\n:::
			const singleBlock = text.match(
				/^:::+\s*mermaid\s*\n([\s\S]*?)\n:::+\s*$/i,
			);
			if (singleBlock) {
				const source = (singleBlock[1] || '').trim();
				if (source) {
					const div = document.createElement('div');
					div.className = MERMAID_PREVIEW_CLASS;
					div.textContent = source;
					div.dataset.mermaidSource = source;
					p.replaceWith(div);
					result.push(div);
				}
				continue;
			}

			// Detect opener, allowing content to continue in same paragraph.
			// Examples matched:
			//   :::mermaid
			//   ::: mermaid
			//   :::mermaid\nsequenceDiagram\nautonumber
			const opener = text.match(/^:::+\s*mermaid\s*(?:\n([\s\S]*))?$/i);
			if (!opener) {
				continue;
			}

			const chunks: string[] = [];
			const firstChunk = (opener[1] || '').trim();
			if (firstChunk) {
				chunks.push(firstChunk);
			}

			let foundCloser = false;
			let j = i + 1;
			while (j < paras.length) {
				const next = paras[j];
				const nextTextRaw = next.textContent || '';
				const nextText = nextTextRaw.trim();

				// Closer-only paragraph
				if (/^:::+\s*$/.test(nextText)) {
					next.remove();
					foundCloser = true;
					i = j; // skip consumed range
					break;
				}

				// Paragraph that ends with closer, with content before it
				const endsWithCloser = nextTextRaw.match(/^([\s\S]*?)\n:::+\s*$/);
				if (endsWithCloser) {
					const beforeCloser = (endsWithCloser[1] || '').trim();
					if (beforeCloser) {
						chunks.push(beforeCloser);
					}
					next.remove();
					foundCloser = true;
					i = j; // skip consumed range
					break;
				}

				chunks.push(nextTextRaw.trim());
				next.remove();
				j++;
			}

			const source = chunks
				.join('\n')
				.split('\n')
				.map((line) => line.trimEnd())
				.filter((line) => !/^:::+\s*$/.test(line.trim()))
				.join('\n')
				.trim();
			if (foundCloser && source) {
				const div = document.createElement('div');
				div.className = MERMAID_PREVIEW_CLASS;
				div.textContent = source;
				div.dataset.mermaidSource = source;
				p.replaceWith(div);
				result.push(div);
			} else {
				// No valid closer found; leave as-is to avoid destroying markdown text.
			}
		}

		if (result.length > 0) {
			console.log('[ML] fallback: converted', result.length, 'element(s)');
		}
		return result;
	}

	async function init(): Promise<void> {
		currentController?.abort();
		currentController = new AbortController();
		const signal = currentController.signal;

		const els = collectMermaidElements();

		if (els.length === 0) {
			return;
		}

		await _elkReady;
		mermaid.initialize({
			startOnLoad: false,
			securityLevel: 'loose',
			theme: isDark() ? 'dark' : 'default',
		});

		const renderPromises = els.map(async (el, index) => {
			// Mark as processed early so any Mermaid auto-run path skips this node.
			el.setAttribute('data-processed', 'true');

			const isAlreadyRendered = el.querySelector('.mermaid-block') !== null;
			const sourceFromDataset = (el.dataset.mermaidSource || '').trim();
			const sourceFromText = (el.textContent || '').trim();
			const source = (
				sourceFromDataset ||
				(!isAlreadyRendered ? sourceFromText : '') ||
				''
			).trim();

			if (!source) {
				return;
			}

			if (
				source.startsWith('#mermaid-') ||
				source.includes('@keyframes') ||
				source.includes('.edge-animation-slow')
			) {
				return;
			}
			el.dataset.mermaidSource = source;

			const id = `mermaid-${Date.now()}-${index}`;
			try {
				if (signal.aborted) {
					return;
				}

				const result = await mermaid.render(id, source);
				if (signal.aborted) {
					return;
				}

				const wrapper = document.createElement('div');
				wrapper.className = 'mermaid-preview-wrapper';
				wrapper.classList.toggle('dark-theme', isDark());

				const content = document.createElement('div');
				content.className = 'mermaid-preview-content';
				content.innerHTML = result.svg;
				wrapper.appendChild(content);

				const toolbar = createToolbar();
				wrapper.appendChild(toolbar);

				const block = document.createElement('div');
				block.className = 'mermaid-block';
				block.appendChild(wrapper);

				el.innerHTML = '';
				el.appendChild(block);
				el.setAttribute('data-processed', 'true');
				result.bindFunctions?.(content);
			} catch (err) {
				console.error('[ML] render error on block', index, err);
				const message =
					err instanceof Error
						? err.message
						: typeof err === 'object' && err !== null && 'str' in err
							? String((err as { str?: unknown }).str)
							: String(err);
				const preview = source.split('\n').slice(0, 4).join('\n');
				el.innerHTML = `<pre class="mermaid-error" style="color:#c0392b;background:#fdf2f2;border:1px solid #e74c3c;padding:8px;border-radius:4px;font-size:12px;white-space:pre-wrap;">Mermaid render error:\n${message}\n\nSource preview:\n${preview}</pre>`;
			}
		});

		await Promise.all(renderPromises);
	}

	window.addEventListener('vscode.markdown.updateContent', () => {
		void init();
	});

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', () => {
			void init();
		});
	} else {
		void init();
	}
}
