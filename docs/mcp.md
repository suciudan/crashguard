# Connect Codex or Claude to CrashGuard

CrashGuard exposes a read-only MCP server at **`/api/mcp`** on your existing
CrashGuard host. It uses Streamable HTTP with bearer token authentication; no
separate service or port is required.

## Create a connection

1. Sign in to CrashGuard with your passkey and open **MCP**.
2. Enter a name, such as “Codex laptop”, and select **Create token**.
3. Copy the token immediately. CrashGuard stores only its SHA-256 hash and cannot
   display the token again. Tokens expire after 90 days.
4. Save it in the `CRASHGUARD_MCP_TOKEN` environment variable on the machine running
   your assistant. Restart the assistant after changing its environment.

For a terminal session, enter the token without putting it in shell history:

```bash
read -rsp 'CrashGuard MCP token: ' CRASHGUARD_MCP_TOKEN; echo
export CRASHGUARD_MCP_TOKEN
```

For PowerShell, launch Codex from the same shell after:

```powershell
$mcpCredential = Read-Host 'CrashGuard MCP token' -AsSecureString
$env:CRASHGUARD_MCP_TOKEN = [System.Net.NetworkCredential]::new('', $mcpCredential).Password
```

Use the **endpoint shown in MCP**. Local development uses
`http://localhost:5000/api/mcp`; a remote installation uses its configured HTTPS
origin. Set `AUTH_ORIGIN` / `APP_URL` correctly on the server.

## Configure Codex

Add this to `~/.codex/config.toml` (Windows: `%USERPROFILE%\.codex\config.toml`),
replacing the URL with your CrashGuard endpoint:

```toml
[mcp_servers.crashguard]
url = "http://localhost:5000/api/mcp"
bearer_token_env_var = "CRASHGUARD_MCP_TOKEN"
```

Or use the CLI:

```bash
codex mcp add crashguard --url http://localhost:5000/api/mcp --bearer-token-env-var CRASHGUARD_MCP_TOKEN
codex mcp list
```

The desktop app also supports **Settings → MCP servers → Add server → Streamable
HTTP**. Save the connection and restart it. This server uses a token created in
CrashGuard, so `codex mcp login` / OAuth authentication is not needed.

See the [official Codex MCP configuration guide](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

Try: **“Show my unresolved CrashGuard errors from the last 7 days, then inspect the
most frequent one.”**

## Configure Claude Code

Select the **Claude** tab in **MCP** for configuration using your installation's
endpoint. Merge this into `.mcp.json` in your project root, keeping any existing
servers:

```json
{
  "mcpServers": {
    "crashguard": {
      "type": "http",
      "url": "http://localhost:5000/api/mcp",
      "headers": {
        "Authorization": "Bearer ${CRASHGUARD_MCP_TOKEN}"
      }
    }
  }
}
```

Set `CRASHGUARD_MCP_TOKEN` in the environment that launches Claude Code, then
restart it from that project. Approve the project MCP server when prompted and
use `/mcp` to check its status. These instructions are for Claude Code.

See the [official Claude Code MCP guide](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json).

## Tools

| Tool            | Purpose                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `list_projects` | Accessible project IDs, names, platforms, and event counts; excludes SDK keys                                                           |
| `search_issues` | Search title, culprit, or project name; filter project, status, environment, release, and 24/168/720-hour window; sort recent/frequency |
| `get_issue`     | Issue metadata and paginated event occurrences across its full history                                                                  |
| `get_event`     | One occurrence with source-mapped stack traces, breadcrumbs, tags, and context                                                          |

Search defaults to unresolved issues received in the last 24 hours. Issue and
occurrence pages contain at most 30 results; pass `next_offset` back as `offset`.
Event lookup requires both `issue_id` and the 32-character `event_id`. Large event
payloads are bounded and include `truncated: true`; the returned dashboard URL
opens the full event.

## Access and lifecycle

- Each token follows its creator's **current** project access. Owner tokens can
  read all projects; member tokens can read only projects they belong to.
- Removing membership takes effect on the next tool call. Tokens require the
  account to retain at least one passkey.
- **MCP → Revoke** immediately disables a token, including for an
  already-connected client. Each account can have at most 20 active tokens.
- Workspace passkey recovery also revokes all MCP tokens.
- Tokens grant read access only. MCP offers no resolve, delete, or management
  tools. Public SDK keys and dashboard session cookies do not authorize MCP.
- Responses are not cached. Requests are capped at 64 KiB and 120 per minute per
  token. A rate-limited request returns `429` with `Retry-After: 60`.
- Native clients may omit `Origin`. Browser requests from other origins are
  rejected. There is no anonymous access or cross-origin CORS endpoint.

## Troubleshooting

- **401:** Check that Codex inherited the environment variable, and that the token
  has not expired or been revoked. Create a replacement in MCP.
- **403:** Check `AUTH_ORIGIN` and the client's `Origin` header.
- **405 on GET:** Expected. This stateless server uses POST and has no standalone
  notification stream. Use a Streamable HTTP MCP client.
- **Empty results:** Check project membership and the search time window, status,
  environment, and release filters.
- **Connection refused:** Start CrashGuard or use its reachable remote HTTPS URL.

Run `npm test` for protocol, authorization, isolation, pagination, and recovery
tests, including a real MCP SDK client handshake and tool calls.

For the complete browser and HTTP flow, install Playwright Chromium, run
`npm run build`, then `npm run test:mcp`. This starts a temporary local server
with a disposable database, enrolls a virtual passkey, creates and revokes a
token through the UI, and calls the server with a real MCP client. Desktop and
mobile screenshots are saved under `test-results/` without the token visible.
