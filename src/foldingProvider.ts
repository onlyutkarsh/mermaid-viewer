import * as vscode from 'vscode';
import { Logger } from './util/logger';

export class MermaidFoldingProvider implements vscode.FoldingRangeProvider {
    private readonly logger: Logger;

    constructor() {
        this.logger = Logger.instance;
    }

    provideFoldingRanges(
        document: vscode.TextDocument,
        _context: vscode.FoldingContext,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.FoldingRange[]> {
        try {
            const foldingRanges: vscode.FoldingRange[] = [];
            const text = document.getText();
            const lines = text.split('\n');

            const stack: Array<{ keyword: string; startLine: number }> = [];

            for (let i = 0; i < lines.length; i++) {
                if (token.isCancellationRequested) {
                    this.logger.logDebug('FoldingProvider', 'Folding range computation cancelled');
                    return [];
                }

                const line = lines[i];
                const trimmed = line.trim();

                // Check for opening keywords
                if (
                    /^(subgraph|box|alt|loop|opt|par|rect)\b/.test(trimmed) ||
                    /^class\s+\w+\s*\{/.test(trimmed) ||
                    /^note\s+(left of|right of)/.test(trimmed)
                ) {
                    const keyword = trimmed.split(/\s+/)[0];
                    stack.push({ keyword, startLine: i });
                }
                // Check for closing keywords
                else if (/^(end|end note|\})/.test(trimmed)) {
                    if (stack.length > 0) {
                        const start = stack.pop();
                        if (start) {
                            // Create folding range from start to current line
                            foldingRanges.push(
                                new vscode.FoldingRange(
                                    start.startLine,
                                    i,
                                    vscode.FoldingRangeKind.Region
                                )
                            );
                        }
                    }
                }
            }

            return foldingRanges;
        } catch (error) {
            // Log at debug level - folding failures shouldn't alarm users
            this.logger.logDebug('FoldingProvider', 'Failed to compute folding ranges', { error: error instanceof Error ? error.message : String(error) });
            return [];
        }
    }
}
