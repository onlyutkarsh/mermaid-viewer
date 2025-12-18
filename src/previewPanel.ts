import * as path from 'path';
import * as vscode from 'vscode';
import { Logger } from './util/logger';

type PreviewAppearance = 'matchVSCode' | 'light' | 'dark';
type PreviewMode = 'all' | 'single';


type MermaidBlock = {
    code: string;
    startLine: number;
    endLine: number;
};

export class MermaidPreviewPanel {
    private static readonly _panels = new Set<MermaidPreviewPanel>();
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _logger: Logger;
    private readonly _blockCache = new Map<string, { version: number; blocks: MermaidBlock[] }>();
    private readonly _documentUri: string;
    private _disposables: vscode.Disposable[] = [];
    private _updateTimeout: NodeJS.Timeout | undefined;
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

    private static _findMatchingPanel(
        document: vscode.TextDocument,
        mode: PreviewMode,
        lineNumber?: number
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
        lineNumber?: number
    ): string {
        const label = MermaidPreviewPanel._deriveDocumentLabel(document);
        if (mode === 'single') {
            const lineSuffix = typeof lineNumber === 'number' ? `:${lineNumber + 1}` : '';
            return `Mermaid Diagram Preview — ${label}${lineSuffix}`;
        }
        return `Mermaid Diagram Lens — ${label}`;
    }

    private static _createWebviewPanel(
        extensionUri: vscode.Uri,
        title: string,
        viewColumn: vscode.ViewColumn
    ): vscode.WebviewPanel {
        return vscode.window.createWebviewPanel(
            'mermaidPreview',
            title,
            viewColumn,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    extensionUri,
                    vscode.Uri.joinPath(extensionUri, 'out')
                ]
            }
        );
    }

    public static createOrShow(
        extensionUri: vscode.Uri,
        document: vscode.TextDocument,
        viewColumn: vscode.ViewColumn
    ) {
        const title = MermaidPreviewPanel._buildPanelTitle(document, 'all');
        const panel = MermaidPreviewPanel._createWebviewPanel(
            extensionUri,
            title,
            viewColumn
        );
        new MermaidPreviewPanel(panel, extensionUri, document, 'all');
    }

    public static createOrShowSingle(
        extensionUri: vscode.Uri,
        document: vscode.TextDocument,
        lineNumber: number,
        viewColumn: vscode.ViewColumn
    ) {
        const existing = MermaidPreviewPanel._findMatchingPanel(document, 'single', lineNumber);
        if (existing) {
            existing._panel.reveal(viewColumn);
            existing.handleSelectionChange(document, lineNumber);
            return;
        }

        const title = MermaidPreviewPanel._buildPanelTitle(document, 'single', lineNumber);
        const panel = MermaidPreviewPanel._createWebviewPanel(
            extensionUri,
            title,
            viewColumn
        );

        new MermaidPreviewPanel(panel, extensionUri, document, 'single', lineNumber);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        document: vscode.TextDocument,
        mode: PreviewMode,
        singleLine?: number
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._currentDocument = document;
        this._documentUri = document.uri.toString();
        this._logger = Logger.instance;
        this._mode = mode;
        this._singleLine = singleLine;
        MermaidPreviewPanel._panels.add(this);

        // Set the webview's initial html content
        this._render();

        // Listen for when the panel is disposed
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            (message) => {
                this._logger.logDebug('WebviewMessage', `Received ${message.command}`, message);
                switch (message.command) {
                    case 'changeTheme':
                        this._handleThemeChange(message.theme);
                        break;
                    case 'saveThemePreference':
                        this._saveThemePreference(message.theme);
                        break;
                    case 'exportDiagram':
                        this._logger.logDebug('Export', 'Received export request from webview', {
                            format: message.format,
                            index: message.index,
                            dataLength: message.data?.length
                        });
                        this._handleExportDiagram(message.data, message.format, message.index);
                        break;
                    case 'exportError':
                        this._logger.logError('Webview reported export error', message.error ?? 'Unknown error');
                        vscode.window.showErrorMessage(`Failed to export diagram: ${message.error ?? 'Unknown error'}`);
                        break;
                    case 'renderError':
                        this._logger.logError('Mermaid diagram render failed', {
                            document: this._currentDocument?.uri.toString() ?? 'unknown',
                            index: message.index,
                            line: message.line ?? null,
                            details: message.message ?? 'Unknown error'
                        });
                        break;
                    case 'webviewError':
                        this._logger.logError('Webview runtime error', {
                            document: this._currentDocument?.uri.toString() ?? 'unknown',
                            message: message.message ?? 'Unknown error',
                            stack: message.stack ?? 'no-stack'
                        });
                        break;
                    case 'lifecycleEvent':
                        this._logger.logInfo('Webview lifecycle event', {
                            document: this._currentDocument?.uri.toString() ?? 'unknown',
                            status: message.status ?? 'unknown',
                            detail: message.documentId ?? 'unknown'
                        });
                        break;
                    case 'changeAppearance':
                        this._handleAppearanceChange(message.appearance as PreviewAppearance);
                        break;
                }
            },
            null,
            this._disposables
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

    private _matches(document: vscode.TextDocument, mode: PreviewMode, lineNumber?: number): boolean {
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
            return lineNumber >= this._singleBlockStartLine && lineNumber <= this._singleBlockEndLine;
        }

        if (typeof this._singleLine === 'number') {
            return lineNumber === this._singleLine;
        }

        return false;
    }

    public updateContent(document: vscode.TextDocument) {
        if (this._isDisposed) {
            this._logger.logWarning('updateContent ignored because panel is disposed');
            return;
        }

        if (document.uri.toString() !== this._documentUri) {
            return;
        }

        this._currentDocument = document;

        // Clear existing timeout
        if (this._updateTimeout) {
            clearTimeout(this._updateTimeout);
        }

        // Get refresh delay from config
        const config = vscode.workspace.getConfiguration('mermaidLens');
        const delay = config.get<number>('refreshDelay', 500);

        // Debounce updates
        this._updateTimeout = setTimeout(() => {
            this._render();
        }, delay);
    }

    public handleSelectionChange(document: vscode.TextDocument, lineNumber: number) {
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
        const blockIndex = this._findBlockIndexForLine(document, lineNumber, blocks);

        if (typeof blockIndex !== 'number') {
            return;
        }

        if (typeof this._singleBlockIndex === 'number') {
            if (blockIndex !== this._singleBlockIndex) {
                return;
            }

            this._singleLine = lineNumber;
            return;
        }

        this._singleLine = lineNumber;
        this._singleBlockIndex = blockIndex;
        this._renderSingle(lineNumber, blocks);
    }

    private _handleThemeChange(theme: string) {
        // Persist the selection and update the preview
        const config = vscode.workspace.getConfiguration('mermaidLens');
        config.update('useVSCodeTheme', false, vscode.ConfigurationTarget.Global);
        config.update('theme', theme, vscode.ConfigurationTarget.Global);
        this._render(theme);
    }

    private _saveThemePreference(theme: string) {
        // Save to workspace or global settings
        const config = vscode.workspace.getConfiguration('mermaidLens');
        config.update('theme', theme, vscode.ConfigurationTarget.Global);
    }

    private async _handleAppearanceChange(appearance: PreviewAppearance) {
        const config = vscode.workspace.getConfiguration('mermaidLens');
        await config.update('previewAppearance', appearance, vscode.ConfigurationTarget.Global);
        this.refreshAppearance();
    }

    private async _handleExportDiagram(data: string, format: string, index: number) {
        this._logger.logDebug('Export', 'Handling export request', { format, index, dataLength: data?.length });

        // Show save dialog
        const filters: { [name: string]: string[] } = {};
        if (format === 'svg') {
            filters['SVG Image'] = ['svg'];
        } else if (format === 'png') {
            filters['PNG Image'] = ['png'];
        } else if (format === 'jpg') {
            filters['JPEG Image'] = ['jpg', 'jpeg'];
        }

        this._logger.logDebug('Export', 'Showing save dialog', { filters });
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`mermaid-diagram-${index + 1}.${format}`),
            filters: filters
        });

        this._logger.logInfo('Export dialog closed', { path: uri?.fsPath ?? 'cancelled' });

        if (!uri) {
            return; // User cancelled
        }

        // Write the file
        try {
            const buffer = Buffer.from(data, 'base64');
            await vscode.workspace.fs.writeFile(uri, buffer);
            vscode.window.showInformationMessage(`Diagram exported to ${uri.fsPath}`);
            this._logger.logInfo('Diagram exported successfully', { path: uri.fsPath });
        } catch (error) {
            this._logger.logError('Failed to export diagram', error instanceof Error ? error : new Error(String(error)));
            vscode.window.showErrorMessage(`Failed to export diagram: ${error}`);
        }
    }

    private _renderAll(overrideTheme?: string) {
        const webview = this._panel.webview;

        if (!this._currentDocument) {
            webview.html = this._getErrorHtml('No document to preview');
            return;
        }

        this._logger.logDebug('Render', 'Rendering all diagrams', {
            document: this._currentDocument.uri.toString(),
            mode: 'all'
        });
        const mermaidCode = this._extractMermaidCode(this._currentDocument);

        if (!mermaidCode) {
            webview.html = this._getErrorHtml(
                'No Mermaid diagram found. Wrap your diagram in ```mermaid code blocks.'
            );
            return;
        }

        const { theme, appearance } = this._resolveTheme(overrideTheme);
        webview.html = this._getHtmlForWebview(
            webview,
            mermaidCode,
            theme,
            appearance,
            this._currentDocument?.uri.toString()
        );
        this._updatePanelTitle();
    }

    private _renderSingle(lineNumber?: number, precomputedBlocks?: MermaidBlock[], overrideTheme?: string) {
        const webview = this._panel.webview;

        if (!this._currentDocument) {
            webview.html = this._getErrorHtml('No document to preview');
            return;
        }

        const blocks = precomputedBlocks ?? this._getMermaidBlocks(this._currentDocument);
        let targetIndex = this._singleBlockIndex;

        if (typeof targetIndex !== 'number' && typeof lineNumber === 'number') {
            targetIndex = this._findBlockIndexForLine(this._currentDocument, lineNumber, blocks);
            this._singleBlockIndex = targetIndex;
        }

        const targetBlock = typeof targetIndex === 'number' ? blocks[targetIndex] : undefined;

        if (!targetBlock) {
            this._singleBlockStartLine = undefined;
            this._singleBlockEndLine = undefined;
            this._updatePanelTitle();
            webview.html = this._getErrorHtml('No Mermaid diagram found at this position.');
            return;
        }

        this._logger.logDebug('Render', 'Rendering single diagram', {
            document: this._currentDocument.uri.toString(),
            mode: 'single',
            blockIndex: targetIndex
        });

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
            this._currentDocument?.uri.toString()
        );
        this._updatePanelTitle();
    }

    private _extractMermaidCode(document: vscode.TextDocument): string | null {
        const text = document.getText();
        this._logger.logDebug('MermaidDetection', 'Document snapshot', {
            length: text.length,
            preview: text.substring(0, 200)
        });

        const blocks = this._getMermaidBlocks(document, text);
        this._logger.logDebug('MermaidDetection', 'Number of matches found', { count: blocks.length });

        if (blocks.length === 0) {
            // Try alternative patterns to help debug
            const hasTripleBacktick = text.includes('```');
            const hasMermaidKeyword = text.includes('mermaid');
            this._logger.logDebug('MermaidDetection', 'Fallback flags', {
                hasTripleBacktick,
                hasMermaidKeyword
            });

            // Check for the pattern without newline requirements
            const simpleRegex = /```mermaid/g;
            const simpleMatches = [...text.matchAll(simpleRegex)];
            this._logger.logDebug('MermaidDetection', 'Simple pattern matches', { count: simpleMatches.length });

            return null;
        }

        const diagrams = blocks.map(block => block.code);

        this._logger.logDebug('MermaidDetection', 'Valid diagrams detected', { count: diagrams.length });

        if (!diagrams.length) {
            return null;
        }

        return JSON.stringify(diagrams);
    }

    private _extractMermaidCodeAtLine(document: vscode.TextDocument, lineNumber: number): string | null {
        const blocks = this._getMermaidBlocks(document);
        const index = this._findBlockIndexForLine(document, lineNumber, blocks);
        if (typeof index !== 'number') {
            return null;
        }
        return JSON.stringify([blocks[index].code]);
    }

    private _findBlockIndexForLine(
        document: vscode.TextDocument,
        lineNumber: number,
        precomputedBlocks?: MermaidBlock[]
    ): number | undefined {
        const blocks = precomputedBlocks ?? this._getMermaidBlocks(document);
        const idx = blocks.findIndex(block => lineNumber >= block.startLine && lineNumber <= block.endLine);
        return idx >= 0 ? idx : undefined;
    }

    private _getMermaidBlocks(document: vscode.TextDocument, cachedText?: string): MermaidBlock[] {
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

        const lineHint = this._mode === 'single'
            ? (this._singleBlockStartLine ?? this._singleLine)
            : undefined;
        this._panel.title = MermaidPreviewPanel._buildPanelTitle(
            this._currentDocument,
            this._mode,
            typeof lineHint === 'number' ? lineHint : undefined
        );
    }

    private _collectMermaidBlocks(document: vscode.TextDocument, text: string): MermaidBlock[] {
        const mermaidRegex = /```mermaid[^\S\r\n]*(?:\r?\n)([\s\S]*?)(?:\r?\n)?```/g;
        const blocks: MermaidBlock[] = [];
        let match;

        while ((match = mermaidRegex.exec(text)) !== null) {
            const diagramCode = match[1]?.trim();
            if (!diagramCode) {
                continue;
            }

            const startPos = document.positionAt(match.index);
            const endPos = document.positionAt(match.index + match[0].length);
            blocks.push({
                code: diagramCode,
                startLine: startPos.line,
                endLine: endPos.line
            });
        }

        return blocks;
    }

    private _resolveTheme(overrideTheme?: string): { theme: string; appearance: PreviewAppearance } {
        const config = vscode.workspace.getConfiguration('mermaidLens');
        const useVSCodeTheme = config.get<boolean>('useVSCodeTheme', false);
        const configuredTheme = config.get<string>('theme', 'default');
        const appearance = config.get<PreviewAppearance>('previewAppearance', 'matchVSCode');

        let theme = overrideTheme || configuredTheme;

        if (useVSCodeTheme && !overrideTheme) {
            if (appearance === 'light') {
                theme = 'default';
            } else if (appearance === 'dark') {
                theme = 'dark';
            } else {
                const colorTheme = vscode.window.activeColorTheme;
                theme = colorTheme.kind === vscode.ColorThemeKind.Dark ? 'dark' : 'default';
            }
        }

        return { theme, appearance };
    }

    private _generateNonce(): string {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
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
        documentId?: string
    ): string {
        const diagrams = JSON.parse(mermaidCode);
        const escapedDiagrams = diagrams.map((code: string) =>
            code.replace(/\\/g, '\\\\')
                .replace(/`/g, '\\`')
                .replace(/\$/g, '\\$')
        );
        const appearanceClass = this._getAppearanceClass(appearance);
        const mermaidScriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(
                this._extensionUri,
                'out',
                'mermaid',
                'dist',
                'mermaid.esm.min.mjs'
            )
        );
        this._logger.logDebug('Render', 'Resolved Mermaid runtime', {
            uri: mermaidScriptUri.toString()
        });

        const docId = documentId ?? 'unknown';
        const nonce = this._generateNonce();

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
        const diagrams = ${JSON.stringify(escapedDiagrams)};
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
                .replace(/\"/g, '&quot;');
        }

        function formatDiagramError(rawMessage) {
            const message = rawMessage || 'Unknown Mermaid error.';
            const lineMatch = /line\\s+(\\d+)/i.exec(message);
            const lineNumber = lineMatch ? Number(lineMatch[1]) : undefined;
            return { message, lineNumber };
        }

        function renderErrorCardHtml(info) {
            return (
                '<div class=\"diagram-error\">' +
                    '<div class=\"diagram-error__title\">Unable to render this diagram</div>' +
                    '<div class=\"diagram-error__message\">' + escapeHtml(info.message) + '</div>' +
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
            container.innerHTML = renderErrorCardHtml(info);
            reportRenderError(index, info);
        }

        async function validateDiagram(diagram, index) {
            try {
                await mermaid.parse(diagram);
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
            vscode.setState({ docStates });
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

            for (let i = 0; i < diagrams.length; i++) {
                lastParseError = null;
                const shell = document.createElement('div');
                shell.className = 'diagram-shell';
                shell.dataset.index = i.toString();
                shell.innerHTML = '<div class="diagram-content" id="diagram-' + i + '">Loading...</div>';
                container.appendChild(shell);
                shell.addEventListener('click', () => focusDiagram(i));

                if (!(await validateDiagram(diagrams[i], i))) {
                    continue;
                }

                try {
                    const { svg } = await mermaid.render('mermaid-' + i + '-' + Date.now(), diagrams[i]);
                    if (lastParseError) {
                        showRenderError(i, lastParseError);
                        lastParseError = null;
                        continue;
                    }
                    document.getElementById('diagram-' + i).innerHTML = svg;
                } catch (error) {
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
            }
        };

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

        function notifyExportError(message, format) {
            vscode.postMessage({
                command: 'exportError',
                format,
                error: message
            });
        }

        window.exportActiveDiagram = async function(format) {
            exportDiagram(activeDiagramIndex, format);
        };

        async function exportDiagram(index, format) {
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
                        const base64Data = await rasterizeSvg(svgEl, format);
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

        window.addEventListener('load', () => {
            stageEl = document.getElementById('diagram-stage');
            setBodyAppearance(currentAppearance);
            updateDropdownSelection('dropdown-theme', currentTheme);
            updateDropdownSelection('dropdown-appearance', currentAppearance);
            updateThemeButtonLabel(currentTheme);
            renderAllDiagrams();
            scheduleZoomUpdate();
            scheduleTransform();
            bindToolbarControls();
            vscode.postMessage({ command: 'lifecycleEvent', status: 'webviewLoaded', documentId });
        });

        function bindToolbarControls() {
            const actionMap = new Map([
                ['zoom-in', zoomIn],
                ['zoom-out', zoomOut],
                ['zoom-reset', zoomReset]
            ]);

            actionMap.forEach((handler, action) => {
                document.querySelectorAll('[data-action=\"' + action + '\"]').forEach(btn => {
                    btn.addEventListener('click', handler);
                });
            });

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
                if (format) {
                    btn.addEventListener('click', () => exportActiveDiagram(format));
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

        .diagram-indicator {
            font-size: 12px;
            font-weight: 600;
            min-width: 140px;
            text-align: center;
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
                <button data-export-format="svg">SVG</button>
                <button data-export-format="png">PNG</button>
                <button data-export-format="jpg">JPG</button>
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
