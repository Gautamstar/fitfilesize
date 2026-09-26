/**
 * The MCP server: two tools over the FitFileSize API.
 *
 * - fit_file: compress a file on this computer to a size limit, or to a
 *   form's rules by name, and save the result beside it.
 * - list_forms: the forms with presets, and their rules.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import { DEFAULT_API, FitError, fitFile } from './api.js'
import { findForm, loadForms, type Form } from './forms.js'

export const VERSION = '0.1.0'

export interface ServerOptions {
  api?: string
  fetchImpl?: typeof fetch
  pollMs?: number
  loadFormsImpl?: () => Promise<Form[]>
}

/** "10240" -> "10,240 bytes (10.0 KB)". KB here is 1024 bytes, as file managers show. */
function size(bytes: number): string {
  const kb = bytes / 1024
  const human = kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb.toFixed(1)} KB`
  return `${bytes.toLocaleString('en-US')} bytes (${human})`
}

function describeForm(f: Form): string {
  return `${f.id}: ${f.name}. ${f.requirements.join(', ')}. Rules from ${f.source} (checked ${f.checked}); page ${f.page}`
}

const expandHome = (p: string) => (p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p)

export function createServer(opts: ServerOptions = {}): McpServer {
  const api = opts.api ?? process.env.FITFILESIZE_API ?? DEFAULT_API
  const forms = opts.loadFormsImpl ?? (() => loadForms(opts.fetchImpl))
  const server = new McpServer({ name: 'fitfilesize', version: VERSION })

  server.registerTool(
    'fit_file',
    {
      title: 'Fit a file under an upload limit',
      description:
        'Compress a PDF or image (JPEG, PNG, WebP, TIFF, BMP) on this computer so it fits an upload ' +
        'limit, keeping as much quality as the limit allows, and save the result next to the original ' +
        'as "<name>.fit.<ext>". Give either `limit` (like "200KB" or "1.5MB"; KB and MB are 1000-based, ' +
        'so the file passes a check done either way) or `form` (a form preset from list_forms, like ' +
        '"ibps-signature" or "us-visa-photo-ds160", which sets the limit, minimum size and exact pixels ' +
        'that form requires). The file is uploaded to fitfilesize.com over HTTPS, compressed there, and ' +
        'deleted from the server as soon as the result is saved. Free, no account.',
      inputSchema: {
        path: z.string().describe('Full path to the file on this computer ("~/" is allowed).'),
        limit: z.string().optional().describe('Upload limit, like "200KB", "50 KB" or "1.5MB". Use this or `form`.'),
        form: z
          .string()
          .optional()
          .describe('A form preset id or name from list_forms, like "ibps-photo". Use this or `limit`.'),
        width: z.number().int().positive().max(4000).optional().describe('Exact width in pixels (images only).'),
        height: z.number().int().positive().max(4000).optional().describe('Exact height in pixels (images only).'),
        fit: z
          .enum(['crop', 'pad'])
          .optional()
          .describe('When width and height change the shape: "crop" to fill (default) or "pad" with white.'),
        minimum: z
          .string()
          .optional()
          .describe('Smallest allowed size, like "10KB", for forms that set one. A small JPEG is padded up to it.'),
        output: z.string().optional().describe('Where to save the result. Defaults to "<name>.fit.<ext>" beside the original.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        if (Boolean(args.limit) === Boolean(args.form)) {
          throw new FitError('Give either `limit` (like "200KB") or `form` (see list_forms), not both or neither.')
        }
        let limit = args.limit as string
        let minimum = args.minimum
        let width = args.width
        let height = args.height
        let formNote = ''
        if (args.form) {
          const all = await forms()
          const found = findForm(all, args.form)
          if (!found) {
            throw new FitError(`No form called "${args.form}". Known forms: ${all.map((f) => f.id).join(', ')}.`)
          }
          // Exact bytes, so the API applies the form's rules as the website does.
          limit = String(found.limit_bytes)
          minimum = found.min_bytes ? String(found.min_bytes) : minimum
          width ??= found.width
          height ??= found.height
          formNote = ` for ${found.name} (${found.requirements.join(', ')})`
        }
        if ((width === undefined) !== (height === undefined)) {
          throw new FitError('Give both `width` and `height`, or neither.')
        }
        const path = resolve(expandHome(args.path))
        if (!isAbsolute(expandHome(args.path)) && !args.path.startsWith('~')) {
          // A relative path resolves against wherever this server was started,
          // which is rarely what the user means.
          throw new FitError(`Give the full path to the file, not "${args.path}".`)
        }
        const r = await fitFile(
          {
            path,
            limit,
            minimum,
            width,
            height,
            fit: args.fit,
            output: args.output ? resolve(expandHome(args.output)) : undefined,
          },
          { api, fetchImpl: opts.fetchImpl, pollMs: opts.pollMs },
        )
        const lines = [
          r.fits
            ? `Saved ${r.output}${formNote}: ${size(r.finalBytes)}, under the ${size(r.targetBytes)} limit (was ${size(r.originalBytes)}).`
            : `Saved ${r.output}${formNote}: ${size(r.finalBytes)}. This is as small as the file goes without ruining it, still over the ${size(r.targetBytes)} limit.`,
          ...(width && height ? [`Pixels: ${width} x ${height}.`] : []),
          ...r.warnings.map((w) => `Note: ${w}`),
          'Compressed by FitFileSize (https://fitfilesize.com); the server copy is deleted.',
        ]
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
      } catch (err) {
        const message = err instanceof FitError ? err.message : `Something went wrong: ${String(err)}`
        return { content: [{ type: 'text' as const, text: message }], isError: true }
      }
    },
  )

  server.registerTool(
    'list_forms',
    {
      title: 'List form presets',
      description:
        'The upload forms FitFileSize has presets for (visa photos, Indian exam and bank applications, ' +
        'and more), each with its size limit, minimum and pixel size, and the official source of those ' +
        'rules. Pass an id to fit_file as `form`.',
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const all = await forms()
      return { content: [{ type: 'text' as const, text: all.map(describeForm).join('\n') }] }
    },
  )

  return server
}
