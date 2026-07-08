# MCP profiles

Put your MCP profile files here as `<name>.json`, then start with:

```bash
barnowl start --mcp <name>
```

Profile format (standard `mcpServers` map, same as Claude Code):

```json
{
  "mcpServers": {
    "mytool": { "type": "http", "url": "http://localhost:8080/mcp" }
  }
}
```

`*.json` in this directory is **gitignored** — profiles often contain private
URLs, tokens, or machine-specific paths. See [docs/mcp.md](../../docs/mcp.md)
for the full guide (including how to migrate servers you already registered
in Claude Code).
