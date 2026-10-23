import type { EditorCore } from "@/core";
import { handleAgentRequest } from "./handlers";
import {
	AGENT_BRIDGE_PROTOCOL_VERSION,
	type AgentBridgeRequest,
	type EditorToServerMessage,
} from "./protocol";

const MIN_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 10_000;

/**
 * Keeps a WebSocket open to the local MCP server and answers its requests
 * against the editor. Returns a function that closes the connection.
 */
export function startAgentBridge({
	editor,
	url,
}: {
	editor: EditorCore;
	url: string;
}): () => void {
	let socket: WebSocket | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let stopped = false;
	let reconnectDelay = MIN_RECONNECT_DELAY_MS;

	const send = ({ message }: { message: EditorToServerMessage }) => {
		if (socket?.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify(message));
		}
	};

	const handleRequest = async ({
		request,
	}: {
		request: AgentBridgeRequest;
	}) => {
		try {
			const result = await handleAgentRequest({
				editor,
				method: request.method,
				params: request.params ?? {},
			});
			send({ message: { type: "response", id: request.id, result } });
		} catch (error) {
			send({
				message: {
					type: "response",
					id: request.id,
					error: error instanceof Error ? error.message : String(error),
				},
			});
		}
	};

	const connect = () => {
		if (stopped) return;
		socket = new WebSocket(url);

		socket.addEventListener("open", () => {
			reconnectDelay = MIN_RECONNECT_DELAY_MS;
			const project = editor.project.getActiveOrNull();
			send({
				message: {
					type: "hello",
					protocolVersion: AGENT_BRIDGE_PROTOCOL_VERSION,
					projectId: project?.metadata.id ?? null,
					projectName: project?.metadata.name ?? null,
				},
			});
		});

		socket.addEventListener("message", (event) => {
			let request: AgentBridgeRequest;
			try {
				request = JSON.parse(String(event.data));
			} catch {
				return;
			}
			if (request.type === "request" && typeof request.id === "string") {
				void handleRequest({ request });
			}
		});

		socket.addEventListener("close", () => {
			socket = null;
			if (!stopped) {
				// Back off while the MCP server is not running, so an idle editor
				// does not keep logging failed connections.
				reconnectTimer = setTimeout(connect, reconnectDelay);
				reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
			}
		});
	};

	connect();

	return () => {
		stopped = true;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		socket?.close();
	};
}
