import { type Disposable, type LogOutputChannel, window } from 'vscode';

const CHANNEL_NAME = 'Mermaid Viewer';

type Loggable =
	| Record<string, unknown>
	| unknown[]
	| string
	| number
	| boolean
	| undefined
	| null
	| Error;

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
		if (data !== undefined) {
			this.channel.info(`${message} ${this.stringify(data)}`);
		} else {
			this.channel.info(message);
		}
	}

	logWarning(message: string, data?: Loggable): void {
		if (data !== undefined) {
			this.channel.warn(`${message} ${this.stringify(data)}`);
		} else {
			this.channel.warn(message);
		}
	}

	logDebug(category: string, message: string, context?: Loggable): void {
		if (context !== undefined) {
			this.channel.debug(
				`[${category}] ${message} - ${this.stringify(context)}`,
			);
		} else {
			this.channel.debug(`[${category}] ${message}`);
		}
	}

	logError(message: string, error?: Loggable): void {
		if (error instanceof Error) {
			this.channel.error(`${message} - ${error.message}`);
			if (error.stack) {
				this.channel.error(error.stack);
			}
		} else if (error !== undefined) {
			this.channel.error(`${message} ${this.stringify(error)}`);
		} else {
			this.channel.error(message);
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
			return String(data);
		}

		if (Array.isArray(data)) {
			const items = data.map((item) => this.stringifyValue(item)).join(', ');
			return `[${items}]`;
		}

		if (typeof data === 'object') {
			const entries = Object.entries(data)
				.map(([key, value]) => `${key}=${this.stringifyValue(value)}`)
				.join(' ');
			return entries;
		}

		return String(data);
	}

	private stringifyValue(value: unknown): string {
		if (value === undefined || value === null) {
			return String(value);
		}
		if (typeof value === 'string') {
			return value;
		}
		if (typeof value === 'number' || typeof value === 'boolean') {
			return String(value);
		}
		if (Array.isArray(value)) {
			return `[${value.length} items]`;
		}
		if (typeof value === 'object') {
			return '[object]';
		}
		return String(value);
	}
}
