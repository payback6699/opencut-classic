import type { EditorCore } from "@/core";
import {
	DeleteElementsCommand,
	SplitElementsCommand,
	TracksSnapshotCommand,
	UpdateElementsCommand,
} from "@/commands";
import type { ElementRef, SceneTracks, TimelineTrack } from "@/timeline";
import {
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	type MediaTime,
	subMediaTime,
} from "@/wasm";
import type { TimeRange } from "./protocol";

function getAllTracks({ tracks }: { tracks: SceneTracks }): TimelineTrack[] {
	return [...tracks.overlay, tracks.main, ...tracks.audio];
}

/**
 * Sorts, clamps and merges overlapping ranges so each second of the timeline
 * is removed at most once.
 */
export function normalizeRanges({
	ranges,
	maxEnd,
}: {
	ranges: TimeRange[];
	maxEnd: number;
}): TimeRange[] {
	const sorted = ranges
		.map((range) => ({
			start: Math.max(0, Math.min(range.start, range.end)),
			end: Math.min(maxEnd, Math.max(range.start, range.end)),
		}))
		.filter((range) => range.end > range.start)
		.sort((a, b) => a.start - b.start);

	const merged: TimeRange[] = [];
	for (const range of sorted) {
		const last = merged[merged.length - 1];
		if (last && range.start <= last.end) {
			last.end = Math.max(last.end, range.end);
		} else {
			merged.push({ ...range });
		}
	}
	return merged;
}

function splitAllAt({
	editor,
	time,
}: {
	editor: EditorCore;
	time: MediaTime;
}): void {
	const tracks = editor.scenes.getActiveScene().tracks;
	const elements: ElementRef[] = [];
	for (const track of getAllTracks({ tracks })) {
		for (const element of track.elements) {
			if (
				element.startTime < time &&
				element.startTime + element.duration > time
			) {
				elements.push({ trackId: track.id, elementId: element.id });
			}
		}
	}
	if (elements.length === 0) {
		return;
	}
	new SplitElementsCommand({ elements, splitTime: time }).execute();
}

function cutRange({
	editor,
	start,
	end,
}: {
	editor: EditorCore;
	start: MediaTime;
	end: MediaTime;
}): void {
	splitAllAt({ editor, time: end });
	splitAllAt({ editor, time: start });

	const tracks = editor.scenes.getActiveScene().tracks;
	const toDelete: ElementRef[] = [];
	for (const track of getAllTracks({ tracks })) {
		for (const element of track.elements) {
			if (
				element.startTime >= start &&
				element.startTime + element.duration <= end
			) {
				toDelete.push({ trackId: track.id, elementId: element.id });
			}
		}
	}
	if (toDelete.length > 0) {
		new DeleteElementsCommand({ elements: toDelete }).execute();
	}

	const gap = subMediaTime({ a: end, b: start });
	const afterDelete = editor.scenes.getActiveScene().tracks;
	const shifts = getAllTracks({ tracks: afterDelete }).flatMap((track) =>
		track.elements
			.filter((element) => element.startTime >= end)
			.map((element) => ({
				trackId: track.id,
				elementId: element.id,
				patch: { startTime: subMediaTime({ a: element.startTime, b: gap }) },
			})),
	);
	if (shifts.length > 0) {
		new UpdateElementsCommand({ updates: shifts }).execute();
	}
}

const SPLIT_SUFFIX = / \((left|right)\)$/;

/**
 * Splitting appends " (left)" / " (right)" to clip names. A cut is one edit
 * from the user's point of view, so give the pieces their original names back.
 */
function restoreElementNames({
	before,
	after,
}: {
	before: SceneTracks;
	after: SceneTracks;
}): SceneTracks {
	const originalNames = new Set(
		getAllTracks({ tracks: before }).flatMap((track) =>
			track.elements.map((element) => element.name),
		),
	);
	const restore = <TTrack extends TimelineTrack>(track: TTrack): TTrack => {
		const elements = track.elements.map((element) => {
			let name = element.name;
			while (!originalNames.has(name) && SPLIT_SUFFIX.test(name)) {
				name = name.replace(SPLIT_SUFFIX, "");
			}
			return name === element.name ? element : { ...element, name };
		});
		return { ...track, elements } as TTrack;
	};
	return {
		overlay: after.overlay.map((track) => restore(track)),
		main: restore(after.main),
		audio: after.audio.map((track) => restore(track)),
	};
}

/**
 * Removes the given timeline ranges from every track and closes the gaps,
 * like a ripple delete across the whole timeline. Recorded as a single undo
 * step.
 */
export function removeTimeRanges({
	editor,
	ranges,
}: {
	editor: EditorCore;
	ranges: TimeRange[];
}): { removed: TimeRange[]; removedSeconds: number } {
	const maxEnd = mediaTimeToSeconds({
		time: editor.timeline.getTotalDuration(),
	});
	const removed = normalizeRanges({ ranges, maxEnd });
	if (removed.length === 0) {
		return { removed, removedSeconds: 0 };
	}

	const before = editor.scenes.getActiveScene().tracks;

	// Cut from the end of the timeline backwards so earlier ranges keep
	// their original timestamps while later ones are being removed.
	for (const range of [...removed].reverse()) {
		cutRange({
			editor,
			start: mediaTimeFromSeconds({ seconds: range.start }),
			end: mediaTimeFromSeconds({ seconds: range.end }),
		});
	}

	const after = restoreElementNames({
		before,
		after: editor.scenes.getActiveScene().tracks,
	});
	editor.timeline.updateTracks(before);

	// The cut already closes the gaps, so the editor's own ripple mode must
	// not shift elements a second time.
	const wasRippleEnabled = editor.command.isRippleEnabled;
	editor.command.isRippleEnabled = false;
	try {
		editor.command.execute({
			command: new TracksSnapshotCommand({ before, after }),
		});
	} finally {
		editor.command.isRippleEnabled = wasRippleEnabled;
	}

	const removedSeconds = removed.reduce(
		(sum, range) => sum + (range.end - range.start),
		0,
	);
	return { removed, removedSeconds };
}
