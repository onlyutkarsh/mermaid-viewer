import * as vscode from 'vscode';
import { MermaidDocumentSymbolProvider } from './documentSymbolProvider';

function escapeMarkdown(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/[\\`*_{}[\]()#+.!|>-]/g, '\\$&')
		.replace(/\r?\n/g, ' ');
}

export class MermaidHoverProvider implements vscode.HoverProvider {
	private readonly symbols = new MermaidDocumentSymbolProvider();

	provideHover(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
	): vscode.Hover | undefined {
		const tables = this.symbols.provideDocumentSymbols(document, token);
		if (token.isCancellationRequested || !tables.length) {
			return undefined;
		}
		let table = tables.find((candidate) =>
			candidate.selectionRange.contains(position),
		);
		let range = table?.selectionRange;
		if (!table) {
			if (
				tables.some((candidate) =>
					candidate.children.some((column) => column.range.contains(position)),
				)
			) {
				return undefined;
			}
			const identifier = '"[^"\\r\\n]+"|[\\p{L}\\p{N}_-]+';
			const relationship = new RegExp(
				`^\\s*(${identifier})(?:\\s*\\[[^\\]]+\\])?\\s*[|o}{]+(?:--|\\.\\.)[|o}{]+\\s*(${identifier})`,
				'u',
			);
			const text = document.lineAt(position.line).text;
			const match = relationship.exec(text);
			if (!match) {
				return undefined;
			}
			let offset = 0;
			for (const name of [match[1], match[2]]) {
				const start = text.indexOf(name, offset);
				offset = start + name.length;
				if (position.character < start || position.character >= offset) {
					continue;
				}
				table = tables.find(
					(candidate) => candidate.name === name.replace(/^"|"$/g, ''),
				);
				range = new vscode.Range(position.line, start, position.line, offset);
				break;
			}
		}
		if (!table || !range) {
			return undefined;
		}
		const title = `**${escapeMarkdown(table.name)}**`;
		const alias =
			table.detail !== 'Table' ? ` (${escapeMarkdown(table.detail)})` : '';
		const rows = table.children.map((column) => {
			const [type, ...keys] = column.detail.split(' ');
			const comment =
				/"([^"]*)"\s*$/.exec(document.getText(column.range))?.[1] ?? '';
			return `| ${[column.name, type, keys.join(' '), comment].map(escapeMarkdown).join(' | ')} |`;
		});
		const contents = new vscode.MarkdownString(
			`${title}${alias}\n\n${
				rows.length
					? '| Column | Type | Key | Description |\n| --- | --- | --- | --- |\n' +
						rows.join('\n')
					: '_No columns declared._'
			}`,
		);
		return new vscode.Hover(contents, range);
	}
}
