import * as vscode from 'vscode';
import { MermaidPreviewPanel } from './previewPanel';
import { Logger } from './util/logger';
import { MermaidFoldingProvider } from './foldingProvider';

function findMermaidFenceStartLines(document: vscode.TextDocument): number[] {
    const text = document.getText();
    const mermaidRegex = /```mermaid[^\S\r\n]*(?:\r?\n)/g;
    const lines: number[] = [];

    let match: RegExpExecArray | null;
    while ((match = mermaidRegex.exec(text)) !== null) {
        const startPos = document.positionAt(match.index);
        lines.push(startPos.line);
    }

    return lines;
}

function getMermaidBlockAtLine(document: vscode.TextDocument, line: number): string | undefined {
    const text = document.getText();

    // For standalone .mmd or .mermaid files, return entire content
    if (document.languageId === 'mermaid') {
        return text.trim();
    }

    // For markdown files, extract mermaid code blocks
    const mermaidRegex = /```mermaid[^\S\r\n]*(?:\r?\n)([\s\S]*?)(?:\r?\n)?```/g;
    let match: RegExpExecArray | null;

    while ((match = mermaidRegex.exec(text)) !== null) {
        const startPos = document.positionAt(match.index);
        const endPos = document.positionAt(match.index + match[0].length);

        if (line >= startPos.line && line <= endPos.line) {
            const block = match[1] ?? '';
            return block.trim();
        }
    }

    return undefined;
}

class MermaidCodeLensProvider implements vscode.CodeLensProvider {
    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const lenses: vscode.CodeLens[] = [];

        // For standalone .mmd/.mermaid files, add CodeLens at the top
        if (document.languageId === 'mermaid') {
            const position = new vscode.Position(0, 0);
            const range = new vscode.Range(position, position);

            const previewCommand: vscode.Command = {
                title: 'Preview Diagram',
                command: 'mermaidLivePreview.showPreviewToSide',
                arguments: []
            };

            const copyCommand: vscode.Command = {
                title: 'Copy Mermaid Code',
                command: 'mermaidLivePreview.copyDiagramCode',
                arguments: [document.uri, 0]
            };

            lenses.push(new vscode.CodeLens(range, previewCommand));
            lenses.push(new vscode.CodeLens(range, copyCommand));
            return lenses;
        }

        // For markdown files, find mermaid code blocks
        for (const line of findMermaidFenceStartLines(document)) {
            const position = new vscode.Position(line, 0);
            const range = new vscode.Range(position, position);
            const command: vscode.Command = {
                title: 'Preview Diagram',
                command: 'mermaidLivePreview.showDiagramAtPosition',
                arguments: [document.uri, line]
            };

            const copyCommand: vscode.Command = {
                title: 'Copy Mermaid Code',
                command: 'mermaidLivePreview.copyDiagramCode',
                arguments: [document.uri, line]
            };

            lenses.push(new vscode.CodeLens(range, command));
            lenses.push(new vscode.CodeLens(range, copyCommand));
        }

        return lenses;
    }
}

class MermaidGutterDecorator implements vscode.Disposable {
    private readonly decorationType: vscode.TextEditorDecorationType;

    constructor(private readonly extensionUri: vscode.Uri) {
        const iconPath = vscode.Uri.joinPath(extensionUri, 'images', 'mermaid-gutter.svg');
        this.decorationType = vscode.window.createTextEditorDecorationType({
            gutterIconPath: iconPath,
            gutterIconSize: 'contain'
        });
    }

    public update(editor?: vscode.TextEditor) {
        if (!editor) {
            return;
        }

        if (editor.document.languageId !== 'markdown') {
            editor.setDecorations(this.decorationType, []);
            return;
        }

        const decorations = findMermaidFenceStartLines(editor.document).map(line => ({
            range: new vscode.Range(line, 0, line, 0),
            hoverMessage: 'Mermaid diagram'
        }));
        editor.setDecorations(this.decorationType, decorations);
    }

    public updateForDocument(document: vscode.TextDocument) {
        vscode.window.visibleTextEditors
            .filter(editor => editor.document === document)
            .forEach(editor => this.update(editor));
    }

    public dispose() {
        this.decorationType.dispose();
    }
}

export function activate(context: vscode.ExtensionContext) {
    const logger = Logger.instance;
    context.subscriptions.push(logger);
    logger.logInfo('Mermaid Viewer extension activated');
    const gutterDecorator = new MermaidGutterDecorator(context.extensionUri);
    context.subscriptions.push(gutterDecorator);
    gutterDecorator.update(vscode.window.activeTextEditor);

    // Refresh preview when VS Code theme changes so appearance rules can be re-applied
    const themeChangeListener = vscode.window.onDidChangeActiveColorTheme(() => {
        MermaidPreviewPanel.forEachPanel(panel => panel.refreshAppearance());
    });
    context.subscriptions.push(themeChangeListener);

    const configChangeListener = vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('mermaidLivePreview.previewAppearance')) {
            MermaidPreviewPanel.forEachPanel(panel => panel.refreshAppearance());
        }
    });
    context.subscriptions.push(configChangeListener);

    // Register CodeLens provider for both markdown and mermaid files
    const codeLensProvider = new MermaidCodeLensProvider();
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            { language: 'markdown', scheme: 'file' },
            codeLensProvider
        ),
        vscode.languages.registerCodeLensProvider(
            { language: 'mermaid', scheme: 'file' },
            codeLensProvider
        ),
        vscode.languages.registerCodeLensProvider(
            { language: 'mermaid', scheme: 'untitled' },
            codeLensProvider
        )
    );

    // Register Folding provider for Mermaid files
    const foldingProvider = new MermaidFoldingProvider();
    context.subscriptions.push(
        vscode.languages.registerFoldingRangeProvider(
            { language: 'mermaid', scheme: 'file' },
            foldingProvider
        ),
        vscode.languages.registerFoldingRangeProvider(
            { language: 'mermaid', scheme: 'untitled' },
            foldingProvider
        )
    );

    const copyDiagramCodeCommand = vscode.commands.registerCommand(
        'mermaidLivePreview.copyDiagramCode',
        async (uri: vscode.Uri | undefined, line: number | undefined) => {
            logger.logDebug('Command', 'copyDiagramCode invoked', {
                uri: uri?.toString() ?? 'undefined',
                line: line ?? 'undefined'
            });

            try {
                let document: vscode.TextDocument | undefined;
                let targetLine = line;

                if (uri) {
                    document = await vscode.workspace.openTextDocument(uri);
                } else if (vscode.window.activeTextEditor) {
                    document = vscode.window.activeTextEditor.document;
                    if (typeof targetLine !== 'number') {
                        targetLine = vscode.window.activeTextEditor.selection.active.line;
                    }
                }

                if (!document) {
                    logger.logError('copyDiagramCode could not resolve a document');
                    vscode.window.showErrorMessage('Unable to copy Mermaid diagram: no document context available.');
                    return;
                }

                if (document.languageId !== 'markdown' && document.languageId !== 'mermaid') {
                    logger.logWarning('copyDiagramCode invoked for unsupported document', {
                        languageId: document.languageId,
                        uri: document.uri.toString()
                    });
                    vscode.window.showInformationMessage('Mermaid Viewer only works with Markdown and Mermaid files.');
                    return;
                }

                if (typeof targetLine !== 'number') {
                    logger.logError('copyDiagramCode missing line information');
                    vscode.window.showErrorMessage('Unable to copy Mermaid diagram: missing line information.');
                    return;
                }

                const blockCode = getMermaidBlockAtLine(document, targetLine);
                if (!blockCode) {
                    vscode.window.showInformationMessage('No Mermaid diagram found at this location to copy.');
                    return;
                }

                await vscode.env.clipboard.writeText(blockCode);
                logger.logInfo('Copied Mermaid diagram to clipboard', {
                    command: 'copyDiagramCode',
                    line: targetLine,
                    length: blockCode.length
                });
                vscode.window.showInformationMessage('Mermaid diagram copied to the clipboard.');
            } catch (error) {
                logger.logError(
                    'Failed to copy Mermaid diagram code',
                    error instanceof Error ? error : new Error(String(error))
                );
                vscode.window.showErrorMessage('Unable to copy Mermaid diagram. See output for details.');
            }
        }
    );

    // Register command to show preview
    const showPreviewCommand = vscode.commands.registerCommand(
        'mermaidLivePreview.showPreview',
        () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                logger.logWarning('showPreview invoked without an active editor');
                vscode.window.showInformationMessage('Open a Markdown or Mermaid file containing diagrams to preview them.');
                return;
            }

            if (editor.document.languageId !== 'markdown' && editor.document.languageId !== 'mermaid') {
                logger.logWarning('showPreview invoked for unsupported document', {
                    languageId: editor.document.languageId,
                    uri: editor.document.uri.toString()
                });
                vscode.window.showInformationMessage('Mermaid Viewer only works with Markdown and Mermaid files.');
                return;
            }

            const documentUri = editor.document.uri?.toString();
            logger.logDebug('Command', 'Opening preview', {
                command: 'mermaidLivePreview.showPreview',
                uri: documentUri ?? 'unknown'
            });

            MermaidPreviewPanel.createOrShow(
                context.extensionUri,
                editor.document,
                vscode.ViewColumn.Active
            );
        }
    );

    // Register command to show preview to the side
    const showPreviewToSideCommand = vscode.commands.registerCommand(
        'mermaidLivePreview.showPreviewToSide',
        () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                logger.logWarning('showPreviewToSide invoked without an active editor');
                vscode.window.showInformationMessage('Open a Markdown or Mermaid file containing diagrams to preview them.');
                return;
            }

            if (editor.document.languageId !== 'markdown' && editor.document.languageId !== 'mermaid') {
                logger.logWarning('showPreviewToSide invoked for unsupported document', {
                    languageId: editor.document.languageId,
                    uri: editor.document.uri.toString()
                });
                vscode.window.showInformationMessage('Mermaid Viewer only works with Markdown and Mermaid files.');
                return;
            }

            const documentUri = editor.document.uri?.toString();
            logger.logDebug('Command', 'Opening preview to the side', {
                command: 'mermaidLivePreview.showPreviewToSide',
                uri: documentUri ?? 'unknown'
            });

            MermaidPreviewPanel.createOrShow(
                context.extensionUri,
                editor.document,
                vscode.ViewColumn.Beside
            );
        }
    );

    const showDiagramAtPositionCommand = vscode.commands.registerCommand(
        'mermaidLivePreview.showDiagramAtPosition',
        async (uri: vscode.Uri | undefined, line: number | undefined) => {
            logger.logDebug('Command', 'showDiagramAtPosition invoked', {
                uri: uri?.toString() ?? 'undefined',
                line: line ?? 'undefined'
            });

            try {
                let document: vscode.TextDocument | undefined;
                let targetLine = line;

                if (uri) {
                    document = await vscode.workspace.openTextDocument(uri);
                } else if (vscode.window.activeTextEditor) {
                    document = vscode.window.activeTextEditor.document;
                    if (typeof targetLine !== 'number') {
                        targetLine = vscode.window.activeTextEditor.selection.active.line;
                    }
                }

                if (!document) {
                    logger.logError('showDiagramAtPosition could not resolve a document');
                    vscode.window.showErrorMessage('Unable to open diagram preview: no document context available.');
                    return;
                }

                if (document.languageId !== 'markdown' && document.languageId !== 'mermaid') {
                    logger.logWarning('showDiagramAtPosition invoked for unsupported document', {
                        languageId: document.languageId,
                        uri: document.uri.toString()
                    });
                    vscode.window.showInformationMessage('Mermaid Viewer only works with Markdown and Mermaid files.');
                    return;
                }

                if (typeof targetLine !== 'number') {
                    logger.logError('showDiagramAtPosition missing line information');
                    vscode.window.showErrorMessage('Unable to open diagram preview: missing line information.');
                    return;
                }

                MermaidPreviewPanel.createOrShowSingle(
                    context.extensionUri,
                    document,
                    targetLine,
                    vscode.ViewColumn.Beside
                );
            } catch (error) {
                logger.logError('Failed to open document for showDiagramAtPosition', error instanceof Error ? error : new Error(String(error)));
                vscode.window.showErrorMessage('Unable to open Mermaid diagram preview. See output for details.');
            }
        }
    );

    // Watch for document changes
    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
        gutterDecorator.updateForDocument(e.document);

        const config = vscode.workspace.getConfiguration('mermaidLivePreview');
        const autoRefresh = config.get<boolean>('autoRefresh', true);

        // Update if it's a markdown or mermaid file
        const isSupported = e.document.languageId === 'markdown' || e.document.languageId === 'mermaid';
        if (autoRefresh && isSupported && MermaidPreviewPanel.hasOpenPanels()) {
            MermaidPreviewPanel.forEachPanel(panel => panel.updateContent(e.document));
        }
    });

    // Watch for active editor changes
    const changeActiveEditorSubscription = vscode.window.onDidChangeActiveTextEditor((editor) => {
        gutterDecorator.update(editor);

        // Update if it's a markdown or mermaid file
        if (editor) {
            const isSupported = editor.document.languageId === 'markdown' || editor.document.languageId === 'mermaid';
            if (isSupported && MermaidPreviewPanel.hasOpenPanels()) {
                MermaidPreviewPanel.forEachPanel(panel => panel.updateContent(editor.document));
            }
        }
    });

    const visibleEditorsSubscription = vscode.window.onDidChangeVisibleTextEditors((editors) => {
        editors.forEach(editor => gutterDecorator.update(editor));
    });

    const selectionChangeSubscription = vscode.window.onDidChangeTextEditorSelection((event) => {
        if (!MermaidPreviewPanel.hasOpenPanels()) {
            return;
        }

        const editor = event.textEditor;
        const isSupported = editor.document.languageId === 'markdown' || editor.document.languageId === 'mermaid';
        if (!isSupported) {
            return;
        }

        const activeLine = event.selections[0]?.active.line;
        if (typeof activeLine !== 'number') {
            return;
        }

        MermaidPreviewPanel.forEachPanel(panel => panel.handleSelectionChange(editor.document, activeLine));
    });

    context.subscriptions.push(
        showPreviewCommand,
        showPreviewToSideCommand,
        showDiagramAtPositionCommand,
        copyDiagramCodeCommand,
        changeDocumentSubscription,
        changeActiveEditorSubscription,
        visibleEditorsSubscription,
        selectionChangeSubscription
    );
}

export function deactivate() {}
