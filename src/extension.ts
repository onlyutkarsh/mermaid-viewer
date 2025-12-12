import * as vscode from 'vscode';
import { MermaidPreviewPanel } from './previewPanel';
import { Logger } from './util/logger';

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

class MermaidCodeLensProvider implements vscode.CodeLensProvider {
    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        return findMermaidFenceStartLines(document).map(line => {
            const position = new vscode.Position(line, 0);
            const range = new vscode.Range(position, position);
            const command: vscode.Command = {
                title: 'Preview Diagram',
                command: 'mermaid-preview.showDiagramAtPosition',
                arguments: [document.uri, line]
            };

            return new vscode.CodeLens(range, command);
        });
    }
}

class MermaidGutterDecorator implements vscode.Disposable {
    private readonly decorationType: vscode.TextEditorDecorationType;

    constructor(private readonly extensionUri: vscode.Uri) {
        const iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'mermaid-gutter.svg');
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
    logger.logInfo('Mermaid Preview extension activated');
    const gutterDecorator = new MermaidGutterDecorator(context.extensionUri);
    context.subscriptions.push(gutterDecorator);
    gutterDecorator.update(vscode.window.activeTextEditor);

    // Refresh preview when VS Code theme changes so appearance rules can be re-applied
    const themeChangeListener = vscode.window.onDidChangeActiveColorTheme(() => {
        MermaidPreviewPanel.currentPanel?.refreshAppearance();
    });
    context.subscriptions.push(themeChangeListener);

    const configChangeListener = vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('mermaidPreview.previewAppearance')) {
            MermaidPreviewPanel.currentPanel?.refreshAppearance();
        }
    });
    context.subscriptions.push(configChangeListener);

    // Register CodeLens provider
    const codeLensProvider = new MermaidCodeLensProvider();
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            { language: 'markdown', scheme: 'file' },
            codeLensProvider
        )
    );

    // Register command to show preview
    const showPreviewCommand = vscode.commands.registerCommand(
        'mermaid-preview.showPreview',
        () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                logger.logWarning('showPreview invoked without an active editor');
                vscode.window.showInformationMessage('Open a Markdown file containing Mermaid diagrams to preview them.');
                return;
            }

            if (editor.document.languageId !== 'markdown') {
                logger.logWarning('showPreview invoked for non-markdown document', {
                    languageId: editor.document.languageId,
                    uri: editor.document.uri.toString()
                });
                vscode.window.showInformationMessage('Mermaid Preview only works with Markdown files.');
                return;
            }

            const documentUri = editor.document.uri?.toString();
            logger.logDebug('Command', 'Opening preview', {
                command: 'mermaid-preview.showPreview',
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
        'mermaid-preview.showPreviewToSide',
        () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                logger.logWarning('showPreviewToSide invoked without an active editor');
                vscode.window.showInformationMessage('Open a Markdown file containing Mermaid diagrams to preview them.');
                return;
            }

            if (editor.document.languageId !== 'markdown') {
                logger.logWarning('showPreviewToSide invoked for non-markdown document', {
                    languageId: editor.document.languageId,
                    uri: editor.document.uri.toString()
                });
                vscode.window.showInformationMessage('Mermaid Preview only works with Markdown files.');
                return;
            }

            const documentUri = editor.document.uri?.toString();
            logger.logDebug('Command', 'Opening preview to the side', {
                command: 'mermaid-preview.showPreviewToSide',
                uri: documentUri ?? 'unknown'
            });

            MermaidPreviewPanel.createOrShow(
                context.extensionUri,
                editor.document,
                vscode.ViewColumn.Beside
            );
        }
    );

    // Register command to show diagram at specific position
    const showDiagramAtPositionCommand = vscode.commands.registerCommand(
        'mermaid-preview.showDiagramAtPosition',
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
                } else {
                    const editor = vscode.window.activeTextEditor;
                    if (!editor) {
                        logger.logError('showDiagramAtPosition called without a URI and no active editor');
                        vscode.window.showErrorMessage('Unable to preview diagram: no document context available.');
                        return;
                    }

                    document = editor.document;
                    if (typeof targetLine !== 'number') {
                        targetLine = editor.selection.active.line;
                        logger.logDebug('Command', 'Using active editor selection for diagram preview', {
                            inferredLine: targetLine
                        });
                    }
                }

                if (!document) {
                    logger.logError('showDiagramAtPosition could not resolve a document');
                    vscode.window.showErrorMessage('Unable to preview diagram: document could not be determined.');
                    return;
                }

                if (document.languageId !== 'markdown') {
                    logger.logWarning('showDiagramAtPosition invoked for non-markdown document', {
                        languageId: document.languageId,
                        uri: document.uri.toString()
                    });
                    vscode.window.showInformationMessage('Mermaid Preview only works with Markdown files.');
                    return;
                }

                if (typeof targetLine !== 'number') {
                    logger.logError('showDiagramAtPosition missing line information even after fallback');
                    vscode.window.showErrorMessage('Unable to preview diagram: missing line information.');
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
                vscode.window.showErrorMessage('Unable to open document for Mermaid preview. See output for details.');
            }
        }
    );

    // Watch for document changes
    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
        gutterDecorator.updateForDocument(e.document);

        const config = vscode.workspace.getConfiguration('mermaidPreview');
        const autoRefresh = config.get<boolean>('autoRefresh', true);

        // Only update if it's a markdown file
        if (autoRefresh && e.document.languageId === 'markdown' && MermaidPreviewPanel.currentPanel) {
            MermaidPreviewPanel.currentPanel.updateContent(e.document);
        }
    });

    // Watch for active editor changes
    const changeActiveEditorSubscription = vscode.window.onDidChangeActiveTextEditor((editor) => {
        gutterDecorator.update(editor);

        // Only update if it's a markdown file
        if (editor && editor.document.languageId === 'markdown' && MermaidPreviewPanel.currentPanel) {
            MermaidPreviewPanel.currentPanel.updateContent(editor.document);
        }
    });

    const visibleEditorsSubscription = vscode.window.onDidChangeVisibleTextEditors((editors) => {
        editors.forEach(editor => gutterDecorator.update(editor));
    });

    context.subscriptions.push(
        showPreviewCommand,
        showPreviewToSideCommand,
        showDiagramAtPositionCommand,
        changeDocumentSubscription,
        changeActiveEditorSubscription,
        visibleEditorsSubscription
    );
}

export function deactivate() {}
