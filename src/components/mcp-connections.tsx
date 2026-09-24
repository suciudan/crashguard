"use client";
import { useEffect, useRef, useState } from "react";
import { Copy, Plus, Trash2 } from "lucide-react";
import {
  addMcpConnection,
  getMcpConnections,
  removeMcpConnection,
} from "@/app/actions/mcp";
import type { McpToken } from "@/lib/mcp-tokens";
import { action } from "./shared";
import styles from "./mcp-connections.module.css";

const clients = ["Codex", "Claude"] as const;

export function McpConnections() {
  const [client, setClient] = useState<(typeof clients)[number]>("Codex");
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [data, setData] = useState<{
    endpoint: string;
    tokens: McpToken[];
  } | null>(null);
  const [name, setName] = useState("Codex");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let mounted = true;
    action(getMcpConnections())
      .then((result) => {
        if (mounted) setData(result);
      })
      .catch((e: Error) => {
        if (mounted) setError(e.message);
      });
    return () => {
      mounted = false;
    };
  }, []);
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice("Copied to clipboard.");
    } catch {
      setError("Could not copy. Select the text and copy it manually.");
    }
  };
  const config = data
    ? client === "Codex"
      ? `[mcp_servers.crashguard]\nurl = ${JSON.stringify(data.endpoint)}\nbearer_token_env_var = "CRASHGUARD_MCP_TOKEN"`
      : JSON.stringify(
          {
            mcpServers: {
              crashguard: {
                type: "http",
                url: data.endpoint,
                headers: { Authorization: "Bearer ${CRASHGUARD_MCP_TOKEN}" },
              },
            },
          },
          null,
          2,
        )
    : "";
  return (
    <div className={`setup-layout ${styles.workspace}`}>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <p role="status" className={styles.notice}>
        {notice}
      </p>
      {!data ? (
        <p>
          {error ? "Reload this page to try again." : "Loading connections…"}
        </p>
      ) : (
        <>
          <section
            className={`setup-main ${styles.card}`}
            aria-labelledby="new-connection"
          >
            <h2 id="new-connection">1. Create a token</h2>
            <p>
              Use a separate token for each assistant. Tokens expire after 90
              days and can be revoked at any time.
            </p>
            <form
              className={styles.form}
              onSubmit={async (event) => {
                event.preventDefault();
                setBusy(true);
                setError("");
                setNotice("");
                try {
                  const created = await action(addMcpConnection(name));
                  setToken(created.token);
                  setData(await action(getMcpConnections()));
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                Connection name
                <input
                  className="text-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={60}
                />
              </label>
              <button
                className="button primary"
                disabled={busy || !name.trim()}
              >
                <Plus size={15} />
                {busy ? "Please wait…" : "Create token"}
              </button>
            </form>
            {token && (
              <div className={styles.token}>
                <strong>Copy your token now. It is shown only once.</strong>
                <p>
                  Save it as <code>CRASHGUARD_MCP_TOKEN</code> in the
                  environment that launches your assistant.
                </p>
                <label className={styles.tokenLabel}>
                  New MCP token
                  <textarea
                    readOnly
                    aria-label="New MCP token"
                    value={token}
                    rows={2}
                    spellCheck={false}
                  />
                </label>
                <div className={styles.buttons}>
                  <button className="button" onClick={() => void copy(token)}>
                    <Copy size={14} />
                    Copy token
                  </button>
                  <button className="button" onClick={() => setToken("")}>
                    Done
                  </button>
                </div>
              </div>
            )}
          </section>
          <section
            className={`setup-main ${styles.card}`}
            aria-labelledby="connect-assistant"
          >
            <h2 id="connect-assistant">2. Connect your assistant</h2>
            <div
              className={`sdk-tabs ${styles.clientTabs}`}
              role="tablist"
              aria-label="MCP client"
            >
              {clients.map((name, index) => (
                <button
                  key={name}
                  ref={(element) => {
                    tabRefs.current[index] = element;
                  }}
                  type="button"
                  role="tab"
                  id={`mcp-tab-${name.toLowerCase()}`}
                  aria-selected={client === name}
                  aria-controls="mcp-client-panel"
                  tabIndex={client === name ? 0 : -1}
                  className={client === name ? "active" : ""}
                  onClick={() => {
                    setClient(name);
                    setNotice("");
                  }}
                  onKeyDown={(event) => {
                    const next =
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? clients.length - 1
                          : event.key === "ArrowRight"
                            ? (index + 1) % clients.length
                            : event.key === "ArrowLeft"
                              ? (index + clients.length - 1) % clients.length
                              : null;
                    if (next === null) return;
                    event.preventDefault();
                    setClient(clients[next]);
                    setNotice("");
                    tabRefs.current[next]?.focus();
                  }}
                >
                  {name}
                </button>
              ))}
            </div>
            <div
              role="tabpanel"
              id="mcp-client-panel"
              aria-labelledby={`mcp-tab-${client.toLowerCase()}`}
              tabIndex={0}
            >
              {client === "Codex" ? (
                <p>
                  In Codex Settings → MCP servers, add a Streamable HTTP server
                  named <strong>crashguard</strong> with this URL and your
                  bearer token. Or merge the following into{" "}
                  <code>~/.codex/config.toml</code>:
                </p>
              ) : (
                <p>
                  For Claude Code, merge the following into{" "}
                  <code>.mcp.json</code> in your project root. Keep any existing
                  entries under <code>mcpServers</code>.
                </p>
              )}
              <pre>
                <code>{config}</code>
              </pre>
              <button className="button" onClick={() => void copy(config)}>
                <Copy size={14} />
                Copy configuration
              </button>
              {client === "Codex" ? (
                <p>
                  Set <code>CRASHGUARD_MCP_TOKEN</code> to your token in the
                  environment that launches Codex, then restart Codex. Open{" "}
                  <code>/mcp</code> to check the connection.
                </p>
              ) : (
                <p>
                  Set <code>CRASHGUARD_MCP_TOKEN</code> to your token in the
                  environment that launches Claude Code, then restart it from
                  this project. Approve the project MCP server when prompted and
                  open <code>/mcp</code> to check the connection.
                </p>
              )}
            </div>
            <div className={styles.prompt}>
              Try: “Show my unresolved CrashGuard errors from the last 7 days,
              then inspect the most frequent one.”
            </div>
          </section>
          <section
            className={`setup-main ${styles.card}`}
            aria-labelledby="connections"
          >
            <h2 id="connections">Your connections</h2>
            {!data.tokens.length ? (
              <p>No connections yet. Create your first token above.</p>
            ) : (
              <ul className={styles.list}>
                {data.tokens.map((item) => {
                  const active =
                    !item.revoked_at && item.expires_at > Date.now();
                  return (
                    <li key={item.id}>
                      <div>
                        <strong>{item.name}</strong>
                        <p>
                          {item.revoked_at
                            ? "Revoked"
                            : !active
                              ? "Expired"
                              : `Expires ${new Date(item.expires_at).toLocaleDateString()}`}{" "}
                          ·{" "}
                          {item.last_used_at
                            ? `Last used ${new Date(item.last_used_at).toLocaleString()}`
                            : "Never used"}
                        </p>
                      </div>
                      {active && (
                        <button
                          className="button"
                          disabled={busy}
                          aria-label={`Revoke ${item.name}`}
                          onClick={async () => {
                            setBusy(true);
                            setError("");
                            try {
                              await action(removeMcpConnection(item.id));
                              setToken("");
                              setData(await action(getMcpConnections()));
                              setNotice(`${item.name} revoked.`);
                            } catch (e) {
                              setError((e as Error).message);
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          <Trash2 size={14} />
                          Revoke
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
