import { WebSocketServer, type WebSocket } from "ws";

/**
 * Mirrors apps/web/src/agent-bridge/protocol.ts. The editor tab connects to
 * this server, and every MCP tool call becomes one request to that tab.
 */
type EditorMessage =
	| { type: "response"; id: string; result?: unknown; error?: string }
	| {
			type: "hello";
			protocolVersion: number;
			projectId: string | null;
			projectName: string | null;
	  };

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

export type EditorInfo = {
	projectId: string | null;
	projectName: string | null;
};

export class EditorBridge {
	private server: WebSocketServer;
	private editor: WebSocket | null = null;
	private editorInfo: EditorInfo | null = null;
	private pending = new Map<string, PendingRequest>();
	private nextId = 1;

	constructor({
		host,
		port,
		allowedOrigins,
		log,
	}: {
		host: string;
		port: number;
		allowedOrigins: string[];
		log: (message: string) => void;
	}) {
		this.server = new WebSocketServer({
			host,
			port,
			// Any web page can open a WebSocket to localhost, so only accept the
			// OpenCut origins we were told about.
			verifyClient: ({ origin }: { origin: string }) =>
				allowedOrigins.includes(origin),
		});

		this.server.on("listening", () => {
			log(`Waiting for the OpenCut editor on ws://${host}:${port}`);
		});

		this.server.on("connection", (socket) => {
			// The most recently opened editor tab wins.
			this.editor?.close();
			this.editor = socket;
			this.editorInfo = null;

			socket.on("message", (data) => {
				let message: EditorMessage;
				try {
					message = JSON.parse(String(data));
				} catch {
					return;
				}
				if (message.type === "hello") {
					this.editorInfo = {
						projectId: message.projectId,
						projectName: message.projectName,
					};
					log(`Editor connected: ${message.projectName ?? "no project"}`);
					return;
				}
				const request = this.pending.get(message.id);
				if (!request) return;
				this.pending.delete(message.id);
				clearTimeout(request.timer);
				if (message.error !== undefined) {
					request.reject(new Error(message.error));
				} else {
					request.resolve(message.result);
				}
			});

			socket.on("close", () => {
				if (this.editor !== socket) return;
				this.editor = null;
				this.editorInfo = null;
				log("Editor disconnected");
			});
		});
	}

	getEditorInfo(): EditorInfo | null {
		return this.editor ? this.editorInfo : null;
	}

	request({
		method,
		params = {},
		timeoutMs = 30_000,
	}: {
		method: string;
		params?: Record<string, unknown>;
		timeoutMs?: number;
	}): Promise<unknown> {
		const editor = this.editor;
		if (!editor || editor.readyState !== editor.OPEN) {
			return Promise.reject(
				new Error(
					"The OpenCut editor is not connected. Open a project in the editor started with NEXT_PUBLIC_AGENT_BRIDGE_URL set.",
				),
			);
		}

		const id = String(this.nextId++);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`The editor did not answer "${method}" in time`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			editor.send(JSON.stringify({ type: "request", id, method, params }));
		});
	}

	close(): void {
		for (const request of this.pending.values()) {
			clearTimeout(request.timer);
			request.reject(new Error("Bridge closed"));
		}
		this.pending.clear();
		this.server.close();
	}
}
