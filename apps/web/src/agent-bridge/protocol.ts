/**
 * Wire format between the editor tab and the local MCP server
 * (`apps/mcp`). The server sends requests, the editor answers them.
 * All times on the wire are in seconds.
 */

export const AGENT_BRIDGE_PROTOCOL_VERSION = 1;

export type AgentBridgeRequest = {
	type: "request";
	id: string;
	method: string;
	params?: Record<string, unknown>;
};

export type AgentBridgeResponse =
	| { type: "response"; id: string; result: unknown }
	| { type: "response"; id: string; error: string };

export type AgentBridgeHello = {
	type: "hello";
	protocolVersion: number;
	projectId: string | null;
	projectName: string | null;
};

export type EditorToServerMessage = AgentBridgeResponse | AgentBridgeHello;

export type TimeRange = { start: number; end: number };
