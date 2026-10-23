# OpenCut MCP server

Lets Claude (Claude Desktop, Claude Code or any MCP client) edit the project
you have open in the OpenCut editor: read the timeline, transcribe it, cut
ranges, split clips and add captions.

```
Claude ──stdio (MCP)──▶ apps/mcp ──WebSocket ws://localhost:7777──▶ editor tab
```

The editor still does all the work in your browser. The MCP server only
forwards each tool call to the open editor tab and returns its answer, so
media never leaves your machine.

## Setup

1. Install dependencies from the repo root: `bun install`.
2. Add this line to `apps/web/.env.local` (next to the variables the web app
   already needs):

   ```
   NEXT_PUBLIC_AGENT_BRIDGE_URL=ws://localhost:7777
   ```

3. Start the editor with `bun run dev:web` and open a project at
   http://localhost:3000.
4. Register the MCP server with Claude.

   **Claude Code**

   ```sh
   claude mcp add opencut -- bun /absolute/path/to/opencut-classic/apps/mcp/src/index.ts
   ```

   **Claude Desktop**: in Settings → Developer → Edit Config, add:

   ```json
   {
     "mcpServers": {
       "opencut": {
         "command": "bun",
         "args": ["C:\\path\\to\\opencut-classic\\apps\\mcp\\src\\index.ts"]
       }
     }
   }
   ```

   Restart Claude Desktop afterwards. On Windows, if `bun` is not found, use
   the full path to `bun.exe` as `command`.

When Claude starts the server, the editor tab connects within a few seconds.
Only one editor tab is used at a time; the most recently connected one wins.

## Tools

| Tool | What it does |
| --- | --- |
| `get_timeline` | Project info, every track and clip (start/end in seconds, source offset, caption text) and the media library |
| `transcribe` | Runs Whisper locally in the editor on the timeline audio and returns timed segments |
| `remove_time_ranges` | Cuts ranges out of every track and closes the gaps, as a single undo step |
| `split_at` | Splits the clips under a time (or only the given clips) |
| `delete_elements` | Deletes clips by id, leaving the gap |
| `add_captions` | Adds a caption track from `{ text, start, end }` entries |
| `seek` | Moves the playhead |
| `undo` / `redo` | Editor undo history |

All times are timeline seconds. Every edit goes through the editor's command
history, so you can also undo with Ctrl+Z.

## Example prompts

- "Transcribe the video and remove the silences longer than one second."
- "Cut out every part where I talk about pricing."
- "Remove the filler words and add Spanish captions."

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENCUT_BRIDGE_PORT` | `7777` | WebSocket port the editor connects to |
| `OPENCUT_ALLOWED_ORIGINS` | `http://localhost:3000` | Comma-separated origins allowed to connect as the editor |

The server listens on `127.0.0.1` only and refuses WebSocket connections from
other origins, so a random website cannot pose as your editor.
