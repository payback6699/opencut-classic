import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { EditorBridge } from "./editor-bridge";

const TRANSCRIBE_TIMEOUT_MS = 15 * 60_000;
const EXPORT_TIMEOUT_MS = 60 * 60_000;

const timeRange = z.object({
	start: z.number().min(0).describe("Start of the range, in seconds"),
	end: z.number().min(0).describe("End of the range, in seconds"),
});

export function registerTools({
	server,
	bridge,
}: {
	server: McpServer;
	bridge: EditorBridge;
}): void {
	const call = async ({
		method,
		params,
		timeoutMs,
	}: {
		method: string;
		params?: Record<string, unknown>;
		timeoutMs?: number;
	}) => {
		try {
			const result = await bridge.request({ method, params, timeoutMs });
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(result, null, 2) },
				],
			};
		} catch (error) {
			return {
				isError: true,
				content: [
					{
						type: "text" as const,
						text: error instanceof Error ? error.message : String(error),
					},
				],
			};
		}
	};

	server.registerTool(
		"get_timeline",
		{
			title: "Get timeline",
			description:
				"Returns the open OpenCut project: duration, playhead, every track with its elements (id, type, start/end in seconds, media name, caption text) and the media library. Call this first and again after edits, because element ids change when clips are split.",
			inputSchema: {},
			annotations: { readOnlyHint: true },
		},
		() => call({ method: "get_timeline" }),
	);

	server.registerTool(
		"transcribe",
		{
			title: "Transcribe timeline audio",
			description:
				"Runs Whisper locally in the editor on the timeline's mixed audio and returns segments with start/end in timeline seconds. Can take minutes the first time while the model downloads.",
			inputSchema: {
				language: z
					.enum(["auto", "en", "es", "it", "fr", "de", "pt", "ru", "ja", "zh"])
					.optional()
					.describe('Spoken language, or "auto" to detect it'),
			},
			annotations: { readOnlyHint: true },
		},
		({ language }) =>
			call({
				method: "transcribe",
				params: { language: language ?? "auto" },
				timeoutMs: TRANSCRIBE_TIMEOUT_MS,
			}),
	);

	server.registerTool(
		"remove_time_ranges",
		{
			title: "Cut time ranges",
			description:
				"Removes the given ranges from every track and closes the gaps (a ripple delete across the whole timeline), as one undo step. Use timeline seconds from transcribe or get_timeline; pass all ranges in one call, in original timestamps.",
			inputSchema: {
				ranges: z.array(timeRange).min(1),
			},
			annotations: { destructiveHint: true },
		},
		({ ranges }) => call({ method: "remove_time_ranges", params: { ranges } }),
	);

	server.registerTool(
		"split_at",
		{
			title: "Split clips",
			description:
				"Splits clips at a time in seconds. Without elementIds it splits every clip under that time.",
			inputSchema: {
				time: z.number().min(0),
				elementIds: z.array(z.string()).optional(),
			},
		},
		({ time, elementIds }) =>
			call({ method: "split_at", params: { time, elementIds } }),
	);

	server.registerTool(
		"delete_elements",
		{
			title: "Delete clips",
			description:
				"Deletes elements by id without closing the gap. Use remove_time_ranges to cut and close gaps.",
			inputSchema: {
				elementIds: z.array(z.string()).min(1),
			},
			annotations: { destructiveHint: true },
		},
		({ elementIds }) =>
			call({ method: "delete_elements", params: { elementIds } }),
	);

	server.registerTool(
		"add_captions",
		{
			title: "Add captions",
			description:
				"Adds a new text track with one caption per entry, using OpenCut's subtitle style. Times are timeline seconds.",
			inputSchema: {
				captions: z
					.array(
						z.object({
							text: z.string().min(1),
							start: z.number().min(0),
							end: z.number().min(0),
						}),
					)
					.min(1),
			},
		},
		({ captions }) => call({ method: "add_captions", params: { captions } }),
	);

	server.registerTool(
		"export_video",
		{
			title: "Export video",
			description:
				"Renders the timeline in the editor and saves the file to the user's Downloads folder through the browser. Can take several minutes for long videos.",
			inputSchema: {
				format: z.enum(["mp4", "webm"]).optional(),
				quality: z.enum(["low", "medium", "high", "very_high"]).optional(),
			},
		},
		({ format, quality }) =>
			call({
				method: "export_video",
				params: { format, quality },
				timeoutMs: EXPORT_TIMEOUT_MS,
			}),
	);

	server.registerTool(
		"seek",
		{
			title: "Move playhead",
			description:
				"Moves the editor playhead to a time in seconds, e.g. to show the user an edit.",
			inputSchema: { time: z.number().min(0) },
		},
		({ time }) => call({ method: "seek", params: { time } }),
	);

	server.registerTool(
		"undo",
		{
			title: "Undo",
			description: "Undoes the last edit in the editor.",
			inputSchema: {},
		},
		() => call({ method: "undo" }),
	);

	server.registerTool(
		"redo",
		{
			title: "Redo",
			description: "Redoes the last undone edit in the editor.",
			inputSchema: {},
		},
		() => call({ method: "redo" }),
	);
}
