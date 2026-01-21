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
};

type WebviewState = {
	panelState?: SerializedPanelState;
	docStates?: Record<string, unknown>;
};

export class MermaidPreviewPanel {
	public static readonly viewType = 'mermaidLivePreview';
	private static readonly _panels = new Set<MermaidPreviewPanel>();
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

	public static forEachPanel(callback: (panel: MermaidPreviewPanel) => void) {
		for (const panel of MermaidPreviewPanel._panels) {
			callback(panel);
		}
	}

	public static hasOpenPanels(): boolean {
		return MermaidPreviewPanel._panels.size > 0;
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
		const config = vscode.workspace.getConfiguration('mermaidLivePreview');
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
				}
			},
			null,
			this._disposables,
		);

		// Listen for configuration changes to update panel title
		vscode.workspace.onDidChangeConfiguration(
			(e) => {
				if (e.affectsConfiguration('mermaidLivePreview.panelTitleStyle')) {
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
		const config = vscode.workspace.getConfiguration('mermaidLivePreview');
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
			this._render();
			return;
		}

		// Otherwise, debounce updates normally
		this._updateTimeout = setTimeout(() => {
			this._firstUpdateRequestTime = undefined;
			this._render();
		}, delay);
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
			// Persist the selection and update the preview
			const config = vscode.workspace.getConfiguration('mermaidLivePreview');
			await config.update(
				'useVSCodeTheme',
				false,
				vscode.ConfigurationTarget.Global,
			);
			await config.update('theme', theme, vscode.ConfigurationTarget.Global);
			this._render(theme);
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
			const config = vscode.workspace.getConfiguration('mermaidLivePreview');
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
			const config = vscode.workspace.getConfiguration('mermaidLivePreview');
			await config.update(
				'previewAppearance',
				appearance,
				vscode.ConfigurationTarget.Global,
			);
			this.refreshAppearance();
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
			'  r            Reset view',
			'',
			'Pan:',
			'  ↑ ↓ ← →      Arrow keys to pan around',
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

		if (!this._currentDocument) {
			webview.html = this._getErrorHtml('No document to preview');
			return;
		}

		const mermaidCode = this._extractMermaidCode(this._currentDocument);

		if (!mermaidCode) {
			webview.html = this._getErrorHtml(
				'No Mermaid diagram found. Wrap your diagram in ```mermaid code blocks.',
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

			// For markdown files, extract mermaid code blocks
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
		const config = vscode.workspace.getConfiguration('mermaidLivePreview');
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
			const diagrams = JSON.parse(mermaidCode);
			const escapedDiagrams = diagrams.map((code: string) =>
				code.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$'),
			);
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

			const docId = documentId ?? 'unknown';
			const nonce = this._generateNonce();
			const config = vscode.workspace.getConfiguration('mermaidLivePreview');
			const renderTimeout = config.get<number>('renderTimeout', 0);

			return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Mermaid Diagram Lens</title>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; connect-src ${webview.cspSource} https:;">
    <script type="module" nonce="${nonce}">
        import mermaid from '${mermaidScriptUri}';

        const vscode = acquireVsCodeApi();
        const documentId = ${JSON.stringify(docId)};
        const persistedState = vscode.getState?.() ?? {};
        let docStates = persistedState.docStates ?? {};
        const savedState = docStates[documentId] ?? {};

        // Initialize panel state for restoration after reload
        let panelState = persistedState.panelState ?? {
            documentUri: ${JSON.stringify(this._documentUri)},
            mode: ${JSON.stringify(this._mode)},
            singleLine: ${this._singleLine ?? 'undefined'}
        };

        const diagrams = ${JSON.stringify(escapedDiagrams)};
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

        async function validateDiagram(diagram, index) {
            try {
                if (renderTimeout > 0) {
                    await withTimeout(
                        mermaid.parse(diagram),
                        renderTimeout,
                        'Diagram validation timed out after ' + renderTimeout + 'ms'
                    );
                } else {
                    await mermaid.parse(diagram);
                }
                return true;
            } catch (error) {
                showRenderError(index, error);
                lastParseError = null;
                return false;
            }
        }

        mermaid.initialize({
            startOnLoad: false,
            theme: currentTheme,
            securityLevel: 'loose',
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

            for (let i = 0; i < diagrams.length; i++) {
                lastParseError = null;
                const shell = document.createElement('div');
                shell.className = 'diagram-shell';
                shell.dataset.index = i.toString();
                shell.innerHTML = '<div class="diagram-content loading" id="diagram-' + i + '">' +
                    '<div class="loading-spinner"></div>' +
                    '<div class="loading-text">Rendering diagram...</div>' +
                    '</div>';
                container.appendChild(shell);
                shell.addEventListener('click', () => focusDiagram(i));

                // Set a timeout to catch stuck renders (only if configured)
                let renderTimeoutId;
                if (renderTimeout > 0) {
                    renderTimeoutId = setTimeout(() => {
                        const diagramEl = document.getElementById('diagram-' + i);
                        if (diagramEl && diagramEl.classList.contains('loading')) {
                            showRenderError(i, new Error('Diagram rendering timed out after ' + renderTimeout + 'ms. The diagram may be too complex or contain syntax errors.'));
                        }
                    }, renderTimeout);
                }

                if (!(await validateDiagram(diagrams[i], i))) {
                    if (renderTimeoutId) clearTimeout(renderTimeoutId);
                    continue;
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
                    }
                } catch (error) {
                    if (renderTimeoutId) clearTimeout(renderTimeoutId);
                    console.error('Failed to render diagram ' + i, error);
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
        }

        function applyZoomScale() {
            pendingZoomUpdate = null;
            document.querySelectorAll('.diagram-content').forEach(el => {
                el.style.transform = 'scale(' + currentZoom + ')';
            });
            document.getElementById('zoom-level').textContent = Math.round(currentZoom * 100) + '%';
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
            if (event.target.closest('.dropdown') || event.target.closest('.toolbar')) {
                return;
            }

            if (event.button !== undefined && event.button !== 0 && event.pointerType !== 'touch' && event.pointerType !== 'pen') {
                return;
            }

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
                button.textContent = 'Theme: ' + label + ' ▾';
            }
        }

        function updateAppearanceButtonLabel(appearance) {
            const button = document.getElementById('appearance-button');
            if (button) {
                const label = APPEARANCE_LABELS[appearance] || 'Custom';
                button.textContent = 'Appearance: ' + label + ' ▾';
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

        // Listen for messages from the extension
        window.addEventListener('message', (event) => {
            const message = event.data;
            if (message.command === 'updateState') {
                panelState = message.state;
                saveInteractionState();
            }
        });

        let renderAttempted = false;
        const RENDER_TIMEOUT_MS = 10000; // 10 seconds

        function attemptRender() {
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
                renderAllDiagrams();
                scheduleZoomUpdate();
                scheduleTransform();
                bindToolbarControls();
                bindKeyboardShortcuts();
                // Save state immediately on load to ensure it persists for restoration
                saveInteractionState();
                vscode.postMessage({ command: 'lifecycleEvent', status: 'webviewLoaded', documentId });
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

                    // Reset view with r
                    case 'r':
                        event.preventDefault();
                        zoomReset();
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
                ['zoom-reset', zoomReset]
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
        }
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
        }

        .toolbar {
            background-color: var(--vscode-editorWidget-background);
            border-bottom: 1px solid var(--vscode-editorWidget-border);
            padding: 10px 16px;
            display: flex;
            align-items: center;
            gap: 12px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.08);
            z-index: 2;
        }

        .toolbar-group {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 0 8px;
            border-right: 1px solid var(--vscode-editorWidget-border);
        }

        .toolbar-group:last-child {
            border-right: none;
        }

        .toolbar button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 12px;
            border-radius: 4px;
            font-size: 12px;
            cursor: pointer;
            font-family: var(--vscode-font-family);
        }

        .toolbar button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        .toolbar button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        #zoom-level {
            min-width: 45px;
            text-align: center;
            font-size: 12px;
            font-weight: 600;
        }

        #diagram-viewport {
            flex: 1;
            overflow: auto;
            background-color: var(--vscode-editor-background);
            cursor: -webkit-grab;
            cursor: grab;
            position: relative;
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

        .dropdown {
            position: relative;
        }

        .action-btn {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
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
        }

        .keyboard-shortcuts-hint {
            flex: 1;
            justify-content: flex-end;
            border-right: none;
        }

        .shortcuts-icon {
            font-size: 32px;
            opacity: 0.6;
            cursor: pointer;
            user-select: none;
            display: inline-block;
            padding: 0 4px;
            transition: opacity 0.2s ease, transform 0.1s ease;
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
            color: var(--vscode-foreground);
            opacity: 0.7;
        }

        .loading-spinner {
            width: 40px;
            height: 40px;
            border: 4px solid var(--vscode-foreground);
            border-top-color: transparent;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-bottom: 12px;
            opacity: 0.3;
        }

        .loading-text {
            font-size: 14px;
            color: var(--vscode-descriptionForeground);
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }
    </style>
</head>
<body class="${appearanceClass}">
    <div class="toolbar">
        <div class="toolbar-group">
            <button data-action="zoom-out">−</button>
            <span id="zoom-level">100%</span>
            <button data-action="zoom-in">+</button>
            <button data-action="zoom-reset">Reset</button>
        </div>
        <div class="toolbar-group" id="diagram-controls">
            <button id="prev-diagram" data-direction="-1">◀</button>
            <span id="diagram-indicator"></span>
            <button id="next-diagram" data-direction="1">▶</button>
        </div>
        <div class="toolbar-group keyboard-shortcuts-hint">
            <span class="shortcuts-icon" id="keyboard-shortcuts-icon" title="Click for keyboard shortcuts">⌨</span>
        </div>
        <div class="toolbar-group dropdown">
            <button class="action-btn" id="theme-button" data-dropdown-toggle="theme">Theme ▾</button>
            <div class="dropdown-menu" id="dropdown-theme">
                <button data-theme-option="default">Default</button>
                <button data-theme-option="dark">Dark</button>
                <button data-theme-option="forest">Forest</button>
                <button data-theme-option="neutral">Neutral</button>
                <button data-theme-option="base">Base</button>
            </div>
        </div>
        <div class="toolbar-group dropdown">
            <button class="action-btn" id="appearance-button" data-dropdown-toggle="appearance">Appearance ▾</button>
            <div class="dropdown-menu" id="dropdown-appearance">
                <button data-appearance-option="matchVSCode">Match VS Code</button>
                <button data-appearance-option="light">Light</button>
                <button data-appearance-option="dark">Dark</button>
            </div>
        </div>
        <div class="toolbar-group dropdown">
            <button class="action-btn" data-dropdown-toggle="export">Export ▾</button>
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
            <button class="action-btn" data-dropdown-toggle="copy">Copy as ▾</button>
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
    </div>
    <div id="diagram-viewport">
        <div id="diagram-stage">
            <div id="diagrams-container"></div>
        </div>
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
