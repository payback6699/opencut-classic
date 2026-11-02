import type { EditorCore } from "@/core";
import type { ElementRef, SceneTracks, TimelineTrack } from "@/timeline";
import {
	addMediaTime,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	type MediaTime,
} from "@/wasm";
import { extractTimelineAudio } from "@/media/mediabunny";
import { decodeAudioToFloat32 } from "@/media/audio";
import { DEFAULT_TRANSCRIPTION_SAMPLE_RATE } from "@/transcription/audio";
import { TRANSCRIPTION_LANGUAGES } from "@/transcription/supported-languages";
import type { TranscriptionLanguage } from "@/transcription/types";
import { transcriptionService } from "@/services/transcription/service";
import { insertCaptionChunksAsTextTrack } from "@/subtitles/insert";
import { processMediaAssets } from "@/media/processing";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { DEFAULT_NEW_ELEMENT_DURATION } from "@/timeline/creation";
import { AddMediaAssetCommand } from "@/commands/media";
import { InsertElementCommand } from "@/commands/timeline";
import { BatchCommand } from "@/commands";
import { DEFAULT_EXPORT_OPTIONS } from "@/export/defaults";
import {
	EXPORT_FORMAT_VALUES,
	EXPORT_QUALITY_VALUES,
	downloadBuffer,
	getExportFileExtension,
	getExportMimeType,
	type ExportFormat,
	type ExportQuality,
} from "@/export";
import { removeTimeRanges } from "./remove-ranges";
import type { TimeRange } from "./protocol";

type Params = Record<string, unknown>;
type Handler = (args: {
	editor: EditorCore;
	params: Params;
}) => unknown | Promise<unknown>;

function seconds({ time }: { time: MediaTime }): number {
	return Math.round(mediaTimeToSeconds({ time }) * 1000) / 1000;
}

function getAllTracks({ tracks }: { tracks: SceneTracks }): TimelineTrack[] {
	return [...tracks.overlay, tracks.main, ...tracks.audio];
}

function requireNumber({
	params,
	key,
}: {
	params: Params;
	key: string;
}): number {
	const value = params[key];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`"${key}" must be a number of seconds`);
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function requireRecords({
	params,
	key,
}: {
	params: Params;
	key: string;
}): Record<string, unknown>[] {
	const value: unknown = params[key];
	if (!Array.isArray(value) || !value.every(isRecord)) {
		throw new Error(`"${key}" must be an array of objects`);
	}
	return value;
}

function readStringArray({
	params,
	key,
}: {
	params: Params;
	key: string;
}): string[] | null {
	const value: unknown = params[key];
	if (value === undefined) return null;
	if (
		!Array.isArray(value) ||
		!value.every((item): item is string => typeof item === "string")
	) {
		throw new Error(`"${key}" must be an array of strings`);
	}
	return value;
}

function requireRanges({ params }: { params: Params }): TimeRange[] {
	return requireRecords({ params, key: "ranges" }).map((range, index) => {
		const { start, end } = range;
		if (typeof start !== "number" || typeof end !== "number") {
			throw new Error(`ranges[${index}] needs numeric start and end`);
		}
		return { start, end };
	});
}

/**
 * import_media and export_video move whole video files, so they only talk to
 * services on this machine. A prompt-injected agent must not be able to send
 * the project to, or pull files from, the internet.
 */
function requireLocalUrl({
	params,
	key,
}: {
	params: Params;
	key: string;
}): URL {
	const value = params[key];
	if (typeof value !== "string") {
		throw new Error(`"${key}" must be a URL`);
	}
	const url = new URL(value);
	const isLocal =
		url.protocol === "http:" &&
		(url.hostname === "localhost" || url.hostname === "127.0.0.1");
	if (!isLocal) {
		throw new Error(`"${key}" must be an http://localhost URL`);
	}
	return url;
}

function isTranscriptionLanguage(
	value: unknown,
): value is TranscriptionLanguage {
	return (
		value === "auto" ||
		TRANSCRIPTION_LANGUAGES.some((entry) => entry.code === value)
	);
}

function findElementRefs({
	editor,
	elementIds,
}: {
	editor: EditorCore;
	elementIds: string[];
}): ElementRef[] {
	const tracks = editor.scenes.getActiveScene().tracks;
	const refs: ElementRef[] = [];
	for (const track of getAllTracks({ tracks })) {
		for (const element of track.elements) {
			if (elementIds.includes(element.id)) {
				refs.push({ trackId: track.id, elementId: element.id });
			}
		}
	}
	return refs;
}

function describeTimeline({ editor }: { editor: EditorCore }) {
	const project = editor.project.getActive();
	const tracks = editor.scenes.getActiveScene().tracks;
	const mediaById = new Map(
		editor.media.getAssets().map((asset) => [asset.id, asset]),
	);
	const { numerator, denominator } = project.settings.fps;

	return {
		project: {
			id: project.metadata.id,
			name: project.metadata.name,
			fps: numerator / denominator,
			canvasSize: project.settings.canvasSize,
		},
		duration: seconds({ time: editor.timeline.getTotalDuration() }),
		playhead: seconds({ time: editor.playback.getCurrentTime() }),
		tracks: getAllTracks({ tracks }).map((track) => ({
			id: track.id,
			name: track.name,
			type: track.type,
			isMain: track.id === tracks.main.id,
			elements: track.elements.map((element) => {
				const mediaId = "mediaId" in element ? element.mediaId : undefined;
				return {
					id: element.id,
					name: element.name,
					type: element.type,
					start: seconds({ time: element.startTime }),
					end: seconds({
						time: addMediaTime({ a: element.startTime, b: element.duration }),
					}),
					...(mediaId
						? {
								media: mediaById.get(mediaId)?.name ?? mediaId,
								sourceStart: seconds({ time: element.trimStart }),
							}
						: {}),
					...(element.type === "text" &&
					typeof element.params.content === "string"
						? { text: element.params.content }
						: {}),
				};
			}),
		})),
		media: editor.media.getAssets().map((asset) => ({
			id: asset.id,
			name: asset.name,
			type: asset.type,
			duration: asset.duration,
			hasAudio: asset.hasAudio,
		})),
	};
}

const handlers: Record<string, Handler> = {
	get_timeline: ({ editor }) => describeTimeline({ editor }),

	transcribe: async ({ editor, params }) => {
		const language = isTranscriptionLanguage(params.language)
			? params.language
			: "auto";
		const audioBlob = await extractTimelineAudio({
			tracks: editor.scenes.getActiveScene().tracks,
			mediaAssets: editor.media.getAssets(),
			totalDuration: editor.timeline.getTotalDuration(),
		});
		const { samples } = await decodeAudioToFloat32({
			audioBlob,
			sampleRate: DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
		});
		const result = await transcriptionService.transcribe({
			audioData: samples,
			language,
		});
		return {
			text: result.text,
			segments: result.segments.map((segment) => ({
				start: Math.round(segment.start * 1000) / 1000,
				end: Math.round(segment.end * 1000) / 1000,
				text: segment.text.trim(),
			})),
		};
	},

	remove_time_ranges: ({ editor, params }) => {
		const result = removeTimeRanges({
			editor,
			ranges: requireRanges({ params }),
		});
		return {
			...result,
			newDuration: seconds({ time: editor.timeline.getTotalDuration() }),
		};
	},

	split_at: ({ editor, params }) => {
		const time = mediaTimeFromSeconds({
			seconds: requireNumber({ params, key: "time" }),
		});
		const elementIds = readStringArray({ params, key: "elementIds" });
		const tracks = editor.scenes.getActiveScene().tracks;
		const elements = elementIds
			? findElementRefs({ editor, elementIds })
			: getAllTracks({ tracks }).flatMap((track) =>
					track.elements
						.filter(
							(element) =>
								element.startTime < time &&
								element.startTime + element.duration > time,
						)
						.map((element) => ({ trackId: track.id, elementId: element.id })),
				);
		if (elements.length === 0) {
			return { split: 0 };
		}
		const rightSide = editor.timeline.splitElements({
			elements,
			splitTime: time,
		});
		return {
			split: elements.length,
			newElementIds: rightSide.map((ref) => ref.elementId),
		};
	},

	delete_elements: ({ editor, params }) => {
		const elementIds = readStringArray({ params, key: "elementIds" });
		if (!elementIds) {
			throw new Error(`"elementIds" is required`);
		}
		const elements = findElementRefs({ editor, elementIds });
		if (elements.length > 0) {
			editor.timeline.deleteElements({ elements });
		}
		return { deleted: elements.length };
	},

	add_captions: ({ editor, params }) => {
		const captions = requireRecords({ params, key: "captions" }).flatMap(
			({ text, start, end }) =>
				typeof text === "string" &&
				text.trim() !== "" &&
				typeof start === "number" &&
				typeof end === "number" &&
				end > start
					? [{ text: text.trim(), startTime: start, duration: end - start }]
					: [],
		);
		const trackId = insertCaptionChunksAsTextTrack({ editor, captions });
		return { trackId, inserted: trackId ? captions.length : 0 };
	},

	import_media: async ({ editor, params }) => {
		const url = requireLocalUrl({ params, key: "url" });
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`Could not download ${url}: ${response.status}`);
		}
		const blob = await response.blob();
		const name =
			typeof params.name === "string" && params.name.trim() !== ""
				? params.name.trim()
				: (url.pathname.split("/").pop() ?? "media");
		const [asset] = await processMediaAssets({
			files: [new File([blob], name, { type: blob.type })],
		});
		if (!asset) {
			throw new Error(`OpenCut could not read ${name}`);
		}

		if (params.clearTimeline === true) {
			const tracks = editor.scenes.getActiveScene().tracks;
			const elements = getAllTracks({ tracks }).flatMap((track) =>
				track.elements.map((element) => ({
					trackId: track.id,
					elementId: element.id,
				})),
			);
			if (elements.length > 0) {
				editor.timeline.deleteElements({ elements });
			}
		}
		if (params.fitCanvas === true && asset.width && asset.height) {
			await editor.project.updateSettings({
				settings: { canvasSize: { width: asset.width, height: asset.height } },
			});
		}

		const project = editor.project.getActive();
		const addMediaCmd = new AddMediaAssetCommand({
			projectId: project.metadata.id,
			asset,
		});
		const element = buildElementFromMedia({
			mediaId: addMediaCmd.getAssetId(),
			mediaType: asset.type,
			name: asset.name,
			duration:
				asset.duration != null
					? mediaTimeFromSeconds({ seconds: asset.duration })
					: DEFAULT_NEW_ELEMENT_DURATION,
			startTime: mediaTimeFromSeconds({
				seconds: typeof params.start === "number" ? params.start : 0,
			}),
			buffer:
				asset.type === "audio"
					? new AudioBuffer({ length: 1, sampleRate: 44100 })
					: undefined,
		});
		editor.command.execute({
			command: new BatchCommand([
				addMediaCmd,
				new InsertElementCommand({
					element,
					placement: {
						mode: "auto",
						trackType: asset.type === "audio" ? "audio" : "video",
					},
				}),
			]),
		});
		return {
			mediaId: addMediaCmd.getAssetId(),
			name: asset.name,
			type: asset.type,
			duration: asset.duration ?? null,
			width: asset.width ?? null,
			height: asset.height ?? null,
			timelineDuration: seconds({ time: editor.timeline.getTotalDuration() }),
		};
	},

	export_video: async ({ editor, params }) => {
		const format: ExportFormat = EXPORT_FORMAT_VALUES.includes(
			params.format as ExportFormat,
		)
			? (params.format as ExportFormat)
			: DEFAULT_EXPORT_OPTIONS.format;
		const quality: ExportQuality = EXPORT_QUALITY_VALUES.includes(
			params.quality as ExportQuality,
		)
			? (params.quality as ExportQuality)
			: DEFAULT_EXPORT_OPTIONS.quality;
		const uploadUrl =
			params.uploadUrl === undefined
				? null
				: requireLocalUrl({ params, key: "uploadUrl" });

		const result = await editor.project.export({
			options: { ...DEFAULT_EXPORT_OPTIONS, format, quality },
		});
		editor.project.clearExportState();
		if (!result.success || !result.buffer) {
			throw new Error(
				result.cancelled
					? "Export cancelled"
					: (result.error ?? "Export failed"),
			);
		}

		const mimeType = getExportMimeType({ format });
		const filename = `${editor.project.getActive().metadata.name}${getExportFileExtension({ format })}`;
		if (!uploadUrl) {
			downloadBuffer({ buffer: result.buffer, filename, mimeType });
			return { bytes: result.buffer.byteLength, downloaded: filename };
		}
		const upload = await fetch(uploadUrl, {
			method: "POST",
			headers: { "content-type": mimeType },
			body: result.buffer,
		});
		if (!upload.ok) {
			throw new Error(`Upload to ${uploadUrl.origin} failed: ${upload.status}`);
		}
		return { bytes: result.buffer.byteLength, uploaded: true, format };
	},

	seek: ({ editor, params }) => {
		editor.playback.seek({
			time: mediaTimeFromSeconds({
				seconds: requireNumber({ params, key: "time" }),
			}),
		});
		return { playhead: seconds({ time: editor.playback.getCurrentTime() }) };
	},

	undo: ({ editor }) => {
		const didUndo = editor.command.canUndo();
		editor.command.undo();
		return { undone: didUndo };
	},

	redo: ({ editor }) => {
		const didRedo = editor.command.canRedo();
		editor.command.redo();
		return { redone: didRedo };
	},
};

export async function handleAgentRequest({
	editor,
	method,
	params,
}: {
	editor: EditorCore;
	method: string;
	params: Params;
}): Promise<unknown> {
	const handler = handlers[method];
	if (!handler) {
		throw new Error(`Unknown method "${method}"`);
	}
	if (!editor.project.getActiveOrNull()) {
		throw new Error("No project is open in the editor");
	}
	return handler({ editor, params });
}
