# FitFileSize MCP server

Let your AI assistant make a PDF or image fit an upload limit, or a form's exact rules, with [FitFileSize](https://fitfilesize.com).

> "Make ~/Downloads/signature.jpg fit the IBPS signature rules"
>
> Saved ~/Downloads/signature.fit.jpg for IBPS signature (JPEG, 140 × 60 pixels, 10 KB to 20 KB): 10,240 bytes (10.0 KB), under the 20,000 bytes limit.

- **Any limit:** "get this scan under 300 KB", "this photo under 50 KB".
- **Form presets:** US visa photo (DS-160), Indian e-Visa passport page and photo, IBPS, SBI, RRB, SSC, NEET and JEE Main uploads, IRCC documents. The preset sets the size limit, the minimum size and the exact pixels. Ask for `list_forms` to see them all.
- **Several files at once:** "fit these five documents under 2 MB each".
- Keeps as much quality as the limit allows, and saves the result next to the original as `<name>.fit.<ext>`. Every file keeps its format (a PNG stays a PNG) unless you say a JPEG is fine; iPhone HEIC photos come back as JPEG.
- Free, no account, no API key. Files up to 50 MB.

## Setup

Needs Node.js 20.10 or newer.

**Claude Code**

```bash
claude mcp add fitfilesize -- npx -y fitfilesize-mcp
```

**Claude Desktop, Cursor, Windsurf and other clients** that use an `mcpServers` config file:

```json
{
  "mcpServers": {
    "fitfilesize": {
      "command": "npx",
      "args": ["-y", "fitfilesize-mcp"]
    }
  }
}
```

(Claude Desktop: Settings → Developer → Edit Config. Cursor: `~/.cursor/mcp.json`.)

**VS Code** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "fitfilesize": { "command": "npx", "args": ["-y", "fitfilesize-mcp"] }
  }
}
```

## Tools

### `fit_file`

| Argument | |
|---|---|
| `path` | Full path to the file (`~/` works). PDF, JPEG, PNG, WebP, TIFF, BMP or HEIC (returned as JPEG), up to 50 MB. |
| `paths` | Instead of `path`: up to 10 files that share the same limit. Each is saved beside its original; one that fails is reported without stopping the rest. |
| `limit` | The upload limit, like `"200KB"` or `"1.5MB"`. KB and MB are 1000-based, so the result passes a check done either way. |
| `form` | Instead of `limit`: a form preset from `list_forms`, like `"ibps-photo"`. |
| `width`, `height` | Optional exact pixel size, images only. |
| `fit` | `"crop"` (default) or `"pad"` with white, when the pixel size changes the shape. |
| `minimum` | Optional smallest size, like `"10KB"`. A small JPEG is padded up to it; the picture is unchanged. |
| `jpeg_ok` | Optional. `true` lets a PNG, WebP, TIFF or BMP come back as a JPEG when that is what fits. Off by default; when it would have helped, the result says so. |
| `output` | Optional path for the result, with `path` only. |

### `list_forms`

The form presets, each with its rules and the official source they come from. The list is read from [fitfilesize.com/forms.json](https://fitfilesize.com/forms.json), so new forms appear without an update; a copy is bundled for when the site cannot be reached.

## Privacy

The file is sent to FitFileSize's server over HTTPS, compressed there, and deleted as soon as the result is saved on your computer. Requests name the package and its version (`fitfilesize-mcp/0.2.0`), nothing about you. Nothing else leaves your machine. See the [privacy page](https://fitfilesize.com/privacy.html). Uploads count against the site's free limit of 30 an hour.

## Development

```bash
npm install
npm test          # the tools through an MCP client, against a stand-in API
npm run build     # bundles the form presets from the website's data
```

`FITFILESIZE_API` points the server at another API, such as a local one (`http://127.0.0.1:8000`).

## Licence

MIT, see [LICENSE](LICENSE). This covers the MCP server in this folder; the rest of the FitFileSize repository is not open source.
