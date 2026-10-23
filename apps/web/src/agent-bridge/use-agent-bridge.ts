"use client";

import { useEffect } from "react";
import { EditorCore } from "@/core";
import { startAgentBridge } from "./client";

/**
 * Connects the open project to the local MCP server so Claude can edit it.
 * Off unless NEXT_PUBLIC_AGENT_BRIDGE_URL is set (e.g. ws://localhost:7777).
 */
export function useAgentBridge() {
	useEffect(() => {
		const url = process.env.NEXT_PUBLIC_AGENT_BRIDGE_URL;
		if (!url) return;
		return startAgentBridge({ editor: EditorCore.getInstance(), url });
	}, []);
}
