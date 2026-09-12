import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { before } from 'node:test';
import { JSDOM } from 'jsdom';

// Initialize DOM environment for Mermaid before importing/running
const dom = new JSDOM(
	'<!DOCTYPE html><html><body><div id="container"></div></body></html>',
	{
		url: 'http://localhost',
	},
);

const globalEnv = globalThis as unknown as {
	window: unknown;
	document: unknown;
	DOMParser: unknown;
	SVGElement: unknown;
	CSSStyleSheet: unknown;
};

globalEnv.window = dom.window;
globalEnv.document = dom.window.document;
globalEnv.DOMParser = dom.window.DOMParser;
globalEnv.SVGElement = dom.window.SVGElement;
globalEnv.CSSStyleSheet = dom.window.CSSStyleSheet;

const svgPrototype = dom.window.SVGElement.prototype as typeof dom.window.SVGElement.prototype & {
	getBBox?: () => { x: number; y: number; width: number; height: number };
};

if (!svgPrototype.getBBox) {
	svgPrototype.getBBox = () => ({
		x: 0,
		y: 0,
		width: 100,
		height: 100,
	});
}

let mermaid: typeof import('mermaid').default;

before(async () => {
	const mermaidModule = await import(
		pathToFileURL(
			path.resolve('out/mermaid/dist/mermaid.esm.min.mjs'),
		).href
	);
	mermaid = mermaidModule.default;
	const elkLayouts = await import(
		pathToFileURL(
			path.resolve(
				'out/mermaid-layout-elk/dist/mermaid-layout-elk.esm.min.mjs',
			),
		).href
	);
	if (elkLayouts.default) {
		mermaid.registerLayoutLoaders(elkLayouts.default);
	}
	mermaid.initialize({
		startOnLoad: false,
		securityLevel: 'loose',
		suppressErrorRendering: true,
	});
});

test('Renders core diagram types', async () => {
	const coreDiagrams = [
		{
			name: 'Flowchart',
			code: 'graph TD\n  A[Start] --> B{Choice}\n  B -->|Yes| C[OK]\n  B -->|No| D[Cancel]',
		},
		{
			name: 'Sequence',
			code: 'sequenceDiagram\n  autonumber\n  Alice->>John: Hello John\n  John-->>Alice: Hi Alice',
		},
		{
			name: 'Class Diagram',
			code: 'classDiagram\n  Animal <|-- Duck\n  Animal : +int age\n  Animal: +isMammal()',
		},
		{
			name: 'State Diagram',
			code: 'stateDiagram-v2\n  [*] --> Still\n  Still --> [*]',
		},
		{
			name: 'ER Diagram',
			code: 'erDiagram\n  CUSTOMER ||--o{ ORDER : places',
		},
		{
			name: 'Gantt Chart',
			code: 'gantt\n  title Project Plan\n  section Task\n  Design :a1, 2026-01-01, 10d',
		},
		{
			name: 'Pie Chart',
			code: 'pie title Favorite Pets\n  "Dogs" : 386\n  "Cats" : 85',
		},
		{
			name: 'Git Graph',
			code: 'gitGraph\n  commit\n  branch feature\n  commit\n  checkout main\n  merge feature',
		},
	];

	for (let i = 0; i < coreDiagrams.length; i++) {
		const diagram = coreDiagrams[i];
		const { svg } = await mermaid.render(`test-core-${i}`, diagram.code);
		assert.ok(svg && svg.includes('<svg'), `Failed to render ${diagram.name}`);
	}
});

test('Renders an ER diagram with the ELK layout', async () => {
	const elkDiagram = await fsPromises.readFile(
		path.resolve('examples/er-diagram.mmd'),
		'utf8',
	);
	const { svg } = await mermaid.render('test-elk-er-diagram', elkDiagram);

	assert.ok(svg && svg.includes('<svg'), 'Failed to render the ELK ER diagram');
});

test('Parses diagrams from repository example files', async () => {
	const exampleFiles = [
		'examples/class-diagram.mmd',
		'examples/er-diagram.mmd',
		'examples/flowchart.mmd',
		'examples/gantt.mmd',
		'examples/git-graph.mmd',
		'examples/markdown-examples.md',
		'examples/pie-chart.mmd',
		'examples/sequence.mmd',
		'examples/state-diagram.mmd',
		'examples/test-ado-syntax.md',
	];

	let parsedCount = 0;

	for (const relPath of exampleFiles) {
		const fullPath = path.resolve(process.cwd(), relPath);
		const content = await fsPromises.readFile(fullPath, 'utf8');

		const blocks: string[] = [];
		if (relPath.endsWith('.mmd') || relPath.endsWith('.mermaid')) {
			if (content.trim()) {
				blocks.push(content.trim());
			}
		} else {
			// Extract ```mermaid and :::mermaid blocks from Markdown
			const fencedRegex = /```mermaid[^\S\r\n]*(?:\r?\n)([\s\S]*?)(?:\r?\n)?```/g;
			const adoRegex = /:::\s*mermaid[^\S\r\n]*(?:\r?\n)([\s\S]*?)(?:\r?\n)?:::/g;

			let match: RegExpExecArray | null = fencedRegex.exec(content);
			while (match !== null) {
				if (match[1].trim()) {
					blocks.push(match[1].trim());
				}
				match = fencedRegex.exec(content);
			}

			match = adoRegex.exec(content);
			while (match !== null) {
				if (match[1].trim()) {
					blocks.push(match[1].trim());
				}
				match = adoRegex.exec(content);
			}
		}

		for (let i = 0; i < blocks.length; i++) {
			const code = blocks[i];
			await mermaid.parse(code);
			parsedCount++;
		}
	}

	assert.ok(
		parsedCount > 0,
		'Should have extracted and parsed at least one diagram from example files',
	);
});

test('Detects invalid syntax and throws or returns error', async () => {
	const invalidCode = 'graph TD\n  A ---> invalid syntax >>>';
	let caughtError = false;

	try {
		await mermaid.parse(invalidCode);
	} catch (err) {
		caughtError = true;
		assert.ok(err, 'Parse error should be reported');
	}

	assert.equal(
		caughtError,
		true,
		'Invalid diagram syntax should throw a parse error',
	);
});
