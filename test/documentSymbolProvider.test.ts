import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import test from 'node:test';

class Position {
	constructor(public line: number, public character: number) {}
	compareTo(other: Position) {
		return this.line - other.line || this.character - other.character;
	}
}

class Range {
	start: Position;
	end: Position;
	constructor(start: Position | number, end: Position | number, endLine?: number, endCharacter?: number) {
		this.start = typeof start === 'number' ? new Position(start, end as number) : start;
		this.end = typeof end === 'number' ? new Position(endLine!, endCharacter!) : end;
	}
	contains(position: Position) {
		return this.start.compareTo(position) <= 0 && this.end.compareTo(position) >= 0;
	}
}

class DocumentSymbol {
	children: DocumentSymbol[] = [];
	constructor(public name: string, public detail: string, public kind: number, public range: Range, public selectionRange: Range) {}
}

const module = { exports: {} as { MermaidDocumentSymbolProvider: new () => {
	provideDocumentSymbols(document: { getText(): string }, token: { isCancellationRequested: boolean }): DocumentSymbol[];
} } };
const { code } = transformSync(readFileSync('src/documentSymbolProvider.ts', 'utf8'), { loader: 'ts', format: 'cjs' });
runInNewContext(code, {
	module,
	exports: module.exports,
	require: () => ({ Position, Range, DocumentSymbol, SymbolKind: { Struct: 22, Field: 7 } }),
});
const provider = new module.exports.MermaidDocumentSymbolProvider();
const symbolsFor = (text: string, cancelled = false) => provider.provideDocumentSymbols(
	{ getText: () => text }, { isCancellationRequested: cancelled },
);

test('ER symbols prefer definitions and span table attributes for breadcrumbs', () => {
	const symbols = symbolsFor('erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  CUSTOMER {\n    int id PK\n  }\n  ORDER {\n    int id PK\n  }');
	assert.deepEqual([...symbols].map(symbol => symbol.name), ['CUSTOMER', 'ORDER']);
	assert.equal(symbols[0].range.start.line, 2);
	assert.equal(symbols[0].range.end.line, 4);
	assert.equal(symbols[0].selectionRange.start.character, 2);
	assert.equal(symbols[0].selectionRange.end.character, 10);
});

test('ER symbols handle frontmatter, aliases, quoted names, isolated tables and CRLF', () => {
	const symbols = symbolsFor('---\nconfig:\n  layout: elk\n---\n%% comment\nerDiagram\n  direction LR\n  "Order Item"["Line items"] {\n    int id\n  }\n  ISOLATED\n  accTitle: Schema'.replace(/\n/g, '\r\n'));
	assert.deepEqual([...symbols].map(symbol => symbol.name), ['Order Item', 'ISOLATED']);
	assert.equal(symbols[0].detail, 'Line items');
	assert.equal(symbols[0].range.start.line, 7);
	assert.equal(symbols[0].range.end.line, 9);
});

test('ER symbols include relationship-only tables without duplicates', () => {
	const symbols = symbolsFor('erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER }o..|| CUSTOMER : belongs');
	assert.deepEqual([...symbols].map(symbol => symbol.name).sort(), ['CUSTOMER', 'ORDER']);
});

test('ER symbols tolerate unfinished blocks and skip other diagram types or cancellation', () => {
	const symbols = symbolsFor('erDiagram\n  CUSTOMER {\n    int id\n');
	assert.equal(symbols[0].range.end.line, 3);
	assert.equal(symbolsFor('classDiagram\n  class CUSTOMER {\n  }').length, 0);
	assert.equal(symbolsFor('erDiagram\n  CUSTOMER', true).length, 0);
});

test('ER columns are nested field symbols with type, keys and precise name ranges', () => {
	const [table] = symbolsFor('erDiagram\n  CUSTOMER {\n    int customer_id PK "Identifier"\n    string[] emails UK\n    int owner_id PK, FK\n    %% ignored comment\n\n    string name\n  }');
	assert.deepEqual([...table.children].map(column => column.name), ['customer_id', 'emails', 'owner_id', 'name']);
	assert.deepEqual([...table.children].map(column => column.detail), ['int PK', 'string[] UK', 'int PK, FK', 'string']);
	assert.ok(table.children.every(column => column.kind === 7));
	assert.equal(table.children[0].range.start.line, 2);
	assert.equal(table.children[0].range.start.character, 4);
	assert.equal(table.children[0].selectionRange.start.character, 8);
	assert.equal(table.children[0].selectionRange.end.character, 19);
	assert.equal(table.children[0].range.end.character, 35);
	assert.equal(table.range.end.line, 8);
});

test('ER columns support inline attributes and braces inside comments', () => {
	const tables = symbolsFor('erDiagram\n  FIRST { int id PK string value "Has } brace" }\n  SECOND {\n    string value "Has } brace"\n    int next_id FK\n  }');
	assert.deepEqual([...tables[0].children].map(column => column.name), ['id', 'value']);
	assert.deepEqual([...tables[1].children].map(column => column.name), ['value', 'next_id']);
	assert.equal(tables[0].range.end.line, 1);
	assert.equal(tables[1].range.end.line, 5);
});

test('ER columns stay scoped to their table and tolerate unfinished attributes', () => {
	const tables = symbolsFor('erDiagram\n  FIRST {\n    int id\n  }\n  FIRST ||--o{ SECOND : links\n  SECOND {\n    string name\n    int\n');
	assert.deepEqual([...tables[0].children].map(column => column.name), ['id']);
	assert.deepEqual([...tables[1].children].map(column => column.name), ['name']);
	assert.equal(tables[1].range.end.line, 8);
});

class MarkdownString {
	constructor(public value: string) {}
}

class Hover {
	constructor(public contents: MarkdownString, public range: Range) {}
}

const hoverModule = { exports: {} as { MermaidHoverProvider: new () => {
	provideHover(document: unknown, position: Position, token: { isCancellationRequested: boolean }): Hover | undefined;
} } };
const hoverCode = transformSync(readFileSync('src/hoverProvider.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code;
runInNewContext(hoverCode, {
	module: hoverModule,
	exports: hoverModule.exports,
	require: (name: string) => name === './documentSymbolProvider' ? module.exports : { Range, MarkdownString, Hover },
});
const hoverProvider = new hoverModule.exports.MermaidHoverProvider();
const hoverFor = (text: string, line: number, character: number, cancelled = false) => {
	const lines = text.split(/\r?\n/);
	return hoverProvider.provideHover({
		getText: (range?: Range) => range ? lines[range.start.line].slice(range.start.character, range.end.character) : text,
		lineAt: (index: number) => ({ text: lines[index] }),
	}, new Position(line, character), { isCancellationRequested: cancelled });
};

test('ER table hovers show schema tables at declarations and both relationship endpoints', () => {
	const text = 'erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  CUSTOMER {\n    int id PK "Customer identifier"\n    string email UK\n  }\n  ORDER { int customer_id FK "Buyer" }';
	for (const [line, character] of [[2, 4], [1, 4]]) {
		const hover = hoverFor(text, line, character);
		assert.ok(hover);
		assert.ok(hover.contents.value.startsWith('**CUSTOMER**'));
		assert.ok(hover.contents.value.includes('| Column | Type | Key | Description |'));
		assert.ok(hover.contents.value.includes('| id | int | PK | Customer identifier |'));
		assert.ok(hover.contents.value.includes('| email | string | UK |  |'));
		assert.equal(hover.range.start.character, 2);
		assert.equal(hover.range.end.character, 10);
	}
	assert.ok(hoverFor(text, 1, 20)?.contents.value.includes('| customer\\_id | int | FK | Buyer |'));
});

test('ER table hovers escape descriptions and support quoted table names and aliases', () => {
	const text = 'erDiagram\n  "Order Item"["Line items"] {\n    string value "a | b <img> [link](command:bad)"\n  }\n  OTHER ||--o{ "Order Item" : contains';
	const hover = hoverFor(text, 4, 20);
	assert.ok(hover);
	assert.ok(hover.contents.value.startsWith('**Order Item** (Line items)'));
	assert.ok(hover.contents.value.includes('a \\| b &lt;img\\> \\[link\\]\\(command:bad\\)'));
	assert.ok(hoverFor('erDiagram\n  EMPTY', 1, 3)?.contents.value.includes('No columns declared'));
});

test('ER table hovers ignore columns, comments, relationship labels, other diagrams and cancellation', () => {
	const text = 'erDiagram\n  CUSTOMER {\n    string CUSTOMER "CUSTOMER"\n  }\n  %% CUSTOMER\n  CUSTOMER ||--o{ ORDER : CUSTOMER';
	assert.equal(hoverFor(text, 2, 12), undefined);
	assert.equal(hoverFor(text, 4, 7), undefined);
	assert.equal(hoverFor(text, 5, 28), undefined);
	assert.equal(hoverFor('classDiagram\n  class CUSTOMER', 1, 10), undefined);
	assert.equal(hoverFor(text, 1, 4, true), undefined);
});

test('Nullable ER columns remain visible in breadcrumbs and table hovers', () => {
	for (const [type, markdownType] of [
		['string?', 'string?'],
		['varchar(30)?', 'varchar\\(30\\)?'],
		['string[]?', 'string\\[\\]?'],
	]) {
		for (const inline of [false, true]) {
			const attributes = `int id PK\n${type} nickname FK "Optional nickname"\nint age`;
			const text = inline
				? `erDiagram\n  PERSON { ${attributes.replace(/\n/g, ' ')} }`
				: `erDiagram\n  PERSON {\n    ${attributes.replace(/\n/g, '\n    ')}\n  }`;
			const [table] = symbolsFor(text);
			assert.deepEqual([...table.children].map(column => column.name), ['id', 'nickname', 'age']);
			assert.equal(table.children[1].detail, `${type} FK`);
			const column = table.children[1];
			assert.equal(text.split('\n')[column.selectionRange.start.line].slice(column.selectionRange.start.character, column.selectionRange.end.character), 'nickname');
			const hover = hoverFor(text, 1, 4);
			assert.ok(hover?.contents.value.includes(`| nickname | ${markdownType} | FK | Optional nickname |`), `${type} should appear in the ${inline ? 'inline' : 'multiline'} table hover`);
			assert.ok(hover?.contents.value.includes('| age | int |  |  |'));
		}
	}
});