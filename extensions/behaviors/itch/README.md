# @reset/itch

Publish a game's builds to [itch.io](https://itch.io) from Swamp with
[butler](https://itch.io/docs/butler/), the upload tool itch.io documents. The
behavior type has four methods:

| Method    | What it does                                                                                                 | Talks to                           |
| --------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| `push`    | Runs `butler push` for a directory or zip to one channel, records the build id                               | butler on the machine              |
| `status`  | Runs `butler status`, records each channel's latest and pending build, and can wait for processing to finish | butler on the machine              |
| `latest`  | Reads a channel's latest user version from the public update check, with no credentials                      | `https://api.itch.io/wharf/latest` |
| `version` | Records which butler this machine runs                                                                       | butler on the machine              |

Each method writes a record swamp keeps with its provenance: `push`, `status`,
`latest` and `version`. A workflow reads them with
`data.latest("<instance>", "<record>")`.

## Prerequisites

- Swamp, in a repository that has run `swamp repo init`.
- butler on the machine: <https://itch.io/docs/butler/installing.html>.
- An itch.io API key that may upload to the project. Run `butler login` once and
  copy the key from butler's credentials file, or take the key whose source is
  `wharf` from your itch.io API keys page
  (<https://itch.io/docs/butler/login.html>). The `latest` method needs no key.

## Install and set up

```sh
swamp extension pull @reset/itch

# The key lives in a vault; the behavior instance only references it.
swamp vault put default itch-api-key        # prompts, hidden input

swamp behavior create @reset/itch itch-game \
  --global-arg target=studio/game \
  --global-arg 'apiKey=${{ vault.get(default, itch-api-key) }}'
```

`target` is the project as butler names it, `user/game`, without a channel.
`butler` defaults to the command name and can be a path. Leave `apiKey` out on a
machine where butler is already logged in; set `identity` to a credentials file
to use a second account (butler `-i`). The key reaches butler as the
`BUTLER_API_KEY` environment variable, never on its command line, and is
redacted from every record and error.

## Push a build

```sh
swamp behavior run itch-game push \
  --input directory=build/windows \
  --input channel=windows-beta \
  --input userVersion=1.4.0

# See what would be uploaded, upload nothing.
swamp behavior run itch-game push \
  --input directory=build/windows --input channel=windows-beta \
  --input dryRun=true
```

The channel name decides the platform tag itch.io gives the upload (`windows`,
`linux`, `mac`, `android`, or several, as in `win-linux-mac-stable`). Other
inputs map to butler's flags one to one: `userVersionFile`, `ifChanged`,
`hidden` (new channels only; butler refuses it on an existing one),
`fixPermissions` and `ignore` (a list of glob patterns). `timeoutSeconds`
(default 3600) kills butler when it has not exited.

The `push` record holds `buildId` (0 for a dry run or a push skipped by
`ifChanged`), `dryRun`, `skipped`, `reason`, the times, the exit code and a
bounded excerpt of butler's log, warnings and errors always kept.

## Wait for processing

itch.io processes a pushed build before players can download it. `status` reads
the project's channels, or one channel, and with `waitSeconds` reads again every
`intervalSeconds` (default 15) until each channel read is ready (its head build
`completed` and nothing pending) or failed, or until the deadline:

```sh
swamp behavior run itch-game status \
  --input channel=windows-beta --input waitSeconds=1800
```

The `status` record holds `ready`, `failed`, `timedOut`, `found` (false when the
channel does not exist), `reads`, `waitedSeconds` and, per channel, the `head`
and `pending` builds with their id, state, versions and parent build. A deadline
is recorded, not thrown, so the workflow's assert says what happened.

## Workflow example

The repository this extension comes from runs `itch-push`: push, wait, then
assert the pushed build is the channel's head and it completed.

```yaml
- name: ready
  task:
    type: assert
    expr: |-
      data.latest("itch-game", "status").attributes.ready &&
      data.latest("itch-game", "status").attributes.channels[0].head.id
      == data.latest("itch-game", "push").attributes.buildId
    message: the channel is not ready with the pushed build
    severity: high
```

## Read the latest version

```sh
swamp behavior run itch-game latest --input channel=windows-beta
```

This calls itch.io's documented update check endpoint and records `latest`, the
user version of the channel's newest build (absent when the build was pushed
without one). A private game answers `invalid game` and the method fails with
that reason.

## What leaves the machine

`push` and `status` run butler, which talks to itch.io with the key. `latest`
sends the project and channel name to `api.itch.io`. Records hold build ids,
states, version strings, channel names and log lines, no player data.

## Interface notes

The command syntax, flags, channel rules and update check endpoint are
documented at <https://itch.io/docs/butler/>. butler's `-j` machine-readable
output and the `status` command are listed in `butler --help` but not on the
documentation site; the parsing here was checked against butler v15.32.0.

## License

MIT. See `LICENSE`.
