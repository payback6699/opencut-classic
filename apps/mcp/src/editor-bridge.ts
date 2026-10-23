import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { IncomingMessage } from "node:http";

/**
 * Mirrors apps/web/src/agent-bridge/protocol.ts. The editor tab connects to
 * this server, and every MCP tool call becomes one request to that tab.
 *
 * Claude Desktop can start several copies of this server at once (one per
 * chat, Cowork or Code session), but only one can own the port. The first
 * copy becomes the hub that the editor connects to; later copies connect to
 * the hub on PEER_PATH and send their requests through it. When the hub
 * exits, a peer takes over the port.
 */
type EditorMessage =
	| { type: "response"; id: string; result?: unknown; error?: string }
	| {
			type: "hello";
			protocolVersion: number;
			projectId: string | null;
			projectName: string | null;
	  };

type BridgeRequest = {
	type: "request";
	id: string;
	method: string;
	params?: Record<string, unknown>;
};

type BridgeResponse = {
	type: "response";
	id: string;
	result?: unknown;
	error?: string;
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

const PEER_PATH = "/peer";
const ROLE_RETRY_MS = 2000;

const NOT_CONNECTED_MESSAGE =
	"The OpenCut editor is not connected. Open a project in the editor started with NEXT_PUBLIC_AGENT_BRIDGE_URL set.";

function parseMessage<T>({ data }: { data: RawData }): T | null {
	try {
		return JSON.parse(String(data)) as T;
	} catch {
		return null;
	}
}

export class EditorBridge {
	private readonly host: string;
	private readonly port: number;
	private readonly allowedOrigins: string[];
	private readonly log: (message: string) => void;

	private server: WebSocketServer | null = null;
	private hub: WebSocket | null = null;
	private editor: WebSocket | null = null;
	private editorInfo: EditorInfo | null = null;
	private pending = new Map<string, PendingRequest>();
	private nextId = 1;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private closed = false;

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
		this.host = host;
		this.port = port;
		this.allowedOrigins = allowedOrigins;
		this.log = log;
		this.becomeHub();
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
		const target = this.editor ?? this.hub;
		if (!target || target.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error(NOT_CONNECTED_MESSAGE));
		}

		const id = String(this.nextId++);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`The editor did not answer "${method}" in time`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			target.send(
				JSON.stringify({
					type: "request",
					id,
					method,
					params,
				} satisfies BridgeRequest),
			);
		});
	}

	close(): void {
		this.closed = true;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		for (const request of this.pending.values()) {
			clearTimeout(request.timer);
			request.reject(new Error("Bridge closed"));
		}
		this.pending.clear();
		this.hub?.close();
		this.server?.close();
	}

	private settle({ response }: { response: BridgeResponse }): void {
		const request = this.pending.get(response.id);
		if (!request) return;
		this.pending.delete(response.id);
		clearTimeout(request.timer);
		if (response.error !== undefined) {
			request.reject(new Error(response.error));
		} else {
			request.resolve(response.result);
		}
	}

	private scheduleRoleRetry(): void {
		if (this.closed || this.retryTimer) return;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			this.becomeHub();
		}, ROLE_RETRY_MS);
	}

	private becomeHub(): void {
		if (this.closed) return;
		const server = new WebSocketServer({
			host: this.host,
			port: this.port,
			verifyClient: ({
				origin,
				req,
			}: {
				origin?: string;
				req: IncomingMessage;
			}) =>
				req.url === PEER_PATH
					? // Browsers always send Origin, so a page cannot pose as a peer.
						origin === undefined
					: // Any web page can open a WebSocket to localhost, so only accept
						// the OpenCut origins we were told about.
						origin !== undefined && this.allowedOrigins.includes(origin),
		});

		server.on("error", (error: NodeJS.ErrnoException) => {
			server.close();
			// Usually EADDRINUSE, but runtimes word this differently (Bun on
			// Windows), so try the existing hub; if there is none, becomePeer
			// falls back to retrying the port.
			if (error.code !== "EADDRINUSE") {
				this.log(`Could not listen on port ${this.port}: ${error.message}`);
			}
			this.becomePeer();
		});

		server.on("listening", () => {
			this.server = server;
			this.log(
				`Waiting for the OpenCut editor on ws://${this.host}:${this.port}`,
			);
		});

		server.on("connection", (socket, req) => {
			if (req.url === PEER_PATH) {
				this.servePeer({ socket });
			} else {
				this.serveEditor({ socket });
			}
		});
	}

	private becomePeer(): void {
		if (this.closed) return;
		const hub = new WebSocket(`ws://${this.host}:${this.port}${PEER_PATH}`);

		hub.on("open", () => {
			this.hub = hub;
			this.log(
				"Another OpenCut MCP server owns the port; sending requests through it",
			);
		});

		hub.on("message", (data) => {
			const response = parseMessage<BridgeResponse>({ data });
			if (response?.type === "response") {
				this.settle({ response });
			}
		});

		hub.on("error", () => {
			// "close" follows and handles the retry.
		});

		hub.on("close", () => {
			if (this.hub === hub) this.hub = null;
			this.scheduleRoleRetry();
		});
	}

	private serveEditor({ socket }: { socket: WebSocket }): void {
		// The most recently opened editor tab wins.
		this.editor?.close();
		this.editor = socket;
		this.editorInfo = null;

		socket.on("message", (data) => {
			const message = parseMessage<EditorMessage>({ data });
			if (!message) return;
			if (message.type === "hello") {
				this.editorInfo = {
					projectId: message.projectId,
					projectName: message.projectName,
				};
				this.log(`Editor connected: ${message.projectName ?? "no project"}`);
				return;
			}
			this.settle({ response: message });
		});

		socket.on("close", () => {
			if (this.editor !== socket) return;
			this.editor = null;
			this.editorInfo = null;
			this.log("Editor disconnected");
		});
	}

	private servePeer({ socket }: { socket: WebSocket }): void {
		socket.on("message", async (data) => {
			const request = parseMessage<BridgeRequest>({ data });
			if (request?.type !== "request") return;
			const reply = (response: Omit<BridgeResponse, "type" | "id">) => {
				if (socket.readyState === WebSocket.OPEN) {
					socket.send(
						JSON.stringify({ type: "response", id: request.id, ...response }),
					);
				}
			};
			try {
				// Peers apply their own timeout, so give the editor the longest one.
				const result = await this.request({
					method: request.method,
					params: request.params,
					timeoutMs: 60 * 60_000,
				});
				reply({ result });
			} catch (error) {
				reply({
					error: error instanceof Error ? error.message : String(error),
				});
			}
		});
	}
}
