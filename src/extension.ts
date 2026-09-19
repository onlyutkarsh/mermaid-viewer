import * as path from 'node:path';
import * as vscode from 'vscode';
import { MermaidFoldingProvider } from './foldingProvider';
import {
	findMermaidFormatIssues,
	formatMermaidCode,
	formatMermaidDocument,
} from './formatter';
import {
	createMarkdownItPlugin,
	type MarkdownItLike,
	registerMarkdownPlugin,
} from './markdownPlugin';
import { MermaidPreviewPanel, MermaidPreviewSerializer } from './previewPanel';
import { Logger } from './util/logger';

const SHORT_MONTH_NAMES = [
	'Jan',
	'Feb',
	'Mar',
	'Apr',
	'May',
	'Jun',
	'Jul',
	'Aug',
	'Sep',
	'Oct',
	'Nov',
	'Dec',
];

function formatDateToken(pattern: string, date: Date): string {
	const pad = (value: number, width = 2) => String(value).padStart(width, '0');
	const tokens: Record<string, string> = {
		yyyy: String(date.getFullYear()),
		yy: pad(date.getFullYear() % 100),
		MMM: SHORT_MONTH_NAMES[date.getMonth()],
		MM: pad(date.getMonth() + 1),
		dd: pad(date.getDate()),
		HH: pad(date.getHours()),
		mm: pad(date.getMinutes()),
		ss: pad(date.getSeconds()),
	};
	return pattern.replace(
		/yyyy|yy|MMM|MM|dd|HH|mm|ss/g,
		(match) => tokens[match],
	);
}

function findMermaidBlockStartLines(document: vscode.TextDocument): number[] {
	const text = document.getText();
	const fencedRegex = /```mermaid[^\S\r\n]*(?:\r?\n)/g;
	const adoRegex = /:::\s*mermaid[^\S\r\n]*(?:\r?\n)/gm;
	const lines: number[] = [];

	let match: RegExpExecArray | null = fencedRegex.exec(text);
	while (match !== null) {
		const startPos = document.positionAt(match.index);
		lines.push(startPos.line);
		match = fencedRegex.exec(text);
	}

	match = adoRegex.exec(text);
	while (match !== null) {
		const startPos = document.positionAt(match.index);
		lines.push(startPos.line);
		match = adoRegex.exec(text);
	}

	return [...new Set(lines)].sort((a, b) => a - b);
}

function getMermaidBlockAtLine(
	document: vscode.TextDocument,
	line: number,
): string | undefined {
	const text = document.getText();

	// For standalone .mmd or .mermaid files, return entire content
	if (document.languageId === 'mermaid') {
		return text.trim();
	}

	// For markdown files, extract mermaid code blocks
	const fencedRegex = /```mermaid[^\S\r\n]*(?:\r?\n)([\s\S]*?)(?:\r?\n)?```/g;
	let match: RegExpExecArray | null = fencedRegex.exec(text);

	while (match !== null) {
		const startPos = document.positionAt(match.index);
		const endPos = document.positionAt(match.index + match[0].length);

		if (line >= startPos.line && line <= endPos.line) {
			const block = match[1] ?? '';
			return block.trim();
		}
		match = fencedRegex.exec(text);
	}

	// For markdown files, extract ADO container blocks :::mermaid ... :::
	const adoRegex = /:::\s*mermaid\s*\r?\n([\s\S]*?)\r?\n:::/g;
	match = adoRegex.exec(text);
	while (match !== null) {
		const startPos = document.positionAt(match.index);
		const endPos = document.positionAt(match.index + match[0].length);

		if (line >= startPos.line && line <= endPos.line) {
			const block = match[1] ?? '';
			return block.trim();
		}
		match = adoRegex.exec(text);
	}

	return undefined;
}

type MermaidBlockRange = {
	fullRange: vscode.Range;
	codeRange: vscode.Range;
	code: string;
};

function collectMermaidBlockRanges(
	document: vscode.TextDocument,
): MermaidBlockRange[] {
	const text = document.getText();

	const patterns: { block: RegExp; open: RegExp }[] = [
		{
			block: /```mermaid[^\S\r\n]*(?:\r?\n)([\s\S]*?)(?:\r?\n)?```/g,
			open: /^```mermaid[^\S\r\n]*\r?\n/,
		},
		{
			block: /:::\s*mermaid\s*\r?\n([\s\S]*?)\r?\n:::/g,
			open: /^:::\s*mermaid\s*\r?\n/,
		},
	];

	const blocks: MermaidBlockRange[] = [];
	for (const { block, open } of patterns) {
		let match: RegExpExecArray | null = block.exec(text);
		while (match !== null) {
			const inner = match[1] ?? '';
			const openLength = match[0].match(open)?.[0].length ?? 0;
			const innerStart = match.index + openLength;
			blocks.push({
				fullRange: new vscode.Range(
					document.positionAt(match.index),
					document.positionAt(match.index + match[0].length),
				),
				codeRange: new vscode.Range(
					document.positionAt(innerStart),
					document.positionAt(innerStart + inner.length),
				),
				code: inner,
			});
			match = block.exec(text);
		}
	}
	return blocks;
}

function findMermaidBlockRangeAtLine(
	document: vscode.TextDocument,
	line: number,
): MermaidBlockRange | undefined {
	return collectMermaidBlockRanges(document).find(
		(b) => line >= b.fullRange.start.line && line <= b.fullRange.end.line,
	);
}

// All per-line formatting issues in the document, mapped to absolute document
// line numbers. Used for diagnostics (squiggles), the per-issue "Fix" CodeLens,
// and the single-line fix command.
function collectDocumentFormatIssues(
	document: vscode.TextDocument,
): { line: number; expected: string }[] {
	if (document.languageId === 'mermaid') {
		return findMermaidFormatIssues(document.getText());
	}

	const issues: { line: number; expected: string }[] = [];
	for (const block of collectMermaidBlockRanges(document)) {
		const base = block.codeRange.start.line;
		for (const issue of findMermaidFormatIssues(block.code)) {
			issues.push({ line: base + issue.line, expected: issue.expected });
		}
	}
	return issues;
}

// A WorkspaceEdit that fully formats every Mermaid diagram in the document, or
// undefined if nothing needs changing. Backs the source.fixAll action used by
// editor.codeActionsOnSave.
function buildFormatAllEdit(
	document: vscode.TextDocument,
): vscode.WorkspaceEdit | undefined {
	const edit = new vscode.WorkspaceEdit();
	let changed = false;

	if (document.languageId === 'mermaid') {
		const text = document.getText();
		const formatted = formatMermaidDocument(text);
		if (formatted !== text) {
			edit.replace(
				document.uri,
				new vscode.Range(
					document.positionAt(0),
					document.positionAt(text.length),
				),
				formatted,
			);
			changed = true;
		}
	} else {
		for (const block of collectMermaidBlockRanges(document)) {
			const formatted = formatMermaidCode(block.code);
			if (formatted !== block.code) {
				edit.replace(document.uri, block.codeRange, formatted);
				changed = true;
			}
		}
	}

	return changed ? edit : undefined;
}

function stripStandaloneMermaidFrontMatter(text: string): string {
	const normalizedText = text.trim();
	if (!normalizedText.startsWith('---')) {
		return normalizedText;
	}

	const lines = normalizedText.split(/\r?\n/);
	if (lines[0]?.trim() !== '---') {
		return normalizedText;
	}

	let closingLine = -1;
	for (let lineIndex = 1; lineIndex < lines.length; lineIndex++) {
		const currentLine = lines[lineIndex]?.trim();
		if (currentLine === '---' || currentLine === '...') {
			closingLine = lineIndex;
			break;
		}
	}

	if (closingLine === -1) {
		return normalizedText;
	}

	return lines
		.slice(closingLine + 1)
		.join('\n')
		.trim();
}

function getMermaidBlockWithoutFrontMatter(
	document: vscode.TextDocument,
): string | undefined {
	if (document.languageId !== 'mermaid') {
		return undefined;
	}

	const text = document.getText();
	return stripStandaloneMermaidFrontMatter(text);
}

class MermaidCodeLensProvider implements vscode.CodeLensProvider {
	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const lenses: vscode.CodeLens[] = [];

		// For standalone .mmd/.mermaid files, add CodeLens at the top
		if (document.languageId === 'mermaid') {
			const position = new vscode.Position(0, 0);
			const range = new vscode.Range(position, position);

			const previewCommand: vscode.Command = {
				title: 'Preview',
				command: 'mermaidViewer.showPreviewToSide',
				arguments: [],
			};

			const copyCommand: vscode.Command = {
				title: 'Copy',
				command: 'mermaidViewer.copyDiagramCode',
				arguments: [document.uri],
			};

			const formatCommand: vscode.Command = {
				title: 'Format',
				command: 'mermaidViewer.formatDiagram',
				arguments: [document.uri],
			};

			lenses.push(new vscode.CodeLens(range, previewCommand));
			lenses.push(new vscode.CodeLens(range, copyCommand));
			lenses.push(new vscode.CodeLens(range, formatCommand));
			return lenses;
		}

		// For markdown files, find mermaid code blocks
		for (const line of findMermaidBlockStartLines(document)) {
			const position = new vscode.Position(line, 0);
			const range = new vscode.Range(position, position);
			const command: vscode.Command = {
				title: 'Preview',
				command: 'mermaidViewer.showDiagramAtPosition',
				arguments: [document.uri, line],
			};

			const copyCommand: vscode.Command = {
				title: 'Copy',
				command: 'mermaidViewer.copyDiagramCode',
				arguments: [document.uri, line],
			};

			const formatCommand: vscode.Command = {
				title: 'Format',
				command: 'mermaidViewer.formatDiagram',
				arguments: [document.uri, line],
			};

			lenses.push(new vscode.CodeLens(range, command));
			lenses.push(new vscode.CodeLens(range, copyCommand));
			lenses.push(new vscode.CodeLens(range, formatCommand));
		}

		return lenses;
	}
}

// Code actions for formatting:
//  - a source.fixAll action that formats every diagram in the document, so it
//    can be enabled on save via editor.codeActionsOnSave; and
//  - per-line Quick Fixes on the formatting squiggles (lightbulb).
class MermaidFormatCodeActionProvider implements vscode.CodeActionProvider {
	static readonly fixAllKind =
		vscode.CodeActionKind.SourceFixAll.append('mermaidViewer');

	static readonly providedCodeActionKinds = [
		vscode.CodeActionKind.QuickFix,
		MermaidFormatCodeActionProvider.fixAllKind,
	];

	provideCodeActions(
		document: vscode.TextDocument,
		range: vscode.Range | vscode.Selection,
		context: vscode.CodeActionContext,
	): vscode.CodeAction[] {
		const actions: vscode.CodeAction[] = [];

		// Source fix-all: only when a source action is requested (on save or the
		// "Source Action…" menu), so we don't compute edits for the lightbulb.
		if (context.only?.intersects(MermaidFormatCodeActionProvider.fixAllKind)) {
			const edit = buildFormatAllEdit(document);
			if (edit) {
				const fixAll = new vscode.CodeAction(
					'Format all Mermaid diagrams',
					MermaidFormatCodeActionProvider.fixAllKind,
				);
				fixAll.edit = edit;
				actions.push(fixAll);
			}
		}

		// Quick Fixes tied to the squiggles.
		const ourDiagnostics = context.diagnostics.filter(
			(d) => d.source === 'Mermaid Viewer' && d.code === 'unformatted',
		);
		const seenLines = new Set<number>();
		for (const diagnostic of ourDiagnostics) {
			const line = diagnostic.range.start.line;
			if (seenLines.has(line)) {
				continue;
			}
			seenLines.add(line);

			const fix = new vscode.CodeAction(
				'Fix formatting on this line',
				vscode.CodeActionKind.QuickFix,
			);
			fix.diagnostics = [diagnostic];
			fix.command = {
				title: 'Fix formatting on this line',
				command: 'mermaidViewer.fixFormatIssueAtLine',
				arguments: [document.uri, line],
			};
			actions.push(fix);
		}

		if (ourDiagnostics.length > 0) {
			const formatAll = new vscode.CodeAction(
				'Format Mermaid diagram',
				vscode.CodeActionKind.QuickFix,
			);
			formatAll.diagnostics = ourDiagnostics;
			formatAll.command = {
				title: 'Format Mermaid diagram',
				command: 'mermaidViewer.formatDiagram',
				arguments: [document.uri, range.start.line],
			};
			actions.push(formatAll);
		}

		return actions;
	}
}

class MermaidGutterDecorator implements vscode.Disposable {
	private readonly decorationType: vscode.TextEditorDecorationType;

	constructor(extensionUri: vscode.Uri) {
		const iconPath = vscode.Uri.joinPath(
			extensionUri,
			'images',
			'mermaid-gutter.svg',
		);
		this.decorationType = vscode.window.createTextEditorDecorationType({
			gutterIconPath: iconPath,
			gutterIconSize: 'contain',
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

		const decorations = findMermaidBlockStartLines(editor.document).map(
			(line) => ({
				range: new vscode.Range(line, 0, line, 0),
				hoverMessage: 'Mermaid diagram',
			}),
		);
		editor.setDecorations(this.decorationType, decorations);
	}

	public updateForDocument(document: vscode.TextDocument) {
		for (const editor of vscode.window.visibleTextEditors) {
			if (editor.document === document) {
				this.update(editor);
			}
		}
	}

	public dispose() {
		this.decorationType.dispose();
	}
}

export async function activate(context: vscode.ExtensionContext) {
	const logger = Logger.instance;
	const isUIContext =
		context.extension.extensionKind === vscode.ExtensionKind.UI;

	context.subscriptions.push(logger);
	logger.logInfo(
		`Mermaid Viewer extension activating (UI context: ${isUIContext})...`,
	);

	// Explicitly register the markdown-it plugin to ensure preview integration
	try {
		await registerMarkdownPlugin(context);
		logger.logInfo('Markdown-it plugin explicitly registered');
	} catch (error) {
		logger.logError(
			'Failed to explicitly register markdown-it plugin',
			error instanceof Error ? error : new Error(String(error)),
		);
	}

	// Register markdown-it plugin for native markdown preview support
	try {
		const _markdownItPlugin = createMarkdownItPlugin();
		// The plugin is automatically picked up by VS Code when:
		// 1. We declare "markdown.markdownItPlugins": true in package.json
		// 2. We export the extendMarkdownIt function
		logger.logInfo('Markdown-it plugin registered for native preview support');
	} catch (error) {
		logger.logError(
			'Failed to register markdown-it plugin',
			error instanceof Error ? error : new Error(String(error)),
		);
	}

	// Force-refresh any open markdown previews so they pick up our markdown-it
	// plugin (avoids race where preview opens before extendMarkdownIt is called).
	void vscode.commands.executeCommand('markdown.preview.refresh');

	// Register webview panel serializer for restoring panels after reload
	const serializer = new MermaidPreviewSerializer(context.extensionUri);
	context.subscriptions.push(
		vscode.window.registerWebviewPanelSerializer(
			MermaidPreviewPanel.viewType,
			serializer,
		),
	);

	// Only register gutter decorators in workspace context (not UI)
	let gutterDecorator: MermaidGutterDecorator | undefined;
	if (!isUIContext) {
		gutterDecorator = new MermaidGutterDecorator(context.extensionUri);
		context.subscriptions.push(gutterDecorator);
		gutterDecorator.update(vscode.window.activeTextEditor);
	}

	// Refresh preview when VS Code theme changes so appearance rules can be re-applied
	const themeChangeListener = vscode.window.onDidChangeActiveColorTheme(() => {
		MermaidPreviewPanel.forEachPanel((panel) => panel.refreshAppearance());
	});
	context.subscriptions.push(themeChangeListener);

	const configChangeListener = vscode.workspace.onDidChangeConfiguration(
		(event) => {
			if (event.affectsConfiguration('mermaidViewer.previewAppearance')) {
				if (MermaidPreviewPanel.consumeSuppressedAppearanceRefresh()) {
					return;
				}
				MermaidPreviewPanel.forEachPanel((panel) => panel.refreshAppearance());
			}
		},
	);
	context.subscriptions.push(configChangeListener);

	// Register CodeLens provider for both markdown and mermaid files
	const codeLensProvider = new MermaidCodeLensProvider();
	const foldingProvider = new MermaidFoldingProvider();

	// Batch all provider registrations
	context.subscriptions.push(
		vscode.languages.registerCodeLensProvider(
			[
				{ language: 'markdown', scheme: 'file' },
				{ language: 'mermaid', scheme: 'file' },
				{ language: 'mermaid', scheme: 'untitled' },
			],
			codeLensProvider,
		),
		vscode.languages.registerFoldingRangeProvider(
			[
				{ language: 'mermaid', scheme: 'file' },
				{ language: 'mermaid', scheme: 'untitled' },
			],
			foldingProvider,
		),
		vscode.languages.registerCodeActionsProvider(
			[
				{ language: 'markdown', scheme: 'file' },
				{ language: 'mermaid', scheme: 'file' },
				{ language: 'mermaid', scheme: 'untitled' },
			],
			new MermaidFormatCodeActionProvider(),
			{
				providedCodeActionKinds:
					MermaidFormatCodeActionProvider.providedCodeActionKinds,
			},
		),
		vscode.languages.registerDocumentFormattingEditProvider(
			[
				{ language: 'mermaid', scheme: 'file' },
				{ language: 'mermaid', scheme: 'untitled' },
			],
			{
				provideDocumentFormattingEdits(document) {
					const text = document.getText();
					const formatted = formatMermaidDocument(text);
					const changed = formatted !== text;
					logger.logInfo('Format Document triggered for Mermaid file', {
						source: 'documentFormattingProvider',
						uri: document.uri.toString(),
						changed,
					});
					if (!changed) {
						return [];
					}
					const fullRange = new vscode.Range(
						document.positionAt(0),
						document.positionAt(text.length),
					);
					return [vscode.TextEdit.replace(fullRange, formatted)];
				},
			},
		),
	);

	const getActiveSupportedEditor = (
		commandName: 'showPreview' | 'showPreviewToSide' | 'showPreviewInNewWindow',
	): vscode.TextEditor | undefined => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			// Cross-platform guard:
			// Do NOT fall back to visibleTextEditors/panel scans when no editor is
			// active. Webview focus semantics differ by platform (notably Windows) and
			// those fallbacks can activate a mismatched document preview.
			logger.logWarning(`${commandName} invoked without an active editor`);
			vscode.window.showInformationMessage(
				'Open a Markdown or Mermaid file containing diagrams to preview them.',
			);
			return undefined;
		}

		if (
			editor.document.languageId !== 'markdown' &&
			editor.document.languageId !== 'mermaid'
		) {
			logger.logWarning(`${commandName} invoked for unsupported document`, {
				languageId: editor.document.languageId,
				uri: editor.document.uri.toString(),
			});
			vscode.window.showInformationMessage(
				'Mermaid Viewer only works with Markdown and Mermaid files.',
			);
			return undefined;
		}

		return editor;
	};

	async function copyMermaidSourceToClipboard(
		uri: vscode.Uri | undefined,
		line: number | undefined,
		commandName: string,
		options?: { wrapper?: string },
	): Promise<void> {
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
				logger.logError(`${commandName} could not resolve a document`);
				vscode.window.showErrorMessage(
					'Unable to copy Mermaid diagram: no document context available.',
				);
				return;
			}

			if (
				document.languageId !== 'markdown' &&
				document.languageId !== 'mermaid'
			) {
				logger.logWarning(`${commandName} invoked for unsupported document`, {
					languageId: document.languageId,
					uri: document.uri.toString(),
				});
				vscode.window.showInformationMessage(
					'Mermaid Viewer only works with Markdown and Mermaid files.',
				);
				return;
			}

			if (typeof targetLine !== 'number') {
				if (document.languageId === 'mermaid') {
					targetLine = 0;
				} else {
					logger.logError(`${commandName} missing line information`);
					vscode.window.showErrorMessage(
						'Unable to copy Mermaid diagram: missing line information.',
					);
					return;
				}
			}

			const config = vscode.workspace.getConfiguration('mermaidViewer');
			const includeFrontMatter = config.get<boolean>(
				'copy.includeFrontMatter',
				true,
			);

			let rawCode: string | undefined;
			if (document.languageId === 'mermaid' && !includeFrontMatter) {
				rawCode = getMermaidBlockWithoutFrontMatter(document);
			} else {
				rawCode = getMermaidBlockAtLine(document, targetLine);
			}

			if (!rawCode) {
				vscode.window.showInformationMessage(
					'No Mermaid diagram found at this location to copy.',
				);
				return;
			}

			const rawWrapper = options?.wrapper ?? '';
			const fileName = path.basename(document.uri.fsPath);
			const wrapper = rawWrapper
				.replace(/\{\{fileName\}\}/g, fileName)
				.replace(/\{\{date:([^}]+)\}\}/g, (_match, datePattern) =>
					formatDateToken(datePattern, new Date()),
				);
			const textToCopy = (() => {
				if (!wrapper || wrapper.trim() === '') {
					return rawCode;
				}
				if (!wrapper.includes('{{mermaid-code}}')) {
					logger.logWarning(
						'copy.wrapper is set but missing {{mermaid-code}} placeholder; copying plain code',
						{ wrapper },
					);
					vscode.window.showWarningMessage(
						'Mermaid Viewer: copy.wrapper setting is missing the {{mermaid-code}} placeholder. Copied plain code instead. Update the setting in Preferences.',
					);
					return rawCode;
				}

				const [prefix, suffix] = wrapper.split('{{mermaid-code}}');
				const trimmedPrefix = prefix.trimEnd();
				const trimmedSuffix = suffix.trimStart();
				if (
					trimmedPrefix &&
					trimmedSuffix &&
					rawCode.startsWith(trimmedPrefix) &&
					rawCode.endsWith(trimmedSuffix)
				) {
					return rawCode;
				}

				return `${prefix}${rawCode}${suffix}`;
			})();

			await vscode.env.clipboard.writeText(textToCopy);
			logger.logInfo('Copied Mermaid diagram to clipboard', {
				command: commandName,
				line: targetLine,
				length: textToCopy.length,
			});
			vscode.window.showInformationMessage(
				commandName === 'copyDiagramCodeWithWrapper'
					? 'Mermaid diagram with wrapper copied to the clipboard.'
					: 'Mermaid diagram copied to the clipboard.',
			);
		} catch (error) {
			logger.logError(
				'Failed to copy Mermaid diagram code',
				error instanceof Error ? error : new Error(String(error)),
			);
			vscode.window.showErrorMessage(
				'Unable to copy Mermaid diagram. See output for details.',
			);
		}
	}

	const copyDiagramCodeCommand = vscode.commands.registerCommand(
		'mermaidViewer.copyDiagramCode',
		async (uri: vscode.Uri | undefined, line: number | undefined) => {
			const config = vscode.workspace.getConfiguration('mermaidViewer');
			const useWrapper = config.get<boolean>('copy.useWrapper', false);
			const wrapper = useWrapper
				? config.get<string>('copy.wrapper', '{{mermaid-code}}')
				: undefined;
			await copyMermaidSourceToClipboard(uri, line, 'copyDiagramCode', {
				wrapper,
			});
		},
	);

	const copyDiagramCodeWithWrapperCommand = vscode.commands.registerCommand(
		'mermaidViewer.copyDiagramCodeWithWrapper',
		async (uri: vscode.Uri | undefined, line: number | undefined) => {
			const config = vscode.workspace.getConfiguration('mermaidViewer');
			const wrapper = config.get<string>('copy.wrapper', '{{mermaid-code}}');
			await copyMermaidSourceToClipboard(
				uri,
				line,
				'copyDiagramCodeWithWrapper',
				{
					wrapper,
				},
			);
		},
	);

	const formatDiagramCommand = vscode.commands.registerCommand(
		'mermaidViewer.formatDiagram',
		async (uri: vscode.Uri | undefined, line: number | undefined) => {
			try {
				logger.logInfo('Format Diagram command triggered', {
					source: 'formatDiagramCommand',
					uri: uri?.toString(),
					line,
				});

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
					logger.logError('formatDiagram could not resolve a document');
					vscode.window.showErrorMessage(
						'Unable to format Mermaid diagram: no document context available.',
					);
					return;
				}

				if (
					document.languageId !== 'markdown' &&
					document.languageId !== 'mermaid'
				) {
					vscode.window.showInformationMessage(
						'Mermaid Viewer only works with Markdown and Mermaid files.',
					);
					return;
				}

				let range: vscode.Range;
				let code: string;
				let formatted: string;
				if (document.languageId === 'mermaid') {
					code = document.getText();
					range = new vscode.Range(
						document.positionAt(0),
						document.positionAt(code.length),
					);
					formatted = formatMermaidDocument(code);
				} else {
					if (typeof targetLine !== 'number') {
						vscode.window.showErrorMessage(
							'Unable to format Mermaid diagram: missing line information.',
						);
						return;
					}
					const block = findMermaidBlockRangeAtLine(document, targetLine);
					if (!block) {
						vscode.window.showInformationMessage(
							'No Mermaid diagram found at this location to format.',
						);
						return;
					}
					range = block.codeRange;
					code = block.code;
					formatted = formatMermaidCode(code);
				}

				if (formatted === code) {
					vscode.window.showInformationMessage(
						'Mermaid diagram is already formatted.',
					);
					return;
				}

				const edit = new vscode.WorkspaceEdit();
				edit.replace(document.uri, range, formatted);
				const applied = await vscode.workspace.applyEdit(edit);
				if (!applied) {
					vscode.window.showErrorMessage('Unable to format Mermaid diagram.');
					return;
				}

				logger.logInfo('Formatted Mermaid diagram', {
					command: 'formatDiagram',
					languageId: document.languageId,
				});
				vscode.window.showInformationMessage('Mermaid diagram formatted.');
			} catch (error) {
				logger.logError(
					'Failed to format Mermaid diagram',
					error instanceof Error ? error : new Error(String(error)),
				);
				vscode.window.showErrorMessage(
					'Unable to format Mermaid diagram. See output for details.',
				);
			}
		},
	);

	const fixFormatIssueCommand = vscode.commands.registerCommand(
		'mermaidViewer.fixFormatIssueAtLine',
		async (uri: vscode.Uri | undefined, line: number | undefined) => {
			try {
				if (!uri || typeof line !== 'number') {
					logger.logError('fixFormatIssueAtLine missing arguments', { line });
					return;
				}

				const document = await vscode.workspace.openTextDocument(uri);
				const issue = collectDocumentFormatIssues(document).find(
					(i) => i.line === line,
				);

				if (!issue || line >= document.lineCount) {
					vscode.window.showInformationMessage(
						'No formatting issue to fix on this line.',
					);
					return;
				}

				logger.logInfo('Fix formatting issue triggered', {
					source: 'fixFormatIssueCommand',
					uri: uri.toString(),
					line,
				});

				const edit = new vscode.WorkspaceEdit();
				edit.replace(document.uri, document.lineAt(line).range, issue.expected);
				const applied = await vscode.workspace.applyEdit(edit);
				if (!applied) {
					vscode.window.showErrorMessage(
						'Unable to fix Mermaid formatting issue.',
					);
				}
			} catch (error) {
				logger.logError(
					'Failed to fix Mermaid formatting issue',
					error instanceof Error ? error : new Error(String(error)),
				);
				vscode.window.showErrorMessage(
					'Unable to fix Mermaid formatting issue. See output for details.',
				);
			}
		},
	);

	// Register command to show preview
	const showPreviewCommand = vscode.commands.registerCommand(
		'mermaidViewer.showPreview',
		() => {
			const editor = getActiveSupportedEditor('showPreview');
			if (!editor) {
				return;
			}

			MermaidPreviewPanel.createOrShow(
				context.extensionUri,
				editor.document,
				vscode.ViewColumn.Active,
			);
		},
	);

	// Register command to show preview to the side
	const showPreviewToSideCommand = vscode.commands.registerCommand(
		'mermaidViewer.showPreviewToSide',
		async () => {
			const editor = getActiveSupportedEditor('showPreviewToSide');
			if (!editor) {
				return;
			}

			const config = vscode.workspace.getConfiguration('mermaidViewer');
			const location = config.get<string>('defaultPreviewLocation', 'side');

			if (location === 'newWindow') {
				MermaidPreviewPanel.createOrShow(
					context.extensionUri,
					editor.document,
					vscode.ViewColumn.Active,
				);
				await vscode.commands.executeCommand(
					'workbench.action.moveEditorToNewWindow',
				);
			} else {
				MermaidPreviewPanel.createOrShow(
					context.extensionUri,
					editor.document,
					vscode.ViewColumn.Beside,
				);
			}
		},
	);

	// Register command to show preview in a new floating window
	const showPreviewInNewWindowCommand = vscode.commands.registerCommand(
		'mermaidViewer.showPreviewInNewWindow',
		async () => {
			const editor = getActiveSupportedEditor('showPreviewInNewWindow');
			if (!editor) {
				return;
			}

			MermaidPreviewPanel.createOrShow(
				context.extensionUri,
				editor.document,
				vscode.ViewColumn.Active,
			);
			await vscode.commands.executeCommand(
				'workbench.action.moveEditorToNewWindow',
			);
		},
	);

	const showDiagramAtPositionCommand = vscode.commands.registerCommand(
		'mermaidViewer.showDiagramAtPosition',
		async (uri: vscode.Uri | undefined, line: number | undefined) => {
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
					vscode.window.showErrorMessage(
						'Unable to open diagram preview: no document context available.',
					);
					return;
				}

				if (
					document.languageId !== 'markdown' &&
					document.languageId !== 'mermaid'
				) {
					logger.logWarning(
						'showDiagramAtPosition invoked for unsupported document',
						{
							languageId: document.languageId,
							uri: document.uri.toString(),
						},
					);
					vscode.window.showInformationMessage(
						'Mermaid Viewer only works with Markdown and Mermaid files.',
					);
					return;
				}

				if (typeof targetLine !== 'number') {
					logger.logError('showDiagramAtPosition missing line information');
					vscode.window.showErrorMessage(
						'Unable to open diagram preview: missing line information.',
					);
					return;
				}

				MermaidPreviewPanel.createOrShowSingle(
					context.extensionUri,
					document,
					targetLine,
					vscode.ViewColumn.Beside,
				);
			} catch (error) {
				logger.logError(
					'Failed to open document for showDiagramAtPosition',
					error instanceof Error ? error : new Error(String(error)),
				);
				vscode.window.showErrorMessage(
					'Unable to open Mermaid diagram preview. See output for details.',
				);
			}
		},
	);

	// Surface a warning (squiggle) when a Mermaid diagram is not formatted.
	const formatDiagnostics =
		vscode.languages.createDiagnosticCollection('mermaid-format');
	context.subscriptions.push(formatDiagnostics);

	const updateFormatDiagnostics = (document: vscode.TextDocument) => {
		const isSupported =
			document.languageId === 'markdown' || document.languageId === 'mermaid';
		const config = vscode.workspace.getConfiguration('mermaidViewer');
		if (!isSupported || !config.get<boolean>('format.diagnostics', true)) {
			formatDiagnostics.delete(document.uri);
			return;
		}

		const diagnostics: vscode.Diagnostic[] = [];
		for (const issue of collectDocumentFormatIssues(document)) {
			if (issue.line >= document.lineCount) {
				continue;
			}
			const diagnostic = new vscode.Diagnostic(
				document.lineAt(issue.line).range,
				'Mermaid diagram line is not formatted.',
				vscode.DiagnosticSeverity.Warning,
			);
			diagnostic.source = 'Mermaid Viewer';
			diagnostic.code = 'unformatted';
			diagnostics.push(diagnostic);
		}

		formatDiagnostics.set(document.uri, diagnostics);
	};

	for (const document of vscode.workspace.textDocuments) {
		updateFormatDiagnostics(document);
	}

	const diagnosticsConfigSubscription =
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('mermaidViewer.format.diagnostics')) {
				for (const document of vscode.workspace.textDocuments) {
					updateFormatDiagnostics(document);
				}
			}
		});

	const openDocumentSubscription = vscode.workspace.onDidOpenTextDocument(
		updateFormatDiagnostics,
	);
	const closeDocumentSubscription = vscode.workspace.onDidCloseTextDocument(
		(document) => formatDiagnostics.delete(document.uri),
	);

	// Debounced diagnostics and gutter updates — avoid re-parsing the entire
	// document on every keystroke.  The 300 ms delay collapses rapid edits into
	// a single update while staying perceptually instant once typing pauses.
	const pendingDiagnosticTimers = new Map<string, NodeJS.Timeout>();
	const debouncedDiagnosticsAndGutter = (document: vscode.TextDocument) => {
		const key = document.uri.toString();
		const existing = pendingDiagnosticTimers.get(key);
		if (existing) {
			clearTimeout(existing);
		}
		pendingDiagnosticTimers.set(
			key,
			setTimeout(() => {
				pendingDiagnosticTimers.delete(key);
				gutterDecorator?.updateForDocument(document);
				updateFormatDiagnostics(document);
			}, 300),
		);
	};

	// Watch for document changes
	const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(
		(e) => {
			debouncedDiagnosticsAndGutter(e.document);

			const config = vscode.workspace.getConfiguration('mermaidViewer');
			const autoRefresh = config.get<boolean>('autoRefresh', true);

			// Update if it's a markdown or mermaid file
			const isSupported =
				e.document.languageId === 'markdown' ||
				e.document.languageId === 'mermaid';
			if (autoRefresh && isSupported && MermaidPreviewPanel.hasOpenPanels()) {
				MermaidPreviewPanel.forEachPanel((panel) =>
					panel.updateContent(e.document),
				);
			}
		},
	);

	// Watch for active editor changes
	const changeActiveEditorSubscription =
		vscode.window.onDidChangeActiveTextEditor((editor) => {
			gutterDecorator?.update(editor);

			if (editor) {
				updateFormatDiagnostics(editor.document);
			}

			// Update if it's a markdown or mermaid file
			if (editor) {
				const isSupported =
					editor.document.languageId === 'markdown' ||
					editor.document.languageId === 'mermaid';
				if (isSupported && MermaidPreviewPanel.hasOpenPanels()) {
					MermaidPreviewPanel.forEachPanel((panel) =>
						panel.updateContent(editor.document),
					);
				}
			}
		});

	const visibleEditorsSubscription =
		vscode.window.onDidChangeVisibleTextEditors((editors) => {
			for (const editor of editors) {
				gutterDecorator?.update(editor);
			}
		});

	const selectionChangeSubscription =
		vscode.window.onDidChangeTextEditorSelection((event) => {
			if (!MermaidPreviewPanel.hasOpenPanels()) {
				return;
			}

			const editor = event.textEditor;
			const isSupported =
				editor.document.languageId === 'markdown' ||
				editor.document.languageId === 'mermaid';
			if (!isSupported) {
				return;
			}

			const activeLine = event.selections[0]?.active.line;
			if (typeof activeLine !== 'number') {
				return;
			}

			MermaidPreviewPanel.forEachPanel((panel) =>
				panel.handleSelectionChange(editor.document, activeLine),
			);
		});

	context.subscriptions.push(
		showPreviewCommand,
		showPreviewToSideCommand,
		showPreviewInNewWindowCommand,
		showDiagramAtPositionCommand,
		copyDiagramCodeCommand,
		copyDiagramCodeWithWrapperCommand,
		formatDiagramCommand,
		fixFormatIssueCommand,
		diagnosticsConfigSubscription,
		openDocumentSubscription,
		closeDocumentSubscription,
		changeDocumentSubscription,
		changeActiveEditorSubscription,
		visibleEditorsSubscription,
		selectionChangeSubscription,
		{
			dispose: () => {
				for (const t of pendingDiagnosticTimers.values()) clearTimeout(t);
			},
		},
	);

	logger.logInfo('Mermaid Viewer extension activated successfully');

	// Return markdown-it API exactly like the reference extension contract.
	// VS Code markdown preview reads this object from activate() and uses it
	// to transform markdown before preview scripts run.
	return {
		extendMarkdownIt(md: MarkdownItLike) {
			Logger.instance.logInfo(
				`extendMarkdownIt (activate return) called by VS Code (md=${md ? 'present' : 'missing'})`,
			);
			return createMarkdownItPlugin()(md);
		},
	};
}

export function deactivate() {}

// Export API for VS Code's markdown preview to use our markdown-it plugin
export function extendMarkdownIt(md: MarkdownItLike) {
	Logger.instance.logInfo(
		`extendMarkdownIt called by VS Code (md=${md ? 'present' : 'missing'})`,
	);
	return createMarkdownItPlugin()(md);
}
