#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EditorBridge } from "./editor-bridge";
import { registerTools } from "./tools";

// stdout carries the MCP protocol, so everything human-readable goes to stderr.
const log = (message: string) => console.error(`[opencut-mcp] ${message}`);

const bridge = new EditorBridge({
	host: "127.0.0.1",
	port: Number(process.env.OPENCUT_BRIDGE_PORT ?? 7777),
	allowedOrigins: (
		process.env.OPENCUT_ALLOWED_ORIGINS ?? "http://localhost:3000"
	)
		.split(",")
		.map((origin) => origin.trim())
		.filter(Boolean),
	log,
});

const server = new McpServer({ name: "opencut", version: "0.1.0" });
registerTools({ server, bridge });

await server.connect(new StdioServerTransport());
log("MCP server ready on stdio");

const shutdown = () => {
	bridge.close();
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// The WebSocket server would otherwise keep the process alive after the MCP
// client goes away, holding the port for the next launch.
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
