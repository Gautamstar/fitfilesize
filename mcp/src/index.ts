#!/usr/bin/env node
/**
 * fitfilesize-mcp: an MCP server over stdio, for Claude Desktop, Claude Code,
 * Cursor, VS Code and other MCP clients. See README.md.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.js'

await createServer().connect(new StdioServerTransport())
