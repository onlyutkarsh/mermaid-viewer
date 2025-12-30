import { LogOutputChannel, window, Disposable } from 'vscode';

const CHANNEL_NAME = 'Mermaid Viewer';

type Loggable = Record<string, unknown> | unknown[] | string | number | boolean | undefined | null | Error;

export class Logger implements Disposable {
    private static _instance: Logger | undefined;
    private readonly channel: LogOutputChannel;

    private constructor() {
        this.channel = window.createOutputChannel(CHANNEL_NAME, { log: true });
    }

    static get instance(): Logger {
        if (!Logger._instance) {
            Logger._instance = new Logger();
        }
        return Logger._instance;
    }

    dispose(): void {
        this.channel.dispose();
    }

    show(): void {
        this.channel.show();
    }

    logInfo(message: string, data?: Loggable): void {
        this.channel.info(message);
        if (data !== undefined) {
            this.channel.info(this.stringify(data));
        }
    }

    logWarning(message: string, data?: Loggable): void {
        this.channel.warn(message);
        if (data !== undefined) {
            this.channel.warn(this.stringify(data));
        }
    }

    logDebug(category: string, message: string, context?: Loggable): void {
        const prefix = `[${category}] ${message}`;
        this.channel.debug(prefix);
        if (context !== undefined) {
            this.channel.debug(`  Context: ${this.stringify(context)}`);
        }
    }

    logError(message: string, error?: Loggable): void {
        this.channel.error(message);
        if (error instanceof Error) {
            if (error.message) {
                this.channel.error(error.message);
            }
            if (error.stack) {
                this.channel.error(error.stack);
            }
            return;
        }

        if (error !== undefined) {
            this.channel.error(this.stringify(error));
        }
    }

    private stringify(data: Loggable): string {
        if (data === undefined || data === null) {
            return String(data);
        }

        if (data instanceof Error) {
            return data.stack ?? data.message ?? data.toString();
        }

        if (typeof data === 'string') {
            return data;
        }

        if (typeof data === 'number' || typeof data === 'boolean') {
            return JSON.stringify(data);
        }

        try {
            return JSON.stringify(data, null, 2);
        } catch (error) {
            return `[[Unable to stringify log payload: ${error}]]`;
        }
    }
}
