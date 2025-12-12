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
            if (editor) {
                MermaidPreviewPanel.createOrShow(
                    context.extensionUri,
                    editor.document,
                    vscode.ViewColumn.Active
                );
            }
        }
    );

    // Register command to show preview to the side
    const showPreviewToSideCommand = vscode.commands.registerCommand(
        'mermaid-preview.showPreviewToSide',
        () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                MermaidPreviewPanel.createOrShow(
                    context.extensionUri,
                    editor.document,
                    vscode.ViewColumn.Beside
                );
            }
        }
    );

    // Register command to show diagram at specific position
    const showDiagramAtPositionCommand = vscode.commands.registerCommand(
        'mermaid-preview.showDiagramAtPosition',
        async (uri: vscode.Uri, line: number) => {
            const document = await vscode.workspace.openTextDocument(uri);
            MermaidPreviewPanel.createOrShowSingle(
                context.extensionUri,
                document,
                line,
                vscode.ViewColumn.Beside
            );
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
