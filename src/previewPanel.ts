import * as path from 'node:path';
import * as vscode from 'vscode';
import { Logger } from './util/logger';

type PreviewAppearance = 'matchVSCode' | 'light' | 'dark';
type PreviewMode = 'all' | 'single';

type MermaidBlock = {
	code: string;
	startLine: number;
	endLine: number;
};

type SerializedPanelState = {
	documentUri: string;
	mode: PreviewMode;
	singleLine?: number;
	runtimeVersion?: number;
};

type WebviewState = {
	panelState?: SerializedPanelState;
	docStates?: Record<string, unknown>;
};

export class MermaidPreviewPanel {
	public static readonly viewType = 'mermaidViewer';
	private static readonly _webviewRuntimeVersion = 2;
	private static readonly _panels = new Set<MermaidPreviewPanel>();
	private static _suppressNextAppearanceRefresh = false;
	private readonly _panel: vscode.WebviewPanel;
	private readonly _extensionUri: vscode.Uri;
	private readonly _logger: Logger;
	private readonly _blockCache = new Map<
		string,
		{ version: number; blocks: MermaidBlock[] }
	>();
	private readonly _documentUri: string;
	private _disposables: vscode.Disposable[] = [];
	private _updateTimeout: NodeJS.Timeout | undefined;
	private _firstUpdateRequestTime: number | undefined;
	private _currentDocument: vscode.TextDocument | undefined;
	private _mode: PreviewMode = 'all';
	private _singleLine: number | undefined;
	private _singleBlockIndex: number | undefined;
	private _singleBlockStartLine: number | undefined;
	private _singleBlockEndLine: number | undefined;
	private _isDisposed = false;
	private _webviewReady = false;

	public static forEachPanel(callback: (panel: MermaidPreviewPanel) => void) {
		for (const panel of MermaidPreviewPanel._panels) {
			callback(panel);
		}
	}

	public static hasOpenPanels(): boolean {
		return MermaidPreviewPanel._panels.size > 0;
	}

	public static suppressNextAppearanceRefresh(): void {
		MermaidPreviewPanel._suppressNextAppearanceRefresh = true;
	}

	public static consumeSuppressedAppearanceRefresh(): boolean {
		if (!MermaidPreviewPanel._suppressNextAppearanceRefresh) {
			return false;
		}

		MermaidPreviewPanel._suppressNextAppearanceRefresh = false;
		return true;
	}

	public static async revive(
		panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		state: WebviewState | undefined,
	): Promise<void> {
		const logger = Logger.instance;

		// Check if we have valid state
		if (!state?.panelState?.documentUri) {
			logger.logWarning('Cannot revive panel: missing state or documentUri', {
				hasState: !!state,
				hasPanelState: !!state?.panelState,
				documentUri: state?.panelState?.documentUri,
			});
			panel.dispose();
			return;
		}

		try {
			const panelState = state.panelState;

			const document = await vscode.workspace.openTextDocument(
				vscode.Uri.parse(panelState.documentUri),
			);

			logger.logInfo('Successfully revived Mermaid preview panel', {
				documentUri: panelState.documentUri,
				mode: panelState.mode,
			});

			new MermaidPreviewPanel(
				panel,
				extensionUri,
				document,
				panelState.mode,
				panelState.singleLine,
			);
		} catch (error) {
			logger.logError(
				'Failed to revive Mermaid preview panel',
				error instanceof Error ? error : new Error(String(error)),
			);
			panel.webview.html = `
				<!DOCTYPE html>
				<html lang="en">
				<head>
					<meta charset="UTF-8">
					<meta name="viewport" content="width=device-width, initial-scale=1.0">
					<title>Preview Unavailable</title>
					<style>
						body {
							padding: 20px;
							font-family: var(--vscode-font-family);
							color: var(--vscode-editor-foreground);
							background-color: var(--vscode-editor-background);
						}
					</style>
				</head>
				<body>
					<h2>Preview Unavailable</h2>
					<p>The document for this preview could not be loaded. It may have been moved or deleted.</p>
				</body>
				</html>
			`;
		}
	}

	private static _findMatchingPanel(
		document: vscode.TextDocument,
		mode: PreviewMode,
		lineNumber?: number,
	): MermaidPreviewPanel | undefined {
		for (const panel of MermaidPreviewPanel._panels) {
			if (panel._matches(document, mode, lineNumber)) {
				return panel;
			}
		}
		return undefined;
	}

	private static _deriveDocumentLabel(document: vscode.TextDocument): string {
		if (document.uri.scheme === 'untitled') {
			const parts = document.uri.path.split('/');
			return parts[parts.length - 1] || 'Untitled';
		}
		return path.basename(document.uri.fsPath);
	}

	private static _buildPanelTitle(
		document: vscode.TextDocument,
		mode: PreviewMode,
		lineNumber?: number,
	): string {
		const label = MermaidPreviewPanel._deriveDocumentLabel(document);
		const config = vscode.workspace.getConfiguration('mermaidViewer');
		const titleStyle = config.get<string>('panelTitleStyle', 'full');
		const useFileNameOnly = titleStyle === 'fileNameOnly';

		if (mode === 'single') {
			const lineSuffix =
				typeof lineNumber === 'number' ? `:${lineNumber + 1}` : '';
			return useFileNameOnly
				? `${label}${lineSuffix}`
				: `Mermaid Viewer - ${label}${lineSuffix}`;
		}
		return useFileNameOnly ? label : `Mermaid Viewer - ${label}`;
	}

	private static _createWebviewPanel(
		extensionUri: vscode.Uri,
		title: string,
		viewColumn: vscode.ViewColumn,
	): vscode.WebviewPanel {
		const panel = vscode.window.createWebviewPanel(
			MermaidPreviewPanel.viewType,
			title,
			viewColumn,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [
					extensionUri,
					vscode.Uri.joinPath(extensionUri, 'out'),
				],
			},
		);

		// Set the icon for the preview panel (theme-aware)
		panel.iconPath = {
			light: vscode.Uri.joinPath(extensionUri, 'images', 'mermaid-gutter.svg'),
			dark: vscode.Uri.joinPath(extensionUri, 'images', 'mermaid-gutter.svg'),
		};

		return panel;
	}

	public static createOrShow(
		extensionUri: vscode.Uri,
		document: vscode.TextDocument,
		viewColumn: vscode.ViewColumn,
	) {
		const existing = MermaidPreviewPanel._findMatchingPanel(document, 'all');
		if (existing) {
			existing._panel.reveal(viewColumn);
			return;
		}

		const title = MermaidPreviewPanel._buildPanelTitle(document, 'all');
		const panel = MermaidPreviewPanel._createWebviewPanel(
			extensionUri,
			title,
			viewColumn,
		);
		new MermaidPreviewPanel(panel, extensionUri, document, 'all');
	}

	public static createOrShowSingle(
		extensionUri: vscode.Uri,
		document: vscode.TextDocument,
		lineNumber: number,
		viewColumn: vscode.ViewColumn,
	) {
		const existing = MermaidPreviewPanel._findMatchingPanel(
			document,
			'single',
			lineNumber,
		);
		if (existing) {
			existing._panel.reveal(viewColumn);
			existing.handleSelectionChange(document, lineNumber);
			return;
		}

		const title = MermaidPreviewPanel._buildPanelTitle(
			document,
			'single',
			lineNumber,
		);
		const panel = MermaidPreviewPanel._createWebviewPanel(
			extensionUri,
			title,
			viewColumn,
		);

		new MermaidPreviewPanel(
			panel,
			extensionUri,
			document,
			'single',
			lineNumber,
		);
	}

	private constructor(
		panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		document: vscode.TextDocument,
		mode: PreviewMode,
		singleLine?: number,
	) {
		this._panel = panel;
		this._extensionUri = extensionUri;
		this._currentDocument = document;
		this._documentUri = document.uri.toString();
		this._logger = Logger.instance;
		this._mode = mode;
		this._singleLine = singleLine;
		MermaidPreviewPanel._panels.add(this);

		// Persist state for revival after reload
		this._updatePanelState();

		// Set the webview's initial html content
		this._render();

		// Listen for when the panel is disposed
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		// Handle messages from the webview
		this._panel.webview.onDidReceiveMessage(
			(message) => {
				switch (message.command) {
					case 'changeTheme':
						this._handleThemeChange(message.theme);
						break;
					case 'saveThemePreference':
						this._saveThemePreference(message.theme);
						break;
					case 'exportDiagram':
						this._handleExportDiagram(
							message.data,
							message.format,
							message.index,
						);
						break;
					case 'exportError':
						this._logger.logError(
							'Webview reported export error',
							message.error ?? 'Unknown error',
						);
						vscode.window.showErrorMessage(
							`Failed to export diagram: ${message.error ?? 'Unknown error'}`,
						);
						break;
					case 'copyDiagram':
						this._handleCopyDiagram(message.data, message.format);
						break;
					case 'copySuccess': {
						const requestedFormat = String(
							message.format ?? 'diagram',
						).toUpperCase();
						const actualFormat = String(
							message.actualFormat ?? message.format ?? 'diagram',
						).toUpperCase();
						const downgraded =
							typeof message.actualFormat === 'string' &&
							message.actualFormat !== message.format;
						const infoMessage = downgraded
							? `${actualFormat} copied to clipboard (requested ${requestedFormat}).`
							: `${actualFormat} copied to clipboard`;
						vscode.window.showInformationMessage(infoMessage);
						this._logger.logInfo('Diagram copied to clipboard', {
							requestedFormat: message.format ?? 'unknown',
							actualFormat: message.actualFormat ?? message.format ?? 'unknown',
							downgraded,
						});
						break;
					}
					case 'copyError':
						this._logger.logError(
							'Webview reported copy error',
							message.error ?? 'Unknown error',
						);
						vscode.window.showErrorMessage(
							`Failed to copy diagram: ${message.error ?? 'Unknown error'}`,
						);
						break;
					case 'renderError':
						this._logger.logError('Mermaid diagram render failed', {
							document: this._currentDocument?.uri.toString() ?? 'unknown',
							index: message.index,
							line: message.line ?? null,
							details: message.message ?? 'Unknown error',
						});
						break;
					case 'renderSuccess':
						this._logger.logInfo('Mermaid diagram rendered successfully', {
							document: this._currentDocument?.uri.toString() ?? 'unknown',
							index: message.index,
						});
						break;
					case 'webviewError':
						this._logger.logError('Webview runtime error', {
							document: this._currentDocument?.uri.toString() ?? 'unknown',
							message: message.message ?? 'Unknown error',
							stack: message.stack ?? 'no-stack',
						});
						break;
					case 'lifecycleEvent':
						this._logger.logDebug(
							'WebviewLifecycle',
							message.status ?? 'unknown',
							{
								documentId: message.documentId ?? 'unknown',
							},
						);
						break;
					case 'changeAppearance':
						this._handleAppearanceChange(
							message.appearance as PreviewAppearance,
						);
						break;
					case 'showKeyboardShortcuts':
						this._showKeyboardShortcuts();
						break;
					case 'webviewReady':
						this._webviewReady = true;
						break;
					case 'refreshDiagram':
						this._render();
						break;
				}
			},
			null,
			this._disposables,
		);

		// Listen for configuration changes to update panel title
		vscode.workspace.onDidChangeConfiguration(
			(e) => {
				if (e.affectsConfiguration('mermaidViewer.panelTitleStyle')) {
					this._updatePanelTitle();
				}
			},
			null,
			this._disposables,
		);
	}

	private _render(overrideTheme?: string) {
		if (this._isDisposed) {
			this._logger.logWarning('Render skipped because panel is disposed');
			return;
		}

		if (this._mode === 'single' && this._singleLine !== undefined) {
			this._renderSingle(this._singleLine, undefined, overrideTheme);
		} else {
			this._renderAll(overrideTheme);
		}
	}

	private _matches(
		document: vscode.TextDocument,
		mode: PreviewMode,
		lineNumber?: number,
	): boolean {
		if (document.uri.toString() !== this._documentUri) {
			return false;
		}

		if (mode === 'all') {
			return this._mode === 'all';
		}

		if (this._mode !== 'single') {
			return false;
		}

		if (typeof lineNumber !== 'number') {
			return true;
		}

		if (
			typeof this._singleBlockStartLine === 'number' &&
			typeof this._singleBlockEndLine === 'number'
		) {
			return (
				lineNumber >= this._singleBlockStartLine &&
				lineNumber <= this._singleBlockEndLine
			);
		}

		if (typeof this._singleLine === 'number') {
			return lineNumber === this._singleLine;
		}

		return false;
	}

	public updateContent(document: vscode.TextDocument) {
		if (this._isDisposed) {
			this._logger.logWarning(
				'updateContent ignored because panel is disposed',
			);
			return;
		}

		if (document.uri.toString() !== this._documentUri) {
			return;
		}

		this._currentDocument = document;

		// Get refresh delay from config
		const config = vscode.workspace.getConfiguration('mermaidViewer');
		const delay = config.get<number>('refreshDelay', 500);
		const maxDebounceTime = 3000; // Maximum 3 seconds

		// Track when the first update request came in
		const now = Date.now();
		if (!this._firstUpdateRequestTime) {
			this._firstUpdateRequestTime = now;
		}

		// Calculate time since first update request
		const timeSinceFirstRequest = now - this._firstUpdateRequestTime;

		// Clear existing timeout
		if (this._updateTimeout) {
			clearTimeout(this._updateTimeout);
		}

		// If we've been debouncing for too long, force an update immediately
		if (timeSinceFirstRequest >= maxDebounceTime) {
			this._firstUpdateRequestTime = undefined;
			this._pushUpdate();
			return;
		}

		// Otherwise, debounce updates normally
		this._updateTimeout = setTimeout(() => {
			this._firstUpdateRequestTime = undefined;
			this._pushUpdate();
		}, delay);
	}

	private _pushUpdate() {
		if (this._webviewReady) {
			this._sendDiagramUpdate();
		} else {
			this._render();
		}
	}

	private _sendDiagramUpdate() {
		if (this._isDisposed || !this._currentDocument) {
			return;
		}

		const blocks = this._getMermaidBlocks(this._currentDocument);
		let codes: string[];

		if (this._mode === 'single') {
			const idx = this._singleBlockIndex;
			const block = typeof idx === 'number' ? blocks[idx] : undefined;
			if (!block) {
				this._webviewReady = false;
				this._render();
				return;
			}
			codes = [block.code];
		} else {
			codes = blocks.map((b) => b.code);
		}

		void this._panel.webview.postMessage({
			command: 'updateDiagrams',
			diagrams: codes,
		});
		this._updatePanelTitle();
	}

	public handleSelectionChange(
		document: vscode.TextDocument,
		lineNumber: number,
	) {
		if (this._mode !== 'single') {
			return;
		}

		if (document.uri.toString() !== this._documentUri) {
			return;
		}

		this._currentDocument = document;

		if (typeof lineNumber !== 'number') {
			return;
		}

		const blocks = this._getMermaidBlocks(document);
		const blockIndex = this._findBlockIndexForLine(
			document,
			lineNumber,
			blocks,
		);

		if (typeof blockIndex !== 'number') {
			return;
		}

		if (typeof this._singleBlockIndex === 'number') {
			if (blockIndex !== this._singleBlockIndex) {
				return;
			}

			this._singleLine = lineNumber;
			this._updatePanelState();
			return;
		}

		this._singleLine = lineNumber;
		this._singleBlockIndex = blockIndex;
		this._updatePanelState();
		this._renderSingle(lineNumber, blocks);
	}

	private async _handleThemeChange(theme: string) {
		try {
			// Persist the selection. The webview already re-renders immediately.
			const config = vscode.workspace.getConfiguration('mermaidViewer');
			await config.update(
				'useVSCodeTheme',
				false,
				vscode.ConfigurationTarget.Global,
			);
			await config.update('theme', theme, vscode.ConfigurationTarget.Global);
		} catch (error) {
			this._logger.logError(
				'Failed to update theme configuration',
				error instanceof Error ? error : new Error(String(error)),
			);
			vscode.window.showErrorMessage(
				`Failed to update theme: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async _saveThemePreference(theme: string) {
		try {
			// Save to workspace or global settings
			const config = vscode.workspace.getConfiguration('mermaidViewer');
			await config.update('theme', theme, vscode.ConfigurationTarget.Global);
		} catch (error) {
			// Silently fail - non-critical operation, user already has visual feedback
			this._logger.logDebug('SaveThemePreference', 'Failed to persist theme', {
				theme,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async _handleAppearanceChange(appearance: PreviewAppearance) {
		try {
			const config = vscode.workspace.getConfiguration('mermaidViewer');
			MermaidPreviewPanel.suppressNextAppearanceRefresh();
			await config.update(
				'previewAppearance',
				appearance,
				vscode.ConfigurationTarget.Global,
			);
		} catch (error) {
			this._logger.logError(
				'Failed to update appearance configuration',
				error instanceof Error ? error : new Error(String(error)),
			);
			vscode.window.showErrorMessage(
				`Failed to update appearance: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private _showKeyboardShortcuts() {
		const message = 'Keyboard Shortcuts';
		const detail = [
			'Zoom:',
			'  +  or  =     Zoom in',
			'  -            Zoom out',
			'  0            Reset view',
			'',
			'Pan:',
			'  ↑ ↓ ← →      Arrow keys to pan around',
			'',
			'Annotation:',
			'  p            Pen tool',
			'  s            Shape tool (cycles arrow → line → rect → ellipse)',
			'  l            Laser pointer (fades automatically)',
			'  e            Erase all annotations',
			'  r / g / b    Set color red / green / blue (pen & shape only)',
			'  Esc          Exit annotation mode',
			'',
		].join('\n');

		vscode.window.showInformationMessage(message, { modal: true, detail });
		this._logger.logInfo('Displayed keyboard shortcuts help');
	}

	private async _handleExportDiagram(
		data: string,
		format: string,
		index: number,
	) {
		// Show save dialog
		const filters: { [name: string]: string[] } = {};
		if (format === 'svg') {
			filters['SVG Image'] = ['svg'];
		} else if (format === 'png') {
			filters['PNG Image'] = ['png'];
		} else if (format === 'jpg') {
			filters['JPEG Image'] = ['jpg', 'jpeg'];
		}

		const uri = await vscode.window.showSaveDialog({
			defaultUri: vscode.Uri.file(`mermaid-diagram-${index + 1}.${format}`),
			filters: filters,
		});

		if (!uri) {
			return; // User cancelled
		}

		// Write the file
		try {
			const buffer = Buffer.from(data, 'base64');
			await vscode.workspace.fs.writeFile(uri, buffer);
			vscode.window.showInformationMessage(`Diagram exported to ${uri.fsPath}`);
			this._logger.logInfo('Diagram exported successfully', {
				path: uri.fsPath,
			});
		} catch (error) {
			this._logger.logError(
				'Failed to export diagram',
				error instanceof Error ? error : new Error(String(error)),
			);
			vscode.window.showErrorMessage(`Failed to export diagram: ${error}`);
		}
	}

	private async _handleCopyDiagram(data: string, format: string) {
		try {
			// Only SVG uses this path - PNG/JPG are copied directly in webview
			if (format === 'svg') {
				await vscode.env.clipboard.writeText(data);
				void this._panel.webview.postMessage({ command: 'copyCompleted' });
				vscode.window.showInformationMessage('SVG copied to clipboard');
				this._logger.logInfo('Diagram copied to clipboard', { format });
			}
		} catch (error) {
			this._logger.logError(
				'Failed to copy diagram',
				error instanceof Error ? error : new Error(String(error)),
			);
			vscode.window.showErrorMessage(`Failed to copy diagram: ${error}`);
		}
	}

	private _renderAll(overrideTheme?: string) {
		const webview = this._panel.webview;
		this._webviewReady = false;

		if (!this._currentDocument) {
			webview.html = this._getErrorHtml('No document to preview');
			return;
		}

		const mermaidCode = this._extractMermaidCode(this._currentDocument);

		if (!mermaidCode) {
			webview.html = this._getErrorHtml(
				'No Mermaid diagram found. Wrap your diagram in ```mermaid code blocks or :::mermaid containers.',
			);
			return;
		}

		const { theme, appearance } = this._resolveTheme(overrideTheme);
		webview.html = this._getHtmlForWebview(
			webview,
			mermaidCode,
			theme,
			appearance,
			this._currentDocument?.uri.toString(),
		);
		this._updatePanelTitle();
	}

	private _renderSingle(
		lineNumber?: number,
		precomputedBlocks?: MermaidBlock[],
		overrideTheme?: string,
	) {
		const webview = this._panel.webview;
		this._webviewReady = false;

		if (!this._currentDocument) {
			webview.html = this._getErrorHtml('No document to preview');
			return;
		}

		const blocks =
			precomputedBlocks ?? this._getMermaidBlocks(this._currentDocument);
		let targetIndex = this._singleBlockIndex;

		if (typeof targetIndex !== 'number' && typeof lineNumber === 'number') {
			targetIndex = this._findBlockIndexForLine(
				this._currentDocument,
				lineNumber,
				blocks,
			);
			this._singleBlockIndex = targetIndex;
		}

		const targetBlock =
			typeof targetIndex === 'number' ? blocks[targetIndex] : undefined;

		if (!targetBlock) {
			this._singleBlockStartLine = undefined;
			this._singleBlockEndLine = undefined;
			this._updatePanelTitle();
			webview.html = this._getErrorHtml(
				'No Mermaid diagram found at this position.',
			);
			return;
		}

		if (typeof lineNumber === 'number') {
			this._singleLine = lineNumber;
		} else if (typeof this._singleLine !== 'number') {
			this._singleLine = targetBlock.startLine;
		}

		this._singleBlockStartLine = targetBlock.startLine;
		this._singleBlockEndLine = targetBlock.endLine;

		const mermaidCode = JSON.stringify([targetBlock.code]);
		const { theme, appearance } = this._resolveTheme(overrideTheme);
		webview.html = this._getHtmlForWebview(
			webview,
			mermaidCode,
			theme,
			appearance,
			this._currentDocument?.uri.toString(),
		);
		this._updatePanelTitle();
	}

	private _extractMermaidCode(document: vscode.TextDocument): string | null {
		try {
			const text = document.getText();
			const blocks = this._getMermaidBlocks(document, text);

			if (blocks.length === 0) {
				return null;
			}

			const diagrams = blocks.map((block) => block.code);

			if (!diagrams.length) {
				return null;
			}

			return JSON.stringify(diagrams);
		} catch (error) {
			// Only log unexpected errors (JSON.stringify should never fail with our data)
			this._logger.logError(
				'Unexpected error extracting Mermaid code',
				error instanceof Error ? error : new Error(String(error)),
			);
			return null;
		}
	}

	private _findBlockIndexForLine(
		document: vscode.TextDocument,
		lineNumber: number,
		precomputedBlocks?: MermaidBlock[],
	): number | undefined {
		const blocks = precomputedBlocks ?? this._getMermaidBlocks(document);
		const idx = blocks.findIndex(
			(block) => lineNumber >= block.startLine && lineNumber <= block.endLine,
		);
		return idx >= 0 ? idx : undefined;
	}

	private _getMermaidBlocks(
		document: vscode.TextDocument,
		cachedText?: string,
	): MermaidBlock[] {
		const cacheKey = document.uri.toString();
		const cached = this._blockCache.get(cacheKey);

		if (cached && cached.version === document.version) {
			return cached.blocks;
		}

		const text = cachedText ?? document.getText();
		const blocks = this._collectMermaidBlocks(document, text);
		this._blockCache.set(cacheKey, { version: document.version, blocks });
		return blocks;
	}

	private _updatePanelTitle() {
		if (!this._currentDocument) {
			return;
		}

		const lineHint =
			this._mode === 'single'
				? (this._singleBlockStartLine ?? this._singleLine)
				: undefined;
		this._panel.title = MermaidPreviewPanel._buildPanelTitle(
			this._currentDocument,
			this._mode,
			typeof lineHint === 'number' ? lineHint : undefined,
		);
	}

	private _updatePanelState() {
		const state: SerializedPanelState = {
			documentUri: this._documentUri,
			mode: this._mode,
			singleLine: this._singleLine,
			runtimeVersion: MermaidPreviewPanel._webviewRuntimeVersion,
		};
		// Update webview state for serialization
		this._panel.webview.postMessage({
			command: 'updateState',
			state,
		});
	}

	public getSerializedState(): SerializedPanelState {
		return {
			documentUri: this._documentUri,
			mode: this._mode,
			singleLine: this._singleLine,
			runtimeVersion: MermaidPreviewPanel._webviewRuntimeVersion,
		};
	}

	private _collectMermaidBlocks(
		document: vscode.TextDocument,
		text: string,
	): MermaidBlock[] {
		try {
			const blocks: MermaidBlock[] = [];

			// For standalone .mmd or .mermaid files, treat entire content as one diagram
			if (document.languageId === 'mermaid') {
				const trimmedCode = text.trim();
				if (trimmedCode) {
					blocks.push({
						code: trimmedCode,
						startLine: 0,
						endLine: document.lineCount - 1,
					});
				}
				return blocks;
			}

			// For markdown files, extract mermaid code blocks (backtick fenced syntax)
			const mermaidRegex =
				/```mermaid[^\S\r\n]*(?:\r?\n)([\s\S]*?)(?:\r?\n)?```/g;
			let match: RegExpExecArray | null = mermaidRegex.exec(text);

			while (match !== null) {
				const diagramCode = match[1]?.trim();
				if (diagramCode) {
					const startPos = document.positionAt(match.index);
					const endPos = document.positionAt(match.index + match[0].length);
					blocks.push({
						code: diagramCode,
						startLine: startPos.line,
						endLine: endPos.line,
					});
				}
				match = mermaidRegex.exec(text);
			}

			// Also support ADO wiki :::mermaid and ::: mermaid syntax
			const adoMermaidRegex =
				/^:::\s*mermaid[^\S\r\n]*(?:\r?\n)([\s\S]*?)(?:\r?\n)?^:::/gm;
			let adoMatch: RegExpExecArray | null = adoMermaidRegex.exec(text);

			while (adoMatch !== null) {
				const diagramCode = adoMatch[1]?.trim();
				if (diagramCode) {
					const startPos = document.positionAt(adoMatch.index);
					const endPos = document.positionAt(
						adoMatch.index + adoMatch[0].length,
					);
					blocks.push({
						code: diagramCode,
						startLine: startPos.line,
						endLine: endPos.line,
					});
				}
				adoMatch = adoMermaidRegex.exec(text);
			}

			// Sort blocks by their position in the document
			blocks.sort((a, b) => a.startLine - b.startLine);

			return blocks;
		} catch (error) {
			// Log because regex parsing failure is unexpected
			this._logger.logError(
				'Unexpected error collecting Mermaid blocks',
				error instanceof Error ? error : new Error(String(error)),
			);
			return [];
		}
	}

	private _resolveTheme(overrideTheme?: string): {
		theme: string;
		appearance: PreviewAppearance;
	} {
		const config = vscode.workspace.getConfiguration('mermaidViewer');
		const useVSCodeTheme = config.get<boolean>('useVSCodeTheme', false);
		const configuredTheme = config.get<string>('theme', 'default');
		const appearance = config.get<PreviewAppearance>(
			'previewAppearance',
			'matchVSCode',
		);

		let theme = overrideTheme || configuredTheme;

		if (useVSCodeTheme && !overrideTheme) {
			if (appearance === 'light') {
				theme = 'default';
			} else if (appearance === 'dark') {
				theme = 'dark';
			} else {
				const colorTheme = vscode.window.activeColorTheme;
				theme =
					colorTheme.kind === vscode.ColorThemeKind.Dark ? 'dark' : 'default';
			}
		}

		return { theme, appearance };
	}

	private _generateNonce(): string {
		const chars =
			'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		let result = '';
		for (let i = 0; i < 32; i++) {
			result += chars.charAt(Math.floor(Math.random() * chars.length));
		}
		return result;
	}

	private _getAppearanceClass(appearance: PreviewAppearance): string {
		switch (appearance) {
			case 'light':
				return 'appearance-light';
			case 'dark':
				return 'appearance-dark';
			default:
				return 'appearance-match';
		}
	}

	private _getHtmlForWebview(
		webview: vscode.Webview,
		mermaidCode: string,
		theme: string,
		appearance: PreviewAppearance,
		documentId?: string,
	): string {
		try {
			const diagrams: string[] = JSON.parse(mermaidCode);
			const appearanceClass = this._getAppearanceClass(appearance);
			const mermaidScriptUri = webview.asWebviewUri(
				vscode.Uri.joinPath(
					this._extensionUri,
					'out',
					'mermaid',
					'dist',
					'mermaid.esm.min.mjs',
				),
			);
			const codiconStylesUri = webview.asWebviewUri(
				vscode.Uri.joinPath(
					this._extensionUri,
					'out',
					'codicons',
					'codicon.css',
				),
			);
			const elkLayoutUri = webview.asWebviewUri(
				vscode.Uri.joinPath(
					this._extensionUri,
					'out',
					'mermaid-layout-elk',
					'dist',
					'mermaid-layout-elk.esm.min.mjs',
				),
			);

			const docId = documentId ?? 'unknown';
			const nonce = this._generateNonce();
			const config = vscode.workspace.getConfiguration('mermaidViewer');
			const renderTimeout = config.get<number>('renderTimeout', 0);

			return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Mermaid Diagram Lens</title>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; connect-src ${webview.cspSource} https:;">
    <link rel="stylesheet" href="${codiconStylesUri}">
    <script type="module" nonce="${nonce}">
        import mermaid from '${mermaidScriptUri}';
        import elkLayouts from '${elkLayoutUri}';
        mermaid.registerLayoutLoaders(elkLayouts);

        const vscode = acquireVsCodeApi();
        const documentId = ${JSON.stringify(docId)};
        const persistedState = vscode.getState?.() ?? {};
        const WEBVIEW_RUNTIME_VERSION = ${MermaidPreviewPanel._webviewRuntimeVersion};
        let docStates = persistedState.docStates ?? {};
        const persistedRuntimeVersion = typeof persistedState.panelState?.runtimeVersion === 'number'
            ? persistedState.panelState.runtimeVersion
            : 0;
        const needsRuntimeReset = persistedRuntimeVersion !== WEBVIEW_RUNTIME_VERSION;
        const savedState = needsRuntimeReset ? {} : (docStates[documentId] ?? {});

        // Initialize panel state for restoration after reload
        let panelState = needsRuntimeReset || !persistedState.panelState ? {
            documentUri: ${JSON.stringify(this._documentUri)},
            mode: ${JSON.stringify(this._mode)},
            singleLine: ${this._singleLine ?? 'undefined'},
            runtimeVersion: WEBVIEW_RUNTIME_VERSION
        } : persistedState.panelState;

        if (needsRuntimeReset) {
            docStates = {};
            vscode.setState({ docStates, panelState });
        }

        const diagrams = ${JSON.stringify(diagrams)};
        const renderTimeout = ${renderTimeout};
        let currentZoom = typeof savedState.currentZoom === 'number' ? savedState.currentZoom : 1.0;
        let panX = typeof savedState.panX === 'number' ? savedState.panX : 0;
        let panY = typeof savedState.panY === 'number' ? savedState.panY : 0;
        let isPanning = false;
        let lastPanX = 0;
        let lastPanY = 0;
        let panInitialized = false;
        let activeDiagramIndex = 0;
        let currentTheme = '${theme}';
        let currentAppearance = '${appearance}';
        let stageEl = null;
        let viewportEl = null;
        let panCaptureTarget = null;
        let activePointerId = null;
        let pendingTransform = null;
        let pendingZoomUpdate = null;
        let lastParseError = null;
        let annotationMode = 'none'; // hoisted here; full annotation state is declared below
        const THEME_LABELS = {
            default: 'Default',
            dark: 'Dark',
            forest: 'Forest',
            neutral: 'Neutral',
            base: 'Base'
        };
        const APPEARANCE_LABELS = {
            matchVSCode: 'Match VS Code',
            light: 'Light',
            dark: 'Dark'
        };

        function escapeHtml(value) {
            if (value === undefined || value === null) {
                return '';
            }
            return String(value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }

        function formatDiagramError(rawMessage) {
            const message = rawMessage || 'Unknown Mermaid error.';
            const lineMatch = /line\\s+(\\d+)/i.exec(message);
            const lineNumber = lineMatch ? Number(lineMatch[1]) : undefined;
            return { message, lineNumber };
        }

        function renderErrorCardHtml(info) {
            return (
                '<div class="diagram-error">' +
                    '<div class="diagram-error__title">Unable to render this diagram</div>' +
                    '<div class="diagram-error__message">' + escapeHtml(info.message) + '</div>' +
                '</div>'
            );
        }

        function reportRenderError(index, info) {
            vscode.postMessage({
                command: 'renderError',
                index,
                line: info.lineNumber ?? null,
                message: info.message
            });
        }

        function reportRenderSuccess(index) {
            vscode.postMessage({
                command: 'renderSuccess',
                index
            });
        }

        function showRenderError(index, error) {
            const container = document.getElementById('diagram-' + index);
            if (!container) {
                return;
            }

            const info = formatDiagramError(error?.message ?? String(error ?? 'Unknown error'));
            container.classList.remove('loading');
            container.innerHTML = renderErrorCardHtml(info);
            reportRenderError(index, info);
        }

        function withTimeout(promise, timeoutMs, errorMessage) {
            return Promise.race([
                promise,
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
                )
            ]);
        }

        mermaid.initialize({
            startOnLoad: false,
            theme: currentTheme,
            securityLevel: 'loose',
            suppressErrorRendering: true,
            flowchart: { useMaxWidth: true, htmlLabels: true }
        });

        mermaid.parseError = (err) => {
            if (err instanceof Error) {
                lastParseError = err;
                return;
            }
            if (typeof err === 'string') {
                lastParseError = new Error(err);
                return;
            }
            try {
                lastParseError = new Error(JSON.stringify(err));
            } catch {
                lastParseError = new Error('Unknown Mermaid parse error');
            }
        };

        function saveInteractionState() {
            docStates = { ...docStates, [documentId]: { currentZoom, panX, panY } };
            vscode.setState({ docStates, panelState });
        }

        function initializePanAndZoom() {
            if (panInitialized) {
                return;
            }
            panInitialized = true;
            const viewport = document.getElementById('diagram-viewport');
            viewportEl = viewport;
            viewport.addEventListener('pointerdown', startPan);
            viewport.addEventListener('pointermove', panMove);
            viewport.addEventListener('pointerup', endPan);
            viewport.addEventListener('pointerleave', endPan);
            viewport.addEventListener('pointercancel', endPan);
            viewport.addEventListener('wheel', handleWheel, { passive: false });
        }

        async function updateDiagramsInPlace(newDiagrams) {
            if (newDiagrams.length !== diagrams.length) {
                // Diagram count changed, clear annotations
                if (annotationCanvas) {
                    eraseAllAnnotations();
                }
                diagrams.length = 0;
                diagrams.push(...newDiagrams);
                await renderAllDiagrams();
                return;
            }

            const changed = [];
            for (let i = 0; i < newDiagrams.length; i++) {
                if (newDiagrams[i] !== diagrams[i]) {
                    changed.push(i);
                    diagrams[i] = newDiagrams[i];
                }
            }

            // Only clear annotations if diagrams actually changed
            if (changed.length > 0 && annotationCanvas) {
                eraseAllAnnotations();
            }

            for (const i of changed) {
                lastParseError = null;
                try {
                    let svg;
                    if (renderTimeout > 0) {
                        const result = await withTimeout(
                            mermaid.render('mermaid-' + i + '-' + Date.now(), diagrams[i]),
                            renderTimeout,
                            'Diagram rendering timed out after ' + renderTimeout + 'ms. The diagram may be too complex.'
                        );
                        svg = result.svg;
                    } else {
                        const result = await mermaid.render('mermaid-' + i + '-' + Date.now(), diagrams[i]);
                        svg = result.svg;
                    }
                    if (lastParseError) {
                        showRenderError(i, lastParseError);
                        lastParseError = null;
                        continue;
                    }
                    const diagramEl = document.getElementById('diagram-' + i);
                    if (diagramEl) {
                        diagramEl.classList.remove('loading');
                        diagramEl.innerHTML = svg;
                        reportRenderSuccess(i);
                    }
                } catch (error) {
                    showRenderError(i, error);
                    lastParseError = null;
                }
            }
        }

        async function renderAllDiagrams() {
            const container = document.getElementById('diagrams-container');
            container.innerHTML = '';

            // Check if we have diagrams to render
            if (!diagrams || diagrams.length === 0) {
                container.innerHTML = '<div class="diagram-error">' +
                    '<div class="diagram-error__title">No Mermaid diagrams found</div>' +
                    '<div class="diagram-error__message">No Mermaid diagrams were found in this document. ' +
                    'Make sure your diagrams are wrapped in <code>\`\`\`mermaid</code> code blocks.</div>' +
                    '</div>';
                vscode.postMessage({
                    command: 'renderError',
                    index: 0,
                    message: 'No diagrams found in document'
                });
                return;
            }

            // Clear annotations when doing a full re-render
            if (annotationCanvas) {
                eraseAllAnnotations();
            }

            // Create all shells upfront so loading spinners appear immediately
            for (let i = 0; i < diagrams.length; i++) {
                const shell = document.createElement('div');
                shell.className = 'diagram-shell';
                shell.dataset.index = i.toString();
                shell.innerHTML = '<div class="diagram-content loading" id="diagram-' + i + '">' +
                    '<div class="loading-spinner"></div>' +
                    '<div class="loading-text">Rendering diagram...</div>' +
                    '</div>';
                container.appendChild(shell);
                shell.addEventListener('click', () => focusDiagram(i));
            }

            // Render diagrams sequentially (mermaid uses shared state)
            for (let i = 0; i < diagrams.length; i++) {
                lastParseError = null;

                let renderTimeoutId;
                if (renderTimeout > 0) {
                    renderTimeoutId = setTimeout(() => {
                        const diagramEl = document.getElementById('diagram-' + i);
                        if (diagramEl && diagramEl.classList.contains('loading')) {
                            showRenderError(i, new Error('Diagram rendering timed out after ' + renderTimeout + 'ms. The diagram may be too complex or contain syntax errors.'));
                        }
                    }, renderTimeout);
                }

                try {
                    let svg;
                    if (renderTimeout > 0) {
                        const result = await withTimeout(
                            mermaid.render('mermaid-' + i + '-' + Date.now(), diagrams[i]),
                            renderTimeout,
                            'Diagram rendering timed out after ' + renderTimeout + 'ms. The diagram may be too complex.'
                        );
                        svg = result.svg;
                    } else {
                        const result = await mermaid.render('mermaid-' + i + '-' + Date.now(), diagrams[i]);
                        svg = result.svg;
                    }
                    if (renderTimeoutId) clearTimeout(renderTimeoutId);

                    if (lastParseError) {
                        showRenderError(i, lastParseError);
                        lastParseError = null;
                        continue;
                    }
                    const diagramEl = document.getElementById('diagram-' + i);
                    if (diagramEl) {
                        diagramEl.classList.remove('loading');
                        diagramEl.innerHTML = svg;
                        reportRenderSuccess(i);
                    }
                } catch (error) {
                    if (renderTimeoutId) clearTimeout(renderTimeoutId);
                    showRenderError(i, error);
                    lastParseError = null;
                }
            }

            scheduleTransform();
            setActiveDiagram(activeDiagramIndex);
            updateDiagramIndicator();
            initializePanAndZoom();
        }

        function scheduleTransform() {
            if (pendingTransform) {
                return;
            }
            pendingTransform = requestAnimationFrame(applyTransform);
        }

        function scheduleZoomUpdate() {
            if (pendingZoomUpdate) {
                return;
            }
            pendingZoomUpdate = requestAnimationFrame(applyZoomScale);
        }

        function applyTransform() {
            pendingTransform = null;
            if (!stageEl) {
                return;
            }
            const roundedPanX = Math.round(panX);
            const roundedPanY = Math.round(panY);
            stageEl.style.transform = 'translate(' + roundedPanX + 'px, ' + roundedPanY + 'px)';
            annotationTransformRevision++;
            scheduleAnnotationRedraw();
        }

        function applyZoomScale() {
            pendingZoomUpdate = null;
            document.querySelectorAll('.diagram-content').forEach(el => {
                el.style.transform = 'scale(' + currentZoom + ')';
            });
            document.getElementById('zoom-level').textContent = Math.round(currentZoom * 100) + '%';
            annotationTransformRevision++;
            scheduleAnnotationRedraw();
        }

        window.zoomIn = function() {
            currentZoom = Math.min(currentZoom + 0.1, 5.0);
            scheduleZoomUpdate();
            saveInteractionState();
        };

        window.zoomOut = function() {
            currentZoom = Math.max(currentZoom - 0.1, 0.5);
            scheduleZoomUpdate();
            saveInteractionState();
        };

        window.zoomReset = function() {
            currentZoom = 1.0;
            panX = 0;
            panY = 0;
            scheduleTransform();
            scheduleZoomUpdate();
            saveInteractionState();
        };

        function startPan(event) {
            if (annotationMode !== 'none') {
                return;
            }
            if (event.ctrlKey || event.metaKey) {
                return;
            }
            if (event.target.closest('.dropdown') || event.target.closest('.toolbar') || event.target.closest('.diagram-error')) {
                return;
            }

            if (event.button !== undefined && event.button !== 0 && event.pointerType !== 'touch' && event.pointerType !== 'pen') {
                return;
            }

            // Ensure the viewport has DOM focus so keyboard shortcuts work
            if (viewportEl) viewportEl.focus({ preventScroll: true });

            isPanning = true;
            lastPanX = event.clientX;
            lastPanY = event.clientY;
            activePointerId = event.pointerId;
            panCaptureTarget = viewportEl || event.target;
            if (panCaptureTarget?.setPointerCapture) {
                try {
                    panCaptureTarget.setPointerCapture(activePointerId);
                } catch {
                    panCaptureTarget = null;
                }
            }
            document.body.classList.add('is-panning');
            event.preventDefault();
        }

        function panMove(event) {
            if (!isPanning) {
                return;
            }
            event.preventDefault();
            const dx = event.clientX - lastPanX;
            const dy = event.clientY - lastPanY;
            lastPanX = event.clientX;
            lastPanY = event.clientY;
            panX += dx;
            panY += dy;
            scheduleTransform();
        }

        function endPan(event) {
            if (!isPanning) {
                return;
            }
            isPanning = false;
            if (panCaptureTarget && typeof panCaptureTarget.releasePointerCapture === 'function' && activePointerId !== null) {
                try {
                    panCaptureTarget.releasePointerCapture(activePointerId);
                } catch {
                    // ignore
                }
            }
            panCaptureTarget = null;
            activePointerId = null;
            document.body.classList.remove('is-panning');
            saveInteractionState();
        }

        function handleWheel(event) {
            if (!event.ctrlKey) {
                return;
            }
            event.preventDefault();
            if (event.deltaY < 0) {
                zoomIn();
            } else {
                zoomOut();
            }
        }

        function updateDiagramIndicator() {
            const indicator = document.getElementById('diagram-indicator');
            const controls = document.getElementById('diagram-controls');
            if (!indicator || !controls) {
                return;
            }
            const hasMultiple = diagrams.length > 1;
            indicator.textContent = hasMultiple
                ? 'Diagram ' + (activeDiagramIndex + 1) + ' of ' + diagrams.length
                : '';
            controls.style.display = hasMultiple ? 'flex' : 'none';
        }

        function setActiveDiagram(index) {
            if (!diagrams.length) {
                return;
            }
            activeDiagramIndex = Math.max(0, Math.min(diagrams.length - 1, index));
            document.querySelectorAll('.diagram-shell').forEach((shell, idx) => {
                shell.classList.toggle('active', idx === activeDiagramIndex);
            });
            updateDiagramIndicator();
        }

        function focusDiagram(index) {
            setActiveDiagram(index);
            const target = document.getElementById('diagram-' + index);
            if (target) {
                target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }

        window.navigateDiagram = function(delta) {
            if (!diagrams.length) {
                return;
            }
            const next = (activeDiagramIndex + delta + diagrams.length) % diagrams.length;
            focusDiagram(next);
        };

        function getAppearanceClass(appearance) {
            if (appearance === 'light') {
                return 'appearance-light';
            }
            if (appearance === 'dark') {
                return 'appearance-dark';
            }
            return 'appearance-match';
        }

        function setBodyAppearance(appearance) {
            const classList = document.body.classList;
            classList.remove('appearance-light', 'appearance-dark', 'appearance-match');
            classList.add(getAppearanceClass(appearance));
            currentAppearance = appearance;
            updateDropdownSelection('dropdown-appearance', appearance);
            updateAppearanceButtonLabel(appearance);
        }

        function updateDropdownSelection(menuId, value) {
            document.querySelectorAll('#' + menuId + ' button').forEach(btn => {
                btn.classList.toggle('selected', btn.dataset.value === value);
            });
        }

        function updateThemeButtonLabel(theme) {
            const button = document.getElementById('theme-button');
            if (button) {
                const label = THEME_LABELS[theme] || 'Custom';
                button.innerHTML = 'Theme: ' + label + ' <span class="codicon codicon-triangle-down dropdown-arrow" aria-hidden="true"></span>';
            }
        }

        function updateAppearanceButtonLabel(appearance) {
            const button = document.getElementById('appearance-button');
            if (button) {
                const label = APPEARANCE_LABELS[appearance] || 'Custom';
                button.innerHTML = 'Appearance: ' + label + ' <span class="codicon codicon-triangle-down dropdown-arrow" aria-hidden="true"></span>';
            }
        }

        function closeAllDropdowns(exceptId) {
            document.querySelectorAll('.dropdown-menu').forEach(menu => {
                if (menu.id === exceptId) {
                    return;
                }
                menu.classList.remove('show');
            });
        }

        window.toggleDropdown = function(name) {
            const menu = document.getElementById('dropdown-' + name);
            const isOpen = menu.classList.contains('show');
            closeAllDropdowns(isOpen ? undefined : menu.id);
            if (!isOpen) {
                menu.classList.add('show');
                // Update menu dimensions when opening
                if (name === 'copy' || name === 'export') {
                    updateMenuDimensions(name);
                }
            }
        };

        function updateMenuDimensions(menuType) {
            const diagramEl = document.getElementById('diagram-' + activeDiagramIndex);
            const svgEl = diagramEl?.querySelector('svg');
            if (!svgEl) return;

            const { width, height } = getSvgDimensions(svgEl);
            const w = Math.round(width);
            const h = Math.round(height);

            const selector = menuType === 'copy'
                ? '[data-copy-format][data-copy-scale]'
                : '[data-export-format][data-export-scale]';
            const formatAttr = menuType === 'copy' ? 'copyFormat' : 'exportFormat';
            const scaleAttr = menuType === 'copy' ? 'copyScale' : 'exportScale';

            document.querySelectorAll(selector).forEach(btn => {
                const format = btn.dataset[formatAttr];
                const scale = parseInt(btn.dataset[scaleAttr], 10) || 1;
                if (format === 'svg') {
                    btn.textContent = 'SVG';
                } else {
                    const scaledW = w * scale;
                    const scaledH = h * scale;
                    btn.textContent = format.toUpperCase() + ' (' + scaledW + '×' + scaledH + ')';
                }
            });
        }

        document.addEventListener('click', (event) => {
            if (!event.target.closest('.dropdown')) {
                closeAllDropdowns();
            }
        });

        window.handleThemeChange = function(newTheme) {
            currentTheme = newTheme;
            updateDropdownSelection('dropdown-theme', newTheme);
            updateThemeButtonLabel(newTheme);
            mermaid.initialize({
                startOnLoad: false,
                theme: newTheme,
                securityLevel: 'loose',
                suppressErrorRendering: true,
                flowchart: { useMaxWidth: true, htmlLabels: true }
            });
            renderAllDiagrams();
            vscode.postMessage({
                command: 'changeTheme',
                theme: newTheme
            });
        };

        window.handleAppearanceChange = function(newAppearance) {
            setBodyAppearance(newAppearance);
            vscode.postMessage({
                command: 'changeAppearance',
                appearance: newAppearance
            });
        };

        function getSvgDimensions(svgEl) {
            const viewBox = svgEl.viewBox && svgEl.viewBox.baseVal;
            if (viewBox && viewBox.width && viewBox.height) {
                return { width: viewBox.width, height: viewBox.height };
            }

            const widthAttr = parseFloat(svgEl.getAttribute('width') || '');
            const heightAttr = parseFloat(svgEl.getAttribute('height') || '');
            if (!isNaN(widthAttr) && !isNaN(heightAttr)) {
                return { width: widthAttr, height: heightAttr };
            }

            try {
                const bbox = svgEl.getBBox();
                if (bbox.width && bbox.height) {
                    return { width: bbox.width, height: bbox.height };
                }
            } catch (err) {
                console.warn('getBBox failed, falling back to client dimensions', err);
            }

            return {
                width: svgEl.clientWidth || 800,
                height: svgEl.clientHeight || 600
            };
        }

        function loadImage(url) {
            return new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = reject;
                img.src = url;
            });
        }

        function canvasToBase64(canvas, mimeType) {
            return new Promise((resolve, reject) => {
                if (canvas.toBlob) {
                    canvas.toBlob(blob => {
                        if (!blob) {
                            reject(new Error('Failed to create image blob'));
                            return;
                        }

                        const reader = new FileReader();
                        reader.onloadend = () => {
                            if (typeof reader.result === 'string') {
                                resolve(reader.result.split(',')[1]);
                            } else {
                                reject(new Error('Unexpected reader result type'));
                            }
                        };
                        reader.onerror = reject;
                        reader.readAsDataURL(blob);
                    }, mimeType, 0.95);
                    return;
                }

                try {
                    const dataUrl = canvas.toDataURL(mimeType, 0.95);
                    resolve(dataUrl.split(',')[1]);
                } catch (error) {
                    reject(error);
                }
            });
        }

        async function canvasToBlobWithFormat(canvas, mimeType) {
            if (canvas.toBlob) {
                return await new Promise((resolve, reject) => {
                    canvas.toBlob(blob => {
                        if (blob) {
                            resolve(blob);
                        } else {
                            reject(new Error('Failed to create image blob'));
                        }
                    }, mimeType, mimeType === 'image/jpeg' ? 0.95 : undefined);
                });
            }

            const dataUrl = canvas.toDataURL(mimeType, mimeType === 'image/jpeg' ? 0.95 : undefined);
            const parts = dataUrl.split(',');
            const binary = atob(parts[1]);
            const array = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                array[i] = binary.charCodeAt(i);
            }
            return new Blob([array], { type: mimeType });
        }

        function isClipboardMimeSupported(mimeType) {
            if (typeof ClipboardItem === 'undefined' || typeof ClipboardItem.supports !== 'function') {
                // Chromium historically only supported PNG - treat JPEG as unsupported unless API says otherwise
                return mimeType !== 'image/jpeg';
            }

            try {
                return ClipboardItem.supports(mimeType);
            } catch {
                return mimeType !== 'image/jpeg';
            }
        }

        function isPermissionDeniedError(error) {
            if (!error) {
                return false;
            }

            const name = error.name ?? '';
            const message = error.message ?? '';
            return name === 'NotAllowedError' ||
                name === 'SecurityError' ||
                /denied/i.test(message);
        }

        function isDocumentFocusError(error) {
            if (!error) {
                return false;
            }

            const message = typeof error === 'string'
                ? error
                : (error.message ?? '');
            return /document is not focused/i.test(message) || /focus/i.test(message ?? '');
        }

        async function rasterizeSvg(svgEl, format) {
            const { width, height } = getSvgDimensions(svgEl);
            const clonedSvg = svgEl.cloneNode(true);
            clonedSvg.setAttribute('width', String(width));
            clonedSvg.setAttribute('height', String(height));

            const svgData = new XMLSerializer().serializeToString(clonedSvg);
            const encodedSvg = encodeURIComponent(svgData);
            const imgSrc = 'data:image/svg+xml;charset=utf-8,' + encodedSvg;

            const img = await loadImage(imgSrc);
            const canvas = document.createElement('canvas');
            const scale = Math.min(Math.max(window.devicePixelRatio || 1, 1), 4);
            canvas.width = width * scale;
            canvas.height = height * scale;
            const ctx = canvas.getContext('2d');

            if (!ctx) {
                throw new Error('Unable to acquire canvas context');
            }

            ctx.setTransform(scale, 0, 0, scale, 0, 0);

            if (format === 'jpg') {
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, width, height);
            } else {
                ctx.clearRect(0, 0, width, height);
            }

            ctx.drawImage(img, 0, 0, width, height);
            return await canvasToBase64(canvas, format === 'jpg' ? 'image/jpeg' : 'image/png');
        }

        async function rasterizeSvgWithScale(svgEl, format, scale) {
            const { width, height } = getSvgDimensions(svgEl);
            const clonedSvg = svgEl.cloneNode(true);
            clonedSvg.setAttribute('width', String(width));
            clonedSvg.setAttribute('height', String(height));

            const svgData = new XMLSerializer().serializeToString(clonedSvg);
            const encodedSvg = encodeURIComponent(svgData);
            const imgSrc = 'data:image/svg+xml;charset=utf-8,' + encodedSvg;

            const img = await loadImage(imgSrc);
            const canvas = document.createElement('canvas');
            canvas.width = width * scale;
            canvas.height = height * scale;
            const ctx = canvas.getContext('2d');

            if (!ctx) {
                throw new Error('Unable to acquire canvas context');
            }

            ctx.setTransform(scale, 0, 0, scale, 0, 0);

            if (format === 'jpg') {
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, width, height);
            } else {
                ctx.clearRect(0, 0, width, height);
            }

            ctx.drawImage(img, 0, 0, width, height);
            return await canvasToBase64(canvas, format === 'jpg' ? 'image/jpeg' : 'image/png');
        }

        function notifyExportError(message, format) {
            vscode.postMessage({
                command: 'exportError',
                format,
                error: message
            });
        }

        window.exportActiveDiagram = async function(format, scale = 1) {
            exportDiagram(activeDiagramIndex, format, scale);
        };

        async function exportDiagram(index, format, scale = 1) {
            const diagramEl = document.getElementById('diagram-' + index);
            const svgEl = diagramEl?.querySelector('svg');
            if (!svgEl) {
                console.error('SVG element not found');
                return;
            }

            try {
                const clonedSvg = svgEl.cloneNode(true);

                if (format === 'svg') {
                    const svgData = new XMLSerializer().serializeToString(clonedSvg);
                    const base64Data = btoa(unescape(encodeURIComponent(svgData)));
                    vscode.postMessage({
                        command: 'exportDiagram',
                        format: 'svg',
                        data: base64Data,
                        index: index
                    });
                } else {
                    try {
                        const base64Data = await rasterizeSvgWithScale(svgEl, format, scale);
                        vscode.postMessage({
                            command: 'exportDiagram',
                            format: format,
                            data: base64Data,
                            index: index
                        });
                    } catch (rasterError) {
                        notifyExportError(rasterError instanceof Error ? rasterError.message : String(rasterError), format);
                    }
                }
            } catch (error) {
                notifyExportError(error instanceof Error ? error.message : String(error), format);
            }
        }

        window.copyActiveDiagram = async function(format, scale = 1) {
            copyDiagram(activeDiagramIndex, format, scale);
        };

        async function copyDiagram(index, format, scale = 1) {
            const diagramEl = document.getElementById('diagram-' + index);
            const svgEl = diagramEl?.querySelector('svg');
            if (!svgEl) {
                vscode.postMessage({
                    command: 'copyError',
                    format,
                    error: 'SVG element not found'
                });
                return;
            }

            try {
                if (format === 'svg') {
                    // SVG copies as raw text via extension host
                    const clonedSvg = svgEl.cloneNode(true);
                    const svgData = new XMLSerializer().serializeToString(clonedSvg);
                    vscode.postMessage({
                        command: 'copyDiagram',
                        format: 'svg',
                        data: svgData,
                        index: index
                    });
                    return;
                }

                const clipboardResult = await copyImageToClipboard(svgEl, format, scale);

                if (clipboardResult.kind === 'success') {
                    closeAllDropdowns();
                    vscode.postMessage({
                        command: 'copySuccess',
                        format,
                        actualFormat: clipboardResult.actualFormat
                    });
                    return;
                }

                if (clipboardResult.kind === 'needsFocus') {
                    const base64Data = await rasterizeSvgWithScale(svgEl, format, scale);
                    vscode.postMessage({
                        command: 'copyDiagram',
                        format: format,
                        data: base64Data,
                        index: index
                    });
                    return;
                }

                if (clipboardResult.kind === 'unsupported') {
                    vscode.postMessage({
                        command: 'copyError',
                        format,
                        error: clipboardResult.reason
                    });
                    return;
                }

                if (clipboardResult.kind === 'permissionDenied') {
                    vscode.postMessage({
                        command: 'copyError',
                        format,
                        error: clipboardResult.reason || 'Clipboard access denied. Try using Export instead.'
                    });
                    return;
                }

                if (clipboardResult.kind === 'unavailable') {
                    vscode.postMessage({
                        command: 'copyError',
                        format,
                        error: clipboardResult.reason || 'Clipboard API not available. Try using Export instead.'
                    });
                    return;
                }
            } catch (error) {
                vscode.postMessage({
                    command: 'copyError',
                    format,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }

        async function copyImageToClipboard(svgEl, format, scale) {
            if (!navigator.clipboard || !navigator.clipboard.write || typeof ClipboardItem === 'undefined') {
                return {
                    kind: 'unavailable',
                    reason: 'Clipboard API not available in this environment.'
                };
            }

            const { width, height } = getSvgDimensions(svgEl);
            const clonedSvg = svgEl.cloneNode(true);
            clonedSvg.setAttribute('width', String(width));
            clonedSvg.setAttribute('height', String(height));

            const svgData = new XMLSerializer().serializeToString(clonedSvg);
            const encodedSvg = encodeURIComponent(svgData);
            const imgSrc = 'data:image/svg+xml;charset=utf-8,' + encodedSvg;

            const img = await loadImage(imgSrc);
            const canvas = document.createElement('canvas');
            canvas.width = width * scale;
            canvas.height = height * scale;
            const ctx = canvas.getContext('2d');

            if (!ctx) {
                throw new Error('Unable to acquire canvas context');
            }

            ctx.setTransform(scale, 0, 0, scale, 0, 0);

            if (format === 'jpg') {
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, width, height);
            } else {
                ctx.clearRect(0, 0, width, height);
            }

            ctx.drawImage(img, 0, 0, width, height);

            const mimeCandidates = format === 'jpg'
                ? ['image/jpeg', 'image/png']
                : ['image/png'];

            let lastErrorMessage = '';

            for (const mimeType of mimeCandidates) {
                if (!isClipboardMimeSupported(mimeType)) {
                    continue;
                }

                try {
                    const blob = await canvasToBlobWithFormat(canvas, mimeType);
                    await navigator.clipboard.write([
                        new ClipboardItem({ [mimeType]: blob })
                    ]);
                    return {
                        kind: 'success',
                        actualFormat: mimeType === 'image/jpeg' ? 'jpg' : 'png'
                    };
                } catch (clipboardError) {
                    if (isDocumentFocusError(clipboardError)) {
                        const reason = clipboardError instanceof Error
                            ? clipboardError.message
                            : String(clipboardError ?? 'Document is not focused.');
                        return { kind: 'needsFocus', reason };
                    }

                    if (isPermissionDeniedError(clipboardError)) {
                        const reason = clipboardError instanceof Error
                            ? clipboardError.message
                            : String(clipboardError ?? 'Clipboard access denied.');
                        return { kind: 'permissionDenied', reason };
                    }
                    lastErrorMessage = clipboardError instanceof Error
                        ? clipboardError.message
                        : String(clipboardError ?? 'Clipboard write failed');
                }
            }

            return {
                kind: 'unsupported',
                reason: format === 'jpg'
                    ? 'Copying JPG images is not supported in this environment. Try PNG or Export.'
                    : (lastErrorMessage || 'Clipboard does not support this format in this environment.')
            };
        }

        window.addEventListener('error', (event) => {
            vscode.postMessage({
                command: 'webviewError',
                message: event.message ?? 'Unknown error',
                stack: event.error?.stack ?? null
            });
        });

        window.addEventListener('unhandledrejection', (event) => {
            vscode.postMessage({
                command: 'webviewError',
                message: event.reason?.message ?? String(event.reason ?? 'Unhandled promise rejection'),
                stack: event.reason?.stack ?? null
            });
        });

        // Serialize diagram updates so overlapping calls to updateDiagramsInPlace
        // can never race: Mermaid's render() relies on shared/global parser state
        // (see the "Render diagrams sequentially" comment above), so if an older,
        // slower render (e.g. one that ends in a parse error) settles after a
        // newer, already-applied render, it must not be allowed to clobber the DOM.
        let diagramUpdateChain = Promise.resolve();

        // Listen for messages from the extension
        window.addEventListener('message', (event) => {
            const message = event.data;
            if (message.command === 'updateState') {
                panelState = message.state;
                saveInteractionState();
                return;
            }

            if (message.command === 'updateDiagrams') {
                diagramUpdateChain = diagramUpdateChain.then(
                    () => updateDiagramsInPlace(message.diagrams)
                ).catch(() => {});
                return;
            }

            if (message.command === 'copyCompleted') {
                closeAllDropdowns();
            }
        });

        let renderAttempted = false;
        const RENDER_TIMEOUT_MS = 10000; // 10 seconds

        async function attemptRender() {
            if (renderAttempted) {
                return;
            }
            renderAttempted = true;

            // Check if Mermaid library is loaded
            if (typeof mermaid === 'undefined' || !mermaid.initialize || !mermaid.render) {
                vscode.postMessage({
                    command: 'webviewError',
                    message: 'Mermaid library failed to load. Please reload the preview.',
                    stack: null
                });
                const container = document.getElementById('diagrams-container');
                if (container) {
                    container.innerHTML = '<div class="diagram-error">' +
                        '<div class="diagram-error__title">Failed to load Mermaid library</div>' +
                        '<div class="diagram-error__message">The Mermaid rendering library failed to load. Try reloading the preview or restarting VS Code.</div>' +
                        '</div>';
                }
                return;
            }

            try {
                stageEl = document.getElementById('diagram-stage');
                setBodyAppearance(currentAppearance);
                updateDropdownSelection('dropdown-theme', currentTheme);
                updateDropdownSelection('dropdown-appearance', currentAppearance);
                updateThemeButtonLabel(currentTheme);
                await renderAllDiagrams();
                scheduleZoomUpdate();
                scheduleTransform();
                bindToolbarControls();
                bindKeyboardShortcuts();
                initAnnotationCanvas();
                // Give the viewport DOM focus immediately so keyboard shortcuts
                // work without requiring the user to click first
                const vp = document.getElementById('diagram-viewport');
                if (vp) vp.focus({ preventScroll: true });
                // Save state immediately on load to ensure it persists for restoration
                saveInteractionState();
                vscode.postMessage({ command: 'lifecycleEvent', status: 'webviewLoaded', documentId });
                vscode.postMessage({ command: 'webviewReady' });
            } catch (error) {
                vscode.postMessage({
                    command: 'webviewError',
                    message: 'Failed to initialize preview: ' + (error instanceof Error ? error.message : String(error)),
                    stack: error instanceof Error ? error.stack : null
                });
                const container = document.getElementById('diagrams-container');
                if (container) {
                    container.innerHTML = '<div class="diagram-error">' +
                        '<div class="diagram-error__title">Failed to load preview</div>' +
                        '<div class="diagram-error__message">An error occurred while initializing the preview. Check the output log for details.</div>' +
                        '</div>';
                }
            }
        }

        window.addEventListener('load', attemptRender);

        // Fallback: if load event doesn't fire within timeout, try to render anyway
        setTimeout(() => {
            if (!renderAttempted) {
                vscode.postMessage({
                    command: 'webviewError',
                    message: 'Load event timeout - attempting fallback render',
                    stack: null
                });
                attemptRender();
            }
        }, RENDER_TIMEOUT_MS);

        function bindKeyboardShortcuts() {
            document.addEventListener('keydown', (event) => {
                // Ignore keyboard shortcuts when typing in input fields
                if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
                    return;
                }

                // Ignore if modifier keys are pressed (except for Shift on +)
                if (event.ctrlKey || event.metaKey || event.altKey) {
                    return;
                }

                const key = event.key.toLowerCase();
                const code = event.code;

                // Support numpad keys across layouts (NumpadAdd/NumpadSubtract)
                if (code === 'NumpadAdd') {
                    event.preventDefault();
                    zoomIn();
                    return;
                }

                if (code === 'NumpadSubtract') {
                    event.preventDefault();
                    zoomOut();
                    return;
                }

                switch (key) {
                    // Zoom in with + or =
                    case '+':
                    case '=':
                        event.preventDefault();
                        zoomIn();
                        break;

                    // Zoom out with -
                    case '-':
                    case '_':
                        event.preventDefault();
                        zoomOut();
                        break;

                    // Reset view with 0
                    case '0':
                        event.preventDefault();
                        zoomReset();
                        break;

                    // Annotation: pen tool
                    case 'p':
                        event.preventDefault();
                        activatePen();
                        break;

                    // Annotation: set color (pen & shape only)
                    case 'r':
                        event.preventDefault();
                        if (annotationMode === 'pen' || annotationMode === 'shape') {
                            penColorIdx = 0; // red
                            updateAnnotationUI();
                        }
                        break;

                    case 'g':
                        event.preventDefault();
                        if (annotationMode === 'pen' || annotationMode === 'shape') {
                            penColorIdx = 2; // green
                            updateAnnotationUI();
                        }
                        break;

                    case 'b':
                        event.preventDefault();
                        if (annotationMode === 'pen' || annotationMode === 'shape') {
                            penColorIdx = 1; // blue
                            updateAnnotationUI();
                        }
                        break;

                    // Annotation: laser pointer
                    case 'l':
                        event.preventDefault();
                        toggleLaser();
                        break;

                    // Annotation: erase all
                    case 'e':
                        event.preventDefault();
                        eraseAllAnnotations();
                        break;

                    // Annotation: shapes (cycles arrow→line→rect→ellipse)
                    case 's':
                        event.preventDefault();
                        toggleShapeMode();
                        break;

                    // Exit annotation mode (back to grab/pan)
                    case 'escape':
                        event.preventDefault();
                        setAnnotationMode('none');
                        window.getSelection()?.removeAllRanges();
                        break;

                    // Pan with arrow keys (smooth movement)
                    case 'arrowup':
                        event.preventDefault();
                        panY += 30;
                        scheduleTransform();
                        saveInteractionState();
                        break;

                    case 'arrowdown':
                        event.preventDefault();
                        panY -= 30;
                        scheduleTransform();
                        saveInteractionState();
                        break;

                    case 'arrowleft':
                        event.preventDefault();
                        panX += 30;
                        scheduleTransform();
                        saveInteractionState();
                        break;

                    case 'arrowright':
                        event.preventDefault();
                        panX -= 30;
                        scheduleTransform();
                        saveInteractionState();
                        break;
                }
            });

            document.addEventListener('keydown', (event) => {
                if (event.key === 'Control' || event.key === 'Meta') {
                    document.body.classList.add('is-selecting');
                }
            });

            document.addEventListener('keyup', (event) => {
                if (event.key === 'Control' || event.key === 'Meta') {
                    document.body.classList.remove('is-selecting');
                }
            });

            // Clear when window loses focus (e.g. Alt+Tab while Ctrl held)
            window.addEventListener('blur', () => {
                document.body.classList.remove('is-selecting');
            });
        }

        function showKeyboardShortcuts() {
            vscode.postMessage({
                command: 'showKeyboardShortcuts'
            });
        }

        function bindToolbarControls() {
            const actionMap = new Map([
                ['zoom-in', zoomIn],
                ['zoom-out', zoomOut],
                ['zoom-reset', zoomReset],
                ['refresh', () => vscode.postMessage({ command: 'refreshDiagram' })]
            ]);

            actionMap.forEach((handler, action) => {
                document.querySelectorAll('[data-action="' + action + '"]').forEach(btn => {
                    btn.addEventListener('click', handler);
                });
            });

            const keyboardIcon = document.getElementById('keyboard-shortcuts-icon');
            if (keyboardIcon) {
                keyboardIcon.addEventListener('click', showKeyboardShortcuts);
            }

            document.querySelectorAll('[data-direction]').forEach(btn => {
                const dir = Number(btn.dataset.direction);
                btn.addEventListener('click', () => navigateDiagram(dir));
            });

            document.querySelectorAll('[data-dropdown-toggle]').forEach(btn => {
                const target = btn.dataset.dropdownToggle;
                if (target) {
                    btn.addEventListener('click', () => toggleDropdown(target));
                }
            });

            document.querySelectorAll('[data-theme-option]').forEach(btn => {
                const theme = btn.dataset.themeOption;
                if (theme) {
                    btn.addEventListener('click', () => handleThemeChange(theme));
                }
            });

            document.querySelectorAll('[data-appearance-option]').forEach(btn => {
                const appearance = btn.dataset.appearanceOption;
                if (appearance) {
                    btn.addEventListener('click', () => handleAppearanceChange(appearance));
                }
            });

            document.querySelectorAll('[data-export-format]').forEach(btn => {
                const format = btn.dataset.exportFormat;
                const scale = parseInt(btn.dataset.exportScale, 10) || 1;
                if (format) {
                    btn.addEventListener('click', () => exportActiveDiagram(format, scale));
                }
            });

            document.querySelectorAll('[data-copy-format]').forEach(btn => {
                const format = btn.dataset.copyFormat;
                const scale = parseInt(btn.dataset.copyScale, 10) || 1;
                if (format) {
                    btn.addEventListener('click', () => copyActiveDiagram(format, scale));
                }
            });

            const penBtn = document.getElementById('pen-btn');
            if (penBtn) {
                penBtn.addEventListener('click', activatePen);
            }

            const shapeBtn = document.getElementById('shape-btn');
            if (shapeBtn) {
                shapeBtn.addEventListener('click', toggleShapeMode);
            }

            const laserBtn = document.getElementById('laser-btn');
            if (laserBtn) {
                laserBtn.addEventListener('click', toggleLaser);
            }

            const eraseAnnotationBtn = document.getElementById('erase-annotation-btn');
            if (eraseAnnotationBtn) {
                eraseAnnotationBtn.addEventListener('click', eraseAllAnnotations);
            }
        }

        // ============================================================
        // ANNOTATION SYSTEM
        // ============================================================
        // annotationMode is declared above with other state vars
        let penColorIdx = 0;
        const PEN_COLORS = ['#ef4444', '#3b82f6', '#22c55e']; // red, blue, green
        const LASER_COLOR = '#ff3333';
        const LASER_DURATION_MS = 2000;
        const SHAPES = ['arrow', 'line', 'rect', 'ellipse'];
        let shapeIdx = 0;
        let currentShape = SHAPES[0];

        let annotationCanvas = null;
        let annotationCtx = null;
        let annotationResizeObserver = null;
        let isDrawingAnnotation = false;
        let activeStroke = null;    // stroke being drawn right now
        let penStrokes = [];        // completed, persistent pen strokes
        let laserStrokes = [];      // laser strokes pending fade-out
        let laserAnimRafId = null;
        let pendingAnnotationRedraw = null;
        let activeDrawStageRect = null;
        let annotationTransformRevision = 0;
        let penStrokesRevision = 0;
        let staticAnnotationCanvas = null;
        let staticAnnotationCtx = null;
        let staticRenderKey = '';
        let mouseDrawingActive = false;
        let runtimeCleanupDone = false;

        function initAnnotationCanvas() {
            annotationCanvas = document.getElementById('annotation-canvas');
            if (!annotationCanvas) return;
            annotationCtx = annotationCanvas.getContext('2d');

            const wrapper = document.getElementById('viewport-wrapper');
            resizeAnnotationCanvas(wrapper);
            annotationResizeObserver = new ResizeObserver(() => resizeAnnotationCanvas(wrapper));
            annotationResizeObserver.observe(wrapper);

            annotationCanvas.addEventListener('pointerdown', onAnnotationDown);
            annotationCanvas.addEventListener('pointermove', onAnnotationMove);
            annotationCanvas.addEventListener('pointerup', onAnnotationUp);
            annotationCanvas.addEventListener('pointerleave', onAnnotationLeave);
            annotationCanvas.addEventListener('pointercancel', onAnnotationUp);
            annotationCanvas.addEventListener('mousedown', onAnnotationMouseDown);

            // Populate shape icon on first render
            updateShapeIcon();
        }

        function cleanupAnnotationRuntime() {
            if (runtimeCleanupDone) {
                return;
            }
            runtimeCleanupDone = true;

            if (pendingAnnotationRedraw) {
                cancelAnimationFrame(pendingAnnotationRedraw);
                pendingAnnotationRedraw = null;
            }
            if (laserAnimRafId) {
                cancelAnimationFrame(laserAnimRafId);
                laserAnimRafId = null;
            }
            if (annotationResizeObserver) {
                annotationResizeObserver.disconnect();
                annotationResizeObserver = null;
            }
            if (mouseDrawingActive) {
                window.removeEventListener('mousemove', onWindowMouseMove);
                window.removeEventListener('mouseup', onWindowMouseUp);
                mouseDrawingActive = false;
            }
            if (annotationCanvas) {
                try {
                    annotationCanvas.releasePointerCapture?.(activePointerId);
                } catch {
                    // ignore
                }
            }
        }

        function resizeAnnotationCanvas(wrapper) {
            if (!annotationCanvas) return;
            const dpr = window.devicePixelRatio || 1;
            annotationCanvas.width = wrapper.clientWidth * dpr;
            annotationCanvas.height = wrapper.clientHeight * dpr;
            staticRenderKey = '';
            scheduleAnnotationRedraw();
        }

        function getAnnotationPoint(event) {
            // Use the stage's actual screen rect so scroll, padding and CSS
            // transforms are all accounted for — works correctly at any zoom level
            const stageRect = activeDrawStageRect || stageEl.getBoundingClientRect();
            return {
                x: (event.clientX - stageRect.left) / currentZoom,
                y: (event.clientY - stageRect.top) / currentZoom
            };
        }

        function diagramToCanvas(pt, offsetX, offsetY) {
            const dpr = window.devicePixelRatio || 1;
            return {
                x: offsetX + pt.x * currentZoom * dpr,
                y: offsetY + pt.y * currentZoom * dpr
            };
        }

        function setAnnotationMode(mode) {
            annotationMode = mode;
            if (!annotationCanvas) {
                annotationCanvas = document.getElementById('annotation-canvas');
            }
            if (mode === 'none') {
                if (annotationCanvas) {
                    annotationCanvas.style.pointerEvents = 'none';
                    annotationCanvas.style.cursor = '';
                }
                document.body.classList.remove('is-annotating');
            } else {
                if (annotationCanvas) {
                    annotationCanvas.style.pointerEvents = 'all';
                }
                document.body.classList.add('is-annotating');
            }
            updateAnnotationUI();
        }

        function makeDotCursor(color) {
            const r = 6;
            const size = r * 2 + 2;
            const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '">' +
                '<circle cx="' + (r + 1) + '" cy="' + (r + 1) + '" r="' + r + '" fill="' + color + '" stroke="rgba(0,0,0,0.6)" stroke-width="1.5"/>' +
                '</svg>';
            return 'url("data:image/svg+xml;utf8,' + encodeURIComponent(svg) + '") ' + (r + 1) + ' ' + (r + 1) + ', crosshair';
        }

        function makeLaserCursor() {
            // Larger canvas to fit the glow halo
            const cx = 14, cy = 14, size = 28;
            const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '">' +
                '<defs>' +
                  '<radialGradient id="g" cx="50%" cy="50%" r="50%">' +
                    '<stop offset="0%"   stop-color="#ff6600" stop-opacity="0.6"/>' +
                    '<stop offset="60%"  stop-color="#ff3333" stop-opacity="0.25"/>' +
                    '<stop offset="100%" stop-color="#ff0000" stop-opacity="0"/>' +
                  '</radialGradient>' +
                '</defs>' +
                '<circle cx="' + cx + '" cy="' + cy + '" r="13" fill="url(#g)"/>' +
                '<circle cx="' + cx + '" cy="' + cy + '" r="5" fill="#ff3333" stroke="#ffffff" stroke-width="1.2" opacity="0.9"/>' +
                '<circle cx="' + cx + '" cy="' + cy + '" r="2" fill="#ffffff" opacity="0.95"/>' +
                '</svg>';
            return 'url("data:image/svg+xml;utf8,' + encodeURIComponent(svg) + '") ' + cx + ' ' + cy + ', crosshair';
        }

        function applyDotCursor() {
            if (annotationMode === 'none' || !annotationCanvas) return;
            if (annotationMode === 'laser') {
                annotationCanvas.style.cursor = makeLaserCursor();
            } else {
                annotationCanvas.style.cursor = makeDotCursor(PEN_COLORS[penColorIdx]);
            }
        }

        function activatePen() {
            if (annotationMode !== 'pen') {
                setAnnotationMode('pen');
            }
            applyDotCursor();
            updateAnnotationUI();
        }

        function toggleLaser() {
            if (annotationMode === 'laser') {
                setAnnotationMode('none');
            } else {
                setAnnotationMode('laser');
            }
        }

        function toggleShapeMode() {
            if (annotationMode === 'shape') {
                shapeIdx = (shapeIdx + 1) % SHAPES.length;
                currentShape = SHAPES[shapeIdx];
            } else {
                setAnnotationMode('shape');
            }
            updateAnnotationUI();
        }

        function eraseAllAnnotations() {
            penStrokes = [];
            penStrokesRevision++;
            staticRenderKey = '';
            laserStrokes = [];
            activeStroke = null;
            activeDrawStageRect = null;
            if (annotationCtx) {
                annotationCtx.clearRect(0, 0, annotationCanvas.width, annotationCanvas.height);
            }
        }

        function updateAnnotationUI() {
            const penDot = document.getElementById('pen-dot');
            if (penDot) {
                penDot.style.backgroundColor = PEN_COLORS[penColorIdx];
            }
            const penBtn = document.getElementById('pen-btn');
            if (penBtn) {
                penBtn.classList.toggle('annotation-active', annotationMode === 'pen');
            }
            const laserBtn = document.getElementById('laser-btn');
            if (laserBtn) {
                laserBtn.classList.toggle('annotation-active', annotationMode === 'laser');
            }
            const shapeBtn = document.getElementById('shape-btn');
            if (shapeBtn) {
                shapeBtn.classList.toggle('annotation-active', annotationMode === 'shape');
            }
            updateShapeIcon();
            applyDotCursor();
        }

        const SHAPE_ICONS = {
            arrow: '<span style="font-size:14px;line-height:1;" aria-hidden="true">↗</span>',
            line:  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><line x1="2" y1="14" x2="14" y2="2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
            rect:  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="4" width="12" height="9" stroke="currentColor" stroke-width="1.8" rx="0.5" fill="none"/></svg>',
            ellipse: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><ellipse cx="8" cy="8" rx="6" ry="4.5" stroke="currentColor" stroke-width="1.8" fill="none"/></svg>'
        };

        function updateShapeIcon() {
            const el = document.getElementById('shape-icon');
            if (el) el.innerHTML = SHAPE_ICONS[currentShape] || SHAPE_ICONS.arrow;
        }

        function onAnnotationDown(event) {
            if (annotationMode === 'none') return;
            if (event.pointerType === 'mouse') return;
            event.preventDefault();
            event.stopPropagation();
            // Ensure DOM focus so keyboard shortcuts keep working while annotating
            if (viewportEl) viewportEl.focus({ preventScroll: true });
            isDrawingAnnotation = true;
            activeDrawStageRect = stageEl ? stageEl.getBoundingClientRect() : null;
            const pt = getAnnotationPoint(event);
            if (annotationMode === 'shape') {
                activeStroke = {
                    mode: 'shape',
                    shapeType: currentShape,
                    start: pt,
                    end: pt,
                    color: PEN_COLORS[penColorIdx],
                    lineWidth: 3
                };
            } else {
                activeStroke = {
                    points: [pt],
                    color: annotationMode === 'laser' ? LASER_COLOR : PEN_COLORS[penColorIdx],
                    lineWidth: annotationMode === 'laser' ? 4 : 3,
                    mode: annotationMode,
                    startTime: null
                };
            }
            annotationCanvas.setPointerCapture(event.pointerId);
            redrawAnnotations();
        }

        function onAnnotationMouseDown(event) {
            if (annotationMode === 'none') return;
            event.preventDefault();
            event.stopPropagation();
            if (viewportEl) viewportEl.focus({ preventScroll: true });
            isDrawingAnnotation = true;
            mouseDrawingActive = true;
            activeDrawStageRect = stageEl ? stageEl.getBoundingClientRect() : null;
            const pt = getAnnotationPoint(event);
            if (annotationMode === 'shape') {
                activeStroke = {
                    mode: 'shape',
                    shapeType: currentShape,
                    start: pt,
                    end: pt,
                    color: PEN_COLORS[penColorIdx],
                    lineWidth: 3
                };
            } else {
                activeStroke = {
                    points: [pt],
                    color: annotationMode === 'laser' ? LASER_COLOR : PEN_COLORS[penColorIdx],
                    lineWidth: annotationMode === 'laser' ? 4 : 3,
                    mode: annotationMode,
                    startTime: null
                };
            }
            window.addEventListener('mousemove', onWindowMouseMove, { passive: false });
            window.addEventListener('mouseup', onWindowMouseUp, { passive: false });
            redrawAnnotations();
        }

        function onWindowMouseMove(event) {
            if (!mouseDrawingActive || !isDrawingAnnotation || !activeStroke) return;
            if ((event.buttons & 1) === 0) {
                onWindowMouseUp(event);
                return;
            }
            event.preventDefault();
            const pt = getAnnotationPoint(event);
            if (activeStroke.mode === 'shape') {
                activeStroke.end = pt;
            } else {
                activeStroke.points.push(pt);
            }
            scheduleAnnotationRedraw();
        }

        function onWindowMouseUp(event) {
            if (!mouseDrawingActive) return;
            window.removeEventListener('mousemove', onWindowMouseMove);
            window.removeEventListener('mouseup', onWindowMouseUp);
            mouseDrawingActive = false;
            if (isDrawingAnnotation && activeStroke) {
                onAnnotationUp(event);
            }
        }

        function onAnnotationMove(event) {
            if (!isDrawingAnnotation || !activeStroke) return;
            if (mouseDrawingActive) return;
            event.preventDefault();
            const pt = getAnnotationPoint(event);
            if (activeStroke.mode === 'shape') {
                activeStroke.end = pt;
            } else {
                activeStroke.points.push(pt);
            }
            scheduleAnnotationRedraw();
        }

        function onAnnotationUp(event) {
            if (!isDrawingAnnotation || !activeStroke) return;
            isDrawingAnnotation = false;
            if (activeStroke.mode === 'shape') {
                penStrokes.push(activeStroke);
                penStrokesRevision++;
                staticRenderKey = '';
            } else if (activeStroke.mode === 'pen') {
                if (activeStroke.points.length > 0) {
                    penStrokes.push(activeStroke);
                    penStrokesRevision++;
                    staticRenderKey = '';
                }
            } else if (activeStroke.mode === 'laser') {
                activeStroke.startTime = Date.now();
                if (activeStroke.points.length > 0) {
                    laserStrokes.push(activeStroke);
                    startLaserFade();
                }
            }
            activeStroke = null;
            activeDrawStageRect = null;
            if (mouseDrawingActive) {
                window.removeEventListener('mousemove', onWindowMouseMove);
                window.removeEventListener('mouseup', onWindowMouseUp);
                mouseDrawingActive = false;
            }
            scheduleAnnotationRedraw();
        }

        function onAnnotationLeave(event) {
            if (isDrawingAnnotation) {
                onAnnotationUp(event);
            } else {
                activeDrawStageRect = null;
            }
        }

        function scheduleAnnotationRedraw() {
            if (pendingAnnotationRedraw) return;
            pendingAnnotationRedraw = requestAnimationFrame(() => {
                pendingAnnotationRedraw = null;
                redrawAnnotations();
            });
        }

        function drawSmooth(ctx, points, color, logicalLineWidth, alpha) {
            if (points.length === 0) return;
            const dpr = window.devicePixelRatio || 1;
            const lw = logicalLineWidth * dpr;

            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.strokeStyle = color;
            ctx.fillStyle = color;
            ctx.lineWidth = lw;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            if (points.length === 1) {
                // Single point: draw a filled circle
                ctx.beginPath();
                ctx.arc(points[0].x, points[0].y, lw / 2, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
                return;
            }

            ctx.beginPath();
            ctx.moveTo(points[0].x, points[0].y);

            for (let i = 1; i < points.length - 1; i++) {
                const mx = (points[i].x + points[i + 1].x) * 0.5;
                const my = (points[i].y + points[i + 1].y) * 0.5;
                ctx.quadraticCurveTo(points[i].x, points[i].y, mx, my);
            }

            // Final segment directly to last point
            const last = points[points.length - 1];
            ctx.lineTo(last.x, last.y);
            ctx.stroke();
            ctx.restore();
        }

        function drawLaserGlow(ctx, points, alpha) {
            if (points.length === 0) return;
            const dpr = window.devicePixelRatio || 1;

            // Pass 1 — wide soft halo
            ctx.save();
            ctx.globalAlpha = alpha * 0.25;
            ctx.strokeStyle = '#ff6600';
            ctx.lineWidth = 18 * dpr;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.filter = 'blur(' + (4 * dpr) + 'px)';
            drawPathOnly(ctx, points);
            ctx.restore();

            // Pass 2 — mid glow
            ctx.save();
            ctx.globalAlpha = alpha * 0.5;
            ctx.strokeStyle = LASER_COLOR;
            ctx.lineWidth = 8 * dpr;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.filter = 'blur(' + (1.5 * dpr) + 'px)';
            drawPathOnly(ctx, points);
            ctx.restore();

            // Pass 3 — bright core + white spine
            drawSmooth(ctx, points, LASER_COLOR, 3.5, alpha);
            drawSmooth(ctx, points, '#ffffff', 1.2, alpha * 0.8);
        }

        function drawPathOnly(ctx, points) {
            if (points.length < 2) return;
            ctx.beginPath();
            ctx.moveTo(points[0].x, points[0].y);
            for (let i = 1; i < points.length - 1; i++) {
                const mx = (points[i].x + points[i + 1].x) * 0.5;
                const my = (points[i].y + points[i + 1].y) * 0.5;
                ctx.quadraticCurveTo(points[i].x, points[i].y, mx, my);
            }
            ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
            ctx.stroke();
        }

        function drawShapeOnCanvas(ctx, type, s, e, color, logicalLineWidth) {
            const dpr = window.devicePixelRatio || 1;
            const lw = logicalLineWidth * dpr;
            ctx.save();
            ctx.strokeStyle = color;
            ctx.lineWidth = lw;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            if (type === 'line') {
                ctx.beginPath();
                ctx.moveTo(s.x, s.y);
                ctx.lineTo(e.x, e.y);
                ctx.stroke();
            } else if (type === 'arrow') {
                ctx.beginPath();
                ctx.moveTo(s.x, s.y);
                ctx.lineTo(e.x, e.y);
                ctx.stroke();
                const angle = Math.atan2(e.y - s.y, e.x - s.x);
                const headLen = 14 * dpr;
                ctx.beginPath();
                ctx.moveTo(e.x, e.y);
                ctx.lineTo(e.x - headLen * Math.cos(angle - Math.PI / 6), e.y - headLen * Math.sin(angle - Math.PI / 6));
                ctx.moveTo(e.x, e.y);
                ctx.lineTo(e.x - headLen * Math.cos(angle + Math.PI / 6), e.y - headLen * Math.sin(angle + Math.PI / 6));
                ctx.stroke();
            } else if (type === 'rect') {
                ctx.beginPath();
                ctx.strokeRect(s.x, s.y, e.x - s.x, e.y - s.y);
            } else if (type === 'ellipse') {
                const rx = Math.abs(e.x - s.x) / 2;
                const ry = Math.abs(e.y - s.y) / 2;
                const cx = (s.x + e.x) / 2;
                const cy = (s.y + e.y) / 2;
                if (rx > 0 && ry > 0) {
                    ctx.beginPath();
                    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
                    ctx.stroke();
                }
            }
            ctx.restore();
        }

        function ensureStaticAnnotationCanvas() {
            if (!annotationCanvas) return false;
            if (!staticAnnotationCanvas) {
                staticAnnotationCanvas = document.createElement('canvas');
                staticAnnotationCtx = staticAnnotationCanvas.getContext('2d');
                staticRenderKey = '';
            }
            if (!staticAnnotationCtx) return false;
            if (
                staticAnnotationCanvas.width !== annotationCanvas.width ||
                staticAnnotationCanvas.height !== annotationCanvas.height
            ) {
                staticAnnotationCanvas.width = annotationCanvas.width;
                staticAnnotationCanvas.height = annotationCanvas.height;
                staticRenderKey = '';
            }
            return true;
        }

        function redrawAnnotations() {
            if (!annotationCtx || !annotationCanvas || !stageEl) return;
            const ctx = annotationCtx;
            ctx.clearRect(0, 0, annotationCanvas.width, annotationCanvas.height);
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';

            // Compute stage→canvas offset once per frame using live rects so that
            // scroll, CSS padding, and all transforms are automatically included
            const dpr = window.devicePixelRatio || 1;
            const stageRect = stageEl.getBoundingClientRect();
            const canvasRect = annotationCanvas.getBoundingClientRect();
            const offsetX = (stageRect.left - canvasRect.left) * dpr;
            const offsetY = (stageRect.top - canvasRect.top) * dpr;

            const toCanvas = pt => diagramToCanvas(pt, offsetX, offsetY);
            const renderKey =
                annotationCanvas.width + '|' +
                annotationCanvas.height + '|' +
                annotationTransformRevision + '|' +
                penStrokesRevision;

            if (ensureStaticAnnotationCanvas()) {
                if (staticRenderKey !== renderKey) {
                    staticAnnotationCtx.clearRect(0, 0, staticAnnotationCanvas.width, staticAnnotationCanvas.height);
                    for (const stroke of penStrokes) {
                        if (stroke.mode === 'shape') {
                            drawShapeOnCanvas(staticAnnotationCtx, stroke.shapeType,
                                toCanvas(stroke.start), toCanvas(stroke.end),
                                stroke.color, stroke.lineWidth);
                        } else {
                            drawSmooth(staticAnnotationCtx, stroke.points.map(toCanvas), stroke.color, stroke.lineWidth, 1.0);
                        }
                    }
                    staticRenderKey = renderKey;
                }
                ctx.drawImage(staticAnnotationCanvas, 0, 0);
            } else {
                // Fallback path if offscreen cache is unavailable.
                for (const stroke of penStrokes) {
                    if (stroke.mode === 'shape') {
                        drawShapeOnCanvas(ctx, stroke.shapeType,
                            toCanvas(stroke.start), toCanvas(stroke.end),
                            stroke.color, stroke.lineWidth);
                    } else {
                        drawSmooth(ctx, stroke.points.map(toCanvas), stroke.color, stroke.lineWidth, 1.0);
                    }
                }
            }

            // Laser strokes with fade-out
            const now = Date.now();
            for (const stroke of laserStrokes) {
                const elapsed = now - stroke.startTime;
                const alpha = Math.max(0, 1 - elapsed / LASER_DURATION_MS);
                if (alpha > 0) {
                    drawLaserGlow(ctx, stroke.points.map(toCanvas), alpha);
                }
            }

            // Active stroke being drawn right now
            if (activeStroke) {
                if (activeStroke.mode === 'shape') {
                    drawShapeOnCanvas(ctx, activeStroke.shapeType,
                        toCanvas(activeStroke.start), toCanvas(activeStroke.end),
                        activeStroke.color, activeStroke.lineWidth);
                } else if (activeStroke.points && activeStroke.points.length > 0) {
                    const pts = activeStroke.points.map(toCanvas);
                    if (activeStroke.mode === 'laser') {
                        drawLaserGlow(ctx, pts, 1.0);
                    } else {
                        drawSmooth(ctx, pts, activeStroke.color, activeStroke.lineWidth, 1.0);
                    }
                }
            }
        }

        function startLaserFade() {
            if (laserAnimRafId) return;
            function animate() {
                const now = Date.now();
                laserStrokes = laserStrokes.filter(s => (now - s.startTime) < LASER_DURATION_MS);
                redrawAnnotations();
                if (laserStrokes.length > 0) {
                    laserAnimRafId = requestAnimationFrame(animate);
                } else {
                    laserAnimRafId = null;
                }
            }
            laserAnimRafId = requestAnimationFrame(animate);
        }

        window.addEventListener('beforeunload', cleanupAnnotationRuntime);
    </script>
    <style>
        * { box-sizing: border-box; }
        /* high-dpi cursor assets injected by previewPanel.ts */

        body {
            margin: 0;
            padding: 0;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            font-family: var(--vscode-font-family);
            display: flex;
            flex-direction: column;
            height: 100vh;
            --preview-toolbar-bg: var(--vscode-editorWidget-background);
            --preview-toolbar-border: var(--vscode-editorWidget-border);
            --preview-toolbar-fg: var(--vscode-editor-foreground);
            --preview-toolbar-hover-bg: color-mix(in srgb, var(--vscode-button-background) 20%, transparent);
            --preview-toolbar-hover-border: color-mix(in srgb, var(--vscode-button-background) 45%, transparent);
        }

        body.appearance-match {
            /* VS Code theme defaults */
        }

        body.appearance-light {
            --vscode-editor-background: #ffffff;
            --vscode-editor-foreground: #1f1f1f;
            --vscode-editorWidget-background: #f3f3f3;
            --vscode-editorWidget-border: #dcdcdc;
            --vscode-editorGroupHeader-tabsBackground: #f8f8f8;
            --vscode-button-background: #0067c0;
            --vscode-button-foreground: #ffffff;
            --vscode-button-hoverBackground: #0058a6;
            --vscode-menu-background: #ffffff;
            --vscode-menu-border: #dcdcdc;
            --vscode-menu-foreground: #1f1f1f;
            --vscode-menu-selectionBackground: #e6f2ff;
            --vscode-menu-selectionForeground: #1f1f1f;
            --vscode-errorForeground: #a1260d;
            --vscode-inputValidation-errorBackground: #f8d7da;
            --vscode-inputValidation-errorBorder: #f5c6cb;
            --preview-toolbar-bg: #f3f3f3;
            --preview-toolbar-border: #dcdcdc;
            --preview-toolbar-fg: #1f1f1f;
            --preview-toolbar-hover-bg: rgba(0, 103, 192, 0.14);
            --preview-toolbar-hover-border: rgba(0, 103, 192, 0.32);
        }

        body.appearance-dark {
            --vscode-editor-background: #1e1e1e;
            --vscode-editor-foreground: #f3f3f3;
            --vscode-editorWidget-background: #252526;
            --vscode-editorWidget-border: #3c3c3c;
            --vscode-editorGroupHeader-tabsBackground: #2c2c2c;
            --vscode-button-background: #0e639c;
            --vscode-button-foreground: #ffffff;
            --vscode-button-hoverBackground: #1177bb;
            --vscode-menu-background: #252526;
            --vscode-menu-border: #3c3c3c;
            --vscode-menu-foreground: #f3f3f3;
            --vscode-menu-selectionBackground: #094771;
            --vscode-menu-selectionForeground: #ffffff;
            --vscode-errorForeground: #f48771;
            --vscode-inputValidation-errorBackground: #5a1d1d;
            --vscode-inputValidation-errorBorder: #be1100;
            --preview-toolbar-bg: #2d2d2d;
            --preview-toolbar-border: #404040;
            --preview-toolbar-fg: #e0e0e0;
            --preview-toolbar-hover-bg: rgba(255, 255, 255, 0.1);
            --preview-toolbar-hover-border: rgba(255, 255, 255, 0.2);
        }

        .toolbar {
            background-color: var(--preview-toolbar-bg);
            border-bottom: 1px solid var(--preview-toolbar-border);
            padding: 6px 10px;
            display: flex;
            align-items: center;
            gap: 6px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
            color: var(--preview-toolbar-fg);
            z-index: 2;
        }

        .toolbar-group {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 0 6px;
            border-right: 1px solid var(--preview-toolbar-border);
        }

        .toolbar-group:last-child {
            border-right: none;
        }

        .toolbar button {
            background-color: transparent;
            color: var(--preview-toolbar-fg);
            border: 1px solid transparent;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
            cursor: pointer;
            font-family: var(--vscode-font-family);
        }


        .toolbar button:hover {
            background-color: var(--preview-toolbar-hover-bg);
            border-color: var(--preview-toolbar-hover-border);
        }

        .toolbar .codicon {
            font-size: 18px;
            line-height: 1;
        }

        .toolbar button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .zoom-label {
            font-size: 12px;
            color: var(--preview-toolbar-fg);
            opacity: 0.7;
            cursor: default;
            user-select: none;
        }

        #zoom-level {
            font-weight: 600;
        }

        #diagram-viewport {
            overflow: auto;
            background-color: var(--vscode-editor-background);
            cursor: -webkit-grab;
            cursor: grab;
            position: relative;
            outline: none;
        }

        #diagram-stage {
            width: 100%;
            min-height: 100%;
            transform-origin: center center;
            will-change: transform;
            cursor: -webkit-grab;
            cursor: grab;
        }

        #diagrams-container {
            padding: 32px 48px;
            display: flex;
            flex-direction: column;
            gap: 32px;
            cursor: -webkit-grab;
            cursor: grab;
        }

        body.is-panning #diagram-viewport {
            cursor: -webkit-grabbing !important;
            cursor: grabbing !important;
        }

        body.is-panning #diagram-stage {
            cursor: -webkit-grabbing !important;
            cursor: grabbing !important;
        }

        body.is-panning #diagrams-container {
            cursor: -webkit-grabbing !important;
            cursor: grabbing !important;
        }

        .diagram-shell {
            padding: 0;
        }

        .diagram-shell.active {
            box-shadow: none;
            background-color: transparent;
        }

        .diagram-content {
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 200px;
            transform-origin: top left;
            transition: transform 0.1s ease-out;
        }

        .diagram-content svg {
            width: 100%;
            height: auto;
        }

        #diagram-viewport *,
        #diagram-stage *,
        #diagrams-container *,
        .diagram-shell,
        .diagram-shell *,
        .diagram-content,
        .diagram-content * {
            cursor: -webkit-grab !important;
            cursor: grab !important;
        }

        body.is-panning #diagram-viewport *,
        body.is-panning #diagram-stage *,
        body.is-panning #diagrams-container *,
        body.is-panning .diagram-shell,
        body.is-panning .diagram-shell *,
        body.is-panning .diagram-content,
        body.is-panning .diagram-content * {
            cursor: -webkit-grabbing !important;
            cursor: grabbing !important;
        }

        #diagram-viewport .diagram-error,
        #diagram-viewport .diagram-error *,
        #diagram-stage .diagram-error,
        #diagram-stage .diagram-error *,
        #diagrams-container .diagram-error,
        #diagrams-container .diagram-error * {
            cursor: text !important;
        }

        .dropdown {
            position: relative;
        }

        .dropdown-arrow {
            font-size: 14px;
            vertical-align: middle;
            margin-left: 2px;
        }

        .action-btn {
            background-color: transparent;
            color: var(--preview-toolbar-fg);
            border: 1px solid transparent;
            padding: 6px 12px;
            border-radius: 4px;
            font-size: 12px;
            cursor: pointer;
        }

        .dropdown-menu {
            display: none;
            position: absolute;
            top: calc(100% + 4px);
            right: 0;
            min-width: 140px;
            background-color: var(--vscode-menu-background);
            border: 1px solid var(--vscode-menu-border);
            border-radius: 4px;
            box-shadow: 0 4px 18px rgba(0,0,0,0.18);
            z-index: 10;
        }

        .dropdown-menu.show {
            display: block;
        }

        .dropdown-menu button {
            width: 100%;
            padding: 8px 14px;
            background: transparent;
            color: var(--vscode-menu-foreground);
            border: none;
            text-align: left;
            font-size: 12px;
            cursor: pointer;
        }

        .dropdown-menu button:hover,
        .dropdown-menu button.selected {
            background-color: var(--vscode-menu-selectionBackground);
            color: var(--vscode-menu-selectionForeground);
        }

        .dropdown-separator {
            height: 1px;
            background-color: var(--vscode-menu-border);
            margin: 4px 0;
        }

        .diagram-indicator {
            font-size: 12px;
            font-weight: 600;
            min-width: 140px;
            text-align: center;
            color: var(--preview-toolbar-fg);
        }

        .keyboard-shortcuts-hint {
            flex: 1;
            justify-content: flex-end;
            border-right: none;
        }

        .shortcuts-icon {
            font-size: 20px;
            opacity: 0.8;
            cursor: pointer;
            user-select: none;
            display: inline-block;
            padding: 0 4px;
            transition: opacity 0.2s ease, transform 0.1s ease;
            color: var(--preview-toolbar-fg);
        }

        .shortcuts-icon:hover {
            opacity: 1;
            transform: scale(1.1);
        }

        .shortcuts-icon:active {
            transform: scale(0.95);
        }

        .error {
            color: var(--vscode-errorForeground);
            background-color: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            padding: 16px;
            border-radius: 4px;
        }

        .diagram-error {
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            background: var(--vscode-inputValidation-errorBackground);
            color: var(--vscode-errorForeground);
            padding: 16px;
            border-radius: 6px;
            max-width: 720px;
            margin: 0 auto;
            user-select: text;
            cursor: text;
        }

        .diagram-error__title {
            font-weight: 600;
            margin-bottom: 6px;
        }

        .diagram-error__message {
            margin: 0;
            white-space: pre-wrap;
        }

        .diagram-content.loading {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 200px;
            color: var(--vscode-editor-foreground);
            opacity: 0.7;
        }

        .loading-spinner {
            width: 40px;
            height: 40px;
            border: 4px solid var(--vscode-editor-foreground);
            border-top-color: transparent;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-bottom: 12px;
            opacity: 0.3;
        }

        .loading-text {
            font-size: 14px;
            color: var(--vscode-editor-foreground);
            opacity: 0.6;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        /* === ANNOTATION SYSTEM === */
        #viewport-wrapper {
            position: relative;
            flex: 1;
            min-height: 0;
            overflow: hidden;
        }

        #diagram-viewport {
            width: 100%;
            height: 100%;
        }

        #annotation-canvas {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            touch-action: none;
            z-index: 5;
            cursor: none;
        }

        .annotation-tool-btn {
            background: transparent;
            border: 1px solid transparent;
            border-radius: 4px;
            color: var(--preview-toolbar-fg);
            cursor: pointer;
            padding: 3px 6px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            height: 28px;
            min-width: 28px;
            gap: 4px;
            font-size: 12px;
            font-family: var(--vscode-font-family);
            transition: background 0.15s, border-color 0.15s;
            user-select: none;
        }

        .annotation-tool-btn:hover {
            background-color: var(--preview-toolbar-hover-bg);
            border-color: var(--preview-toolbar-hover-border);
        }

        .annotation-tool-btn.annotation-active {
            background-color: color-mix(in srgb, var(--vscode-button-background) 25%, transparent);
            border-color: var(--vscode-button-background);
        }

        .pen-dot {
            display: inline-block;
            width: 12px;
            height: 12px;
            border-radius: 50%;
            background-color: #ef4444;
            border: 1.5px solid rgba(255, 255, 255, 0.5);
            flex-shrink: 0;
            transition: background-color 0.15s;
        }

        /* Suppress system cursor when annotating — canvas sets its own dot cursor */
        body.is-annotating #diagram-viewport,
        body.is-annotating #diagram-stage,
        body.is-annotating #diagrams-container,
        body.is-annotating .diagram-shell,
        body.is-annotating .diagram-shell *,
        body.is-annotating .diagram-content,
        body.is-annotating .diagram-content * {
            cursor: none !important;
        }

        body.is-annotating.is-panning #diagram-viewport,
        body.is-annotating.is-panning #diagram-stage,
        body.is-annotating.is-panning #diagrams-container,
        body.is-annotating.is-panning .diagram-shell,
        body.is-annotating.is-panning .diagram-shell *,
        body.is-annotating.is-panning .diagram-content,
        body.is-annotating.is-panning .diagram-content * {
            cursor: none !important;
        }

        body.is-selecting #diagram-viewport,
        body.is-selecting #diagram-stage,
        body.is-selecting #diagrams-container,
        body.is-selecting .diagram-shell,
        body.is-selecting .diagram-shell *,
        body.is-selecting .diagram-content,
        body.is-selecting .diagram-content * {
            cursor: text !important;
            user-select: text !important;
        }

        #diagram-viewport ::selection,
        #diagram-stage ::selection,
        #diagrams-container ::selection,
        .diagram-shell ::selection,
        .diagram-content ::selection {
            background-color: color-mix(in srgb, var(--vscode-editor-selectionBackground, #ADD6FF) 25%, transparent);
            color: inherit;
        }
    </style>
</head>
<body class="${appearanceClass}">
    <div class="toolbar">
        <div class="toolbar-group zoom-group">
            <span class="zoom-label">Zoom: <span id="zoom-level">100%</span></span>
            <button data-action="zoom-out" title="Zoom out" aria-label="Zoom out">
                <span class="codicon codicon-zoom-out" aria-hidden="true"></span>
            </button>
            <button data-action="zoom-in" title="Zoom in" aria-label="Zoom in">
                <span class="codicon codicon-zoom-in" aria-hidden="true"></span>
            </button>
            <button data-action="zoom-reset" title="Reset zoom and pan">
                <span class="codicon codicon-screen-full" aria-hidden="true"></span>
            </button>
        </div>
        <div class="toolbar-group" id="diagram-controls">
            <button id="prev-diagram" data-direction="-1" title="Previous diagram" aria-label="Previous diagram">
                <span class="codicon codicon-triangle-left" aria-hidden="true"></span>
            </button>
            <span id="diagram-indicator"></span>
            <button id="next-diagram" data-direction="1" title="Next diagram" aria-label="Next diagram">
                <span class="codicon codicon-triangle-right" aria-hidden="true"></span>
            </button>
        </div>
        <div class="toolbar-group keyboard-shortcuts-hint">
            <span class="shortcuts-icon" id="keyboard-shortcuts-icon" title="Click for keyboard shortcuts" aria-label="Keyboard shortcuts">
                <span class="codicon codicon-keyboard" aria-hidden="true"></span>
            </span>
        </div>
        <div class="toolbar-group annotation-tools-group">
            <button class="annotation-tool-btn" id="pen-btn" title="Pen (P)" aria-label="Pen annotation tool">
                <span class="pen-dot" id="pen-dot"></span>
            </button>
            <button class="annotation-tool-btn" id="shape-btn" title="Shape (S — cycles arrow→line→rect→ellipse)" aria-label="Shape annotation tool">
                <span id="shape-icon" aria-hidden="true"></span>
            </button>
            <button class="annotation-tool-btn" id="laser-btn" title="Laser pointer (L)" aria-label="Laser annotation tool">
                <span class="codicon codicon-record" aria-hidden="true" style="color:#ff3333;font-size:14px;"></span>
            </button>
            <button class="annotation-tool-btn" id="erase-annotation-btn" title="Erase all annotations (E)" aria-label="Erase all annotations">
                <span class="codicon codicon-clear-all" aria-hidden="true"></span>
            </button>
        </div>
        <div class="toolbar-group dropdown">
            <button class="action-btn" id="theme-button" data-dropdown-toggle="theme">Theme <span class="codicon codicon-triangle-down dropdown-arrow" aria-hidden="true"></span></button>
            <div class="dropdown-menu" id="dropdown-theme">
                <button data-theme-option="default">Default</button>
                <button data-theme-option="dark">Dark</button>
                <button data-theme-option="forest">Forest</button>
                <button data-theme-option="neutral">Neutral</button>
                <button data-theme-option="base">Base</button>
            </div>
        </div>
        <div class="toolbar-group dropdown">
            <button class="action-btn" id="appearance-button" data-dropdown-toggle="appearance">Appearance <span class="codicon codicon-triangle-down dropdown-arrow" aria-hidden="true"></span></button>
            <div class="dropdown-menu" id="dropdown-appearance">
                <button data-appearance-option="matchVSCode">Match VS Code</button>
                <button data-appearance-option="light">Light</button>
                <button data-appearance-option="dark">Dark</button>
            </div>
        </div>
        <div class="toolbar-group dropdown">
            <button class="action-btn" data-dropdown-toggle="export">Export <span class="codicon codicon-triangle-down dropdown-arrow" aria-hidden="true"></span></button>
            <div class="dropdown-menu" id="dropdown-export">
                <button data-export-format="svg" data-export-scale="1">SVG</button>
                <div class="dropdown-separator"></div>
                <button data-export-format="png" data-export-scale="1">PNG</button>
                <button data-export-format="png" data-export-scale="2">PNG</button>
                <button data-export-format="png" data-export-scale="3">PNG</button>
                <button data-export-format="png" data-export-scale="4">PNG</button>
                <div class="dropdown-separator"></div>
                <button data-export-format="jpg" data-export-scale="1">JPG</button>
                <button data-export-format="jpg" data-export-scale="2">JPG</button>
                <button data-export-format="jpg" data-export-scale="3">JPG</button>
                <button data-export-format="jpg" data-export-scale="4">JPG</button>
            </div>
        </div>
        <div class="toolbar-group dropdown">
            <button class="action-btn" data-dropdown-toggle="copy">Copy <span class="codicon codicon-triangle-down dropdown-arrow" aria-hidden="true"></span></button>
            <div class="dropdown-menu" id="dropdown-copy">
                <button data-copy-format="svg" data-copy-scale="1">SVG</button>
                <div class="dropdown-separator"></div>
                <button data-copy-format="png" data-copy-scale="1">PNG (1x)</button>
                <button data-copy-format="png" data-copy-scale="2">PNG (2x)</button>
                <button data-copy-format="png" data-copy-scale="3">PNG (3x)</button>
                <button data-copy-format="png" data-copy-scale="4">PNG (4x)</button>
                <div class="dropdown-separator"></div>
                <button data-copy-format="jpg" data-copy-scale="1">JPG (1x)</button>
                <button data-copy-format="jpg" data-copy-scale="2">JPG (2x)</button>
                <button data-copy-format="jpg" data-copy-scale="3">JPG (3x)</button>
                <button data-copy-format="jpg" data-copy-scale="4">JPG (4x)</button>
            </div>
        </div>
        <div class="toolbar-group">
            <button data-action="refresh" title="Reload diagram from source">Reload</button>
        </div>
    </div>
    <div id="viewport-wrapper">
        <div id="diagram-viewport" tabindex="-1">
            <div id="diagram-stage">
                <div id="diagrams-container"></div>
            </div>
        </div>
        <canvas id="annotation-canvas" aria-hidden="true"></canvas>
    </div>
</body>
</html>`;
		} catch (error) {
			this._logger.logError(
				'Failed to generate webview HTML',
				error instanceof Error ? error : new Error(String(error)),
			);
			return this._getErrorHtml(
				'Failed to render diagram preview. See output log for details.',
			);
		}
	}
	private _getErrorHtml(message: string): string {
		return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Mermaid Diagram Lens - Error</title>
    <style>
        body {
            padding: 20px;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            font-family: var(--vscode-font-family);
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
        }
        .error-container {
            text-align: center;
            max-width: 500px;
        }
        .error-icon {
            font-size: 48px;
            margin-bottom: 20px;
        }
        .error-message {
            color: var(--vscode-errorForeground);
            font-size: 16px;
        }
    </style>
</head>
<body>
    <div class="error-container">
        <div class="error-icon">⚠️</div>
        <div class="error-message">${message}</div>
    </div>
</body>
</html>`;
	}

	public refreshAppearance() {
		if (!this._currentDocument) {
			return;
		}

		this._render();
	}

	public dispose() {
		if (this._isDisposed) {
			return;
		}

		this._isDisposed = true;
		MermaidPreviewPanel._panels.delete(this);
		this._blockCache.clear();

		if (this._updateTimeout) {
			clearTimeout(this._updateTimeout);
			this._updateTimeout = undefined;
		}

		this._panel.dispose();

		while (this._disposables.length) {
			const disposable = this._disposables.pop();
			if (disposable) {
				disposable.dispose();
			}
		}
	}
}

export class MermaidPreviewSerializer implements vscode.WebviewPanelSerializer {
	constructor(private readonly _extensionUri: vscode.Uri) {}

	async deserializeWebviewPanel(
		webviewPanel: vscode.WebviewPanel,
		state: WebviewState,
	): Promise<void> {
		await MermaidPreviewPanel.revive(webviewPanel, this._extensionUri, state);
	}
}
