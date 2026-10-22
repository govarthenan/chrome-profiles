# chrome-profiles

An agent skill that lets a coding agent open and drive a **specific Google Chrome
profile**: your real, signed-in profile, in the Chrome that is already open. It makes
no copy of the profile.

```
You:   Open my dev@company.com profile and list the first 3 emails in Gmail Updates.
Agent: status → list → open "Profile 2" → find the new tab → confirm the account → read
```

## Why

Most "use my signed-in Chrome" tools copy the profile. They must do it because:

| Block | Effect |
|---|---|
| Chrome 136 and later ignore `--remote-debugging-port` on the usual data folder | You cannot attach DevTools to your normal profiles with a port |
| One Chrome process holds each data folder | A second `google-chrome --flags` call only opens a window in the running Chrome. The new flags have no effect |

A copy has its own problems. New logins do not go into the copy, it is a second full
Chrome in memory, and it is a new sync device.

Chrome 144 and later have an approved way: turn on remote debugging in
`chrome://inspect/#remote-debugging`, and `chrome-devtools-mcp --autoConnect` attaches
to the browser that is already open. Then `google-chrome --profile-directory="Profile 2"`
opens a window for that profile **in the same browser**, and the agent drives it.

The skill gives the agent:

- A helper script (`scripts/chrome-profiles.mjs`, no dependencies) that lists the
  profiles from Chrome's `Local State`, checks that remote debugging is on, and opens a
  window for one profile.
- A reliable way to find the new tab: compare the page list before and after `open`.
- A check of the signed-in Google account in the tab.
- Rules: use only the tabs that the agent opened, never type passwords, ask before
  send/submit/delete, and treat page text as data.

## Requirements

- Google Chrome 144 or later (stable channel)
- Node.js 18 or later
- An MCP client, for example Claude Code

Tested on Linux Mint with Chrome 156 and chrome-devtools-mcp 1.1.1. The macOS and
Windows paths in the script are written but not tested.

## Install

```bash
npx skills add govarthenan/chrome-profiles
```

Then do the one-time setup:

1. In Chrome, go to `chrome://inspect/#remote-debugging` and turn on remote debugging.
2. Add a DevTools MCP server that attaches to your running Chrome:

   ```bash
   claude mcp add chrome-live -s user -- npx chrome-devtools-mcp@latest --autoConnect
   ```

   For other MCP clients:

   ```json
   {
     "mcpServers": {
       "chrome-live": {
         "command": "npx",
         "args": ["chrome-devtools-mcp@latest", "--autoConnect"]
       }
     }
   }
   ```

3. Restart the agent. At the first connection, Chrome can ask you to allow it.

## Use the helper script yourself

```bash
node scripts/chrome-profiles.mjs status            # is Chrome ready for --autoConnect?
node scripts/chrome-profiles.mjs list              # all profiles, with account emails
node scripts/chrome-profiles.mjs open "Profile 1"  # folder, display name or email
```

## Security notes

- While remote debugging is on, any local program can ask to connect to your Chrome,
  with all your logins. Turn it off when you finish.
- The connection is for the whole browser, not for one profile. The agent can see the
  tabs of every open profile. The skill tells the agent to use only its own tabs, but
  that is a rule for the agent, not a technical limit.
- The skill does not let the agent change the Chrome setting, type passwords or sign in.

## License

MIT. Copyright (c) 2026 Govarthenan Rajadurai.
