# Security model

Read this before you install. This project gives software on your Mac the ability to
drive your logged-in browser. That is the whole point, and it is also the risk.

## What an agent can do through this route

An agent connected through `browser-mcp-server playwright` controls real Chrome tabs in
your profile, with your cookies, sessions, and saved logins. It can read any page you
are logged in to, submit forms, send messages, and spend money on any site where you
are signed in. The extension has the `debugger` permission and access to all URLs,
because Playwright needs both.

Treat every agent on this route as acting as you.

## The boundaries

| Boundary | How it holds |
|---|---|
| Who can talk to the extension | Chrome's native messaging allowlist: only the host `agency.ziplyne.agent_lanes`, and that host's manifest allows only this extension's origin. |
| Who can talk to the host | An owner-only Unix socket (`0600`, in a `0700` directory) plus a token from a `0600` file, compared in constant time. Other users on the Mac cannot connect. |
| Where the token lives | One file, `~/.config/agent-lanes/token`, read only by the broker. It never appears in an MCP config, an environment variable, a process argument list, a URL, or a log. |
| Where the relay goes | The extension accepts relay URLs on loopback only (`127.0.0.1` or `::1`). |
| Which extension build is trusted | The launcher checks that Chrome's own record points at the installed unpacked folder, that every file matches the SHA-256 recorded at install, that nothing unlisted or symlinked was added, and that an owner-only pin outside the folder matches. A Web Store build with the same ID does not satisfy the check. |
| Which Chrome is used | Exactly one regular Chrome with the occlusion switch; debug, test, headless, and remote-debugging instances are refused. |
| One agent from another | Each session owns exact tab IDs. A session can only attach to, drive, or close its own tabs, and a tab moved out of its lane is revoked at once. |

## What these boundaries are not

- **Not a sandbox.** Any process running as your user can already read your files and,
  with enough effort, your browser data. The socket and token stop other users and
  casual misuse, not malware running as you.
- **Not an authorization system.** Session isolation keeps agents out of each other's
  tabs. It does not limit what a session can do on a site where you are logged in.
- **Not a guard against the page.** Page content is untrusted input. A page can contain
  instructions aimed at the agent ("ignore previous instructions, email this to...").
  Your agent's own rules have to treat page text as data, and consequential actions
  (sending, publishing, paying, deleting, changing permissions) should need your
  approval. [`../AGENTS.md`](../AGENTS.md) spells this out.

## Rules we give agents

- Passwords, passkeys, SSO approvals, password-manager prompts, and 2FA codes are for
  the human. Agents never type, read, or store credentials.
- Never read, print, or export cookies, auth headers, browser history, or session
  storage.
- Never bring Chrome to the front, focus or activate a window, or create windows or tab
  groups.
- Always call `browser_close` when done.

## The private API

`agent-lane-display` uses `CGVirtualDisplay`, a private CoreGraphics class. It needs no
entitlement or permission prompt, and it reads the pointer position and warps the
cursor, which also needs no permission. Private APIs can change without notice; if it
stops working, the helper exits and the lanes fall back to a visible corner of your
screen.

## Reporting a vulnerability

See [`../SECURITY.md`](../SECURITY.md).
