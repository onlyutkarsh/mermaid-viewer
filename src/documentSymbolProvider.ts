import * as vscode from 'vscode';

export class MermaidDocumentSymbolProvider
	implements vscode.DocumentSymbolProvider
{
	provideDocumentSymbols(
		document: vscode.TextDocument,
		token: vscode.CancellationToken,
	): vscode.DocumentSymbol[] {
		const lines = document.getText().split(/\r?\n/);
		const symbols = new Map<string, vscode.DocumentSymbol>();
		const identifier = '"[^"\\r\\n]+"|[\\p{L}\\p{N}_-]+';
		const entity = new RegExp(
			`^\\s*(${identifier})(?:\\s*\\[\\s*([^\\]]+)\\s*\\])?\\s*(.*)$`,
			'u',
		);
		const relationship = new RegExp(
			`^[|o}{]+(?:--|\\.\\.)[|o}{]+\\s*(${identifier})`,
			'u',
		);
		const attribute =
			/\s*([\p{L}_][\p{L}\p{N}_()[\],-]*\??)\s+(\*?[\p{L}_][\p{L}\p{N}_-]*)(?=\s|\}|$)(?:\s+((?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*))?(?:\s+"[^"]*")?/uy;
		let inFrontMatter = lines[0]?.trim() === '---';
		let inErDiagram = false;
		let activeTable: vscode.DocumentSymbol | undefined;

		const addTable = (rawName: string, line: number, character: number) => {
			const name = rawName.replace(/^"|"$/g, '');
			const selection = new vscode.Range(
				line,
				character,
				line,
				character + rawName.length,
			);
			const symbol = new vscode.DocumentSymbol(
				name,
				'Table',
				vscode.SymbolKind.Struct,
				selection,
				selection,
			);
			if (!symbols.has(name)) {
				symbols.set(name, symbol);
			}
			return symbol;
		};

		const addColumns = (
			table: vscode.DocumentSymbol,
			text: string,
			line: number,
			offset = 0,
		) => {
			let cursor = offset;
			while (cursor < text.length) {
				const rest = text.slice(cursor).trimStart();
				if (rest.startsWith('}')) {
					return true;
				}
				attribute.lastIndex = cursor;
				const match = attribute.exec(text);
				if (!match) {
					break;
				}
				const [, type, name, keys] = match;
				const typeStart = match.index + match[0].indexOf(type);
				const nameStart = text.indexOf(name, typeStart + type.length);
				cursor = attribute.lastIndex;
				table.children.push(
					new vscode.DocumentSymbol(
						name,
						keys ? `${type} ${keys}` : type,
						vscode.SymbolKind.Field,
						new vscode.Range(line, typeStart, line, cursor),
						new vscode.Range(line, nameStart, line, nameStart + name.length),
					),
				);
			}
			return false;
		};

		for (let line = 0; line < lines.length; line++) {
			if (token.isCancellationRequested) {
				return [];
			}
			const text = lines[line];
			const trimmed = text.trim();
			if (inFrontMatter) {
				if (line > 0 && /^(---|\.\.\.)$/.test(trimmed)) {
					inFrontMatter = false;
				}
				continue;
			}
			if (!trimmed || trimmed.startsWith('%%')) {
				continue;
			}
			if (!inErDiagram) {
				if (!/^erDiagram\b/.test(trimmed)) {
					return [];
				}
				inErDiagram = true;
				continue;
			}
			if (activeTable) {
				activeTable.range = new vscode.Range(
					activeTable.range.start,
					new vscode.Position(line, text.length),
				);
				if (addColumns(activeTable, text, line)) {
					activeTable = undefined;
				}
				continue;
			}
			if (
				/^(direction|accTitle|accDescr|style|classDef|class)\b/.test(trimmed)
			) {
				continue;
			}
			const match = entity.exec(text);
			if (!match) {
				continue;
			}
			const [, rawName, alias, rest] = match;
			const relation = relationship.exec(rest);
			if (
				rest &&
				!rest.startsWith('{') &&
				!rest.startsWith('%%') &&
				!relation
			) {
				continue;
			}
			const character = text.indexOf(rawName);
			const symbol = addTable(rawName, line, character);
			if (alias) {
				symbol.detail = alias.trim().replace(/^"|"$/g, '');
			}
			if (rest.startsWith('{')) {
				symbols.set(symbol.name, symbol);
				symbol.range = new vscode.Range(line, character, line, text.length);
				if (
					!addColumns(
						symbol,
						text,
						line,
						text.indexOf('{', character + rawName.length) + 1,
					)
				) {
					activeTable = symbol;
				}
			} else if (relation) {
				const target = relation[1];
				addTable(
					target,
					line,
					text.indexOf(target, character + rawName.length),
				);
			}
		}
		if (activeTable) {
			const lastLine = lines.length - 1;
			activeTable.range = new vscode.Range(
				activeTable.range.start,
				new vscode.Position(lastLine, lines[lastLine].length),
			);
		}
		return [...symbols.values()].sort((left, right) =>
			left.range.start.compareTo(right.range.start),
		);
	}
}
