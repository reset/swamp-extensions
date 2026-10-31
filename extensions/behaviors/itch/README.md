# @reset/itch

[itch.io](https://itch.io) from Swamp, in two halves. The butler half publishes
a game's builds with [butler](https://itch.io/docs/butler/), the upload tool
itch.io documents. The API half records an account's games through itch.io's
[server-side API](https://itch.io/docs/api/serverside): publish state, price,
views, downloads, purchases and earnings, and what changed since the last read.
`latest` belongs to both.

| Method        | What it does                                                                                                 | Writes                               |
| ------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| `push`        | Runs `butler push` for a directory or zip to one channel, records the build id                               | `push`, `push`                       |
| `status`      | Runs `butler status`, records each channel's latest and pending build, and can wait for processing to finish | `status`, `status`                   |
| `version`     | Records which butler this machine runs                                                                       | `version`, `version`                 |
| `games`       | Reads every game the key's owner can edit and records the changes since the last read                        | `games`, `my-games`                  |
| `credentials` | Reads the key's type and scopes, to check what it may read                                                   | `credentials`, `credentials`         |
| `latest`      | With `gameId`: reads a channel's latest user version from the public update check and whether it moved       | `channel`, `game-<gameId>-<channel>` |
| `latest`      | Without `gameId`: reads the `target` project's channel from the same check                                   | `latest`, `latest`                   |

The Writes column names the resource and the data name it is written under. A
workflow reads a record with `data.latest("<instance>", "<data name>")`.

The API half was its own extension under this name, 2026.10.22.1 and
2026.10.22.2, developed in another repository. It was folded in on October 31,
2026: 2026.10.31.1 carries every method and resource of both, and an instance
made on either keeps working (see Upgrading).

## Prerequisites

- Swamp, in a repository that has run `swamp repo init`.
- For `push`, `status` and `version`: butler on the machine,
  <https://itch.io/docs/butler/installing.html>.
- An itch.io API key, which `games` and `credentials` need and butler can use.
  Create one on itch.io's API keys page in your account settings, or run
  `butler login` once and use the key whose source is `wharf`
  (<https://itch.io/docs/butler/login.html>). `latest` needs no key.

## Install and set up

```sh
swamp extension pull @reset/itch

# The key lives in a vault; the behavior instance only references it.
# swamp vault put reads it from stdin or a hidden prompt, never your history.
pbpaste | swamp vault put default itch-api-key

swamp behavior create @reset/itch itch-game \
  --global-arg target=studio/game \
  --global-arg 'apiKey=${{ vault.get(default, itch-api-key) }}'
```

| Argument   | Default  | Meaning                                                                                      |
| ---------- | -------- | -------------------------------------------------------------------------------------------- |
| `target`   | none     | The project as butler names it, `user/game`, without a channel. `push` and `status` need it. |
| `butler`   | `butler` | Path to butler, or its command name when it is on PATH.                                      |
| `apiKey`   | none     | API key, sensitive: swamp refuses a literal. `games` and `credentials` need it.              |
| `identity` | none     | Credentials file butler reads instead of its default (butler `-i`), for a second account.    |

An instance that only records games needs only `apiKey`. Leave `apiKey` out of
an instance that only pushes, on a machine where butler is already logged in.
The key reaches butler as the `BUTLER_API_KEY` environment variable, never on
its command line, and is redacted from every record and error. `games` and
`credentials` send it only as `Authorization: Bearer <key>`, never in a URL. It
is never written to a record or logged.

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

## Read a channel's latest version

```sh
# By game id: recorded per channel, with whether it moved.
swamp behavior run itch-game latest --input gameId=123 --input channel=windows-beta

# By the instance's target.
swamp behavior run itch-game latest --input channel=windows-beta
```

Both call itch.io's documented update check, `GET /wharf/latest`, which needs no
key, so none is sent. The game id is on the game's Edit game page. With
`gameId`, the `channel` record holds the latest user version, the previous one
and `changed`, true when a new version arrived since the last read:

```json
{
  "gameId": 123,
  "channel": "windows-beta",
  "latest": "1.2.4",
  "checkedAt": "2026-10-22T12:00:00.000Z",
  "previous": { "latest": "1.2.3", "checkedAt": "2026-10-21T12:00:00.000Z" },
  "changed": true
}
```

Without `gameId`, the `latest` record holds `target`, `channel`, `fetchedAt` and
`latest`. The version is `null` in `channel`, and absent in `latest`, when the
build was pushed without `--userversion` or `--userversion-file`. itch.io
answers `invalid game` for a game whose visibility is Private.

## Record your games

```sh
swamp behavior run itch-game games
```

This reads `GET /profile/games` (scope `profile:games`). The first run records
the games with `changes: null`; each later run compares with the previous
version:

```json
{
  "fetchedAt": "2026-10-22T12:00:00.000Z",
  "games": [
    {
      "id": 3,
      "title": "X-Moon",
      "published": true,
      "publishedAt": "2013-03-03T23:02:14Z",
      "minPrice": 0,
      "viewsCount": 2700,
      "downloadsCount": 112,
      "purchasesCount": 4,
      "earnings": [{ "currency": "USD", "amount": 5547 }]
    }
  ],
  "changes": {
    "since": "2026-10-21T12:00:00.000Z",
    "added": [],
    "removed": [],
    "changed": [
      {
        "id": 3,
        "title": "X-Moon",
        "fields": [
          { "field": "viewsCount", "from": 2682, "to": 2700, "delta": 18 },
          { "field": "downloadsCount", "from": 109, "to": 112, "delta": 3 },
          { "field": "earnings.USD", "from": 5047, "to": 5547, "delta": 500 }
        ]
      }
    ]
  }
}
```

Every field is compared, and each currency's earnings. Prices and earnings are
in the currency's smallest unit, such as cents. A field the API leaves out, as
it does for an unpublished page, is recorded as `null`. Every version is one
query away:

```sh
swamp data query 'modelName == "itch-game" && name == "my-games" && version >= 0' \
  --select '{"at": attributes.fetchedAt, "changes": attributes.changes}'
```

The counts move slowly; once an hour or once a day is enough for a trend.

## Check the key

```sh
swamp behavior run itch-game credentials
```

Reads `GET /credentials/info` and records `type` (`key` or `jwt`), `scopes`
(`null` for an unscoped key from your settings) and `expiresAt` for a JWT. A
scoped key needs `profile:games` for `games`.

## Errors

A method writes nothing when it fails, and says why. butler's failures name a
missing key, a refused key, a deadline or the exit code, with a redacted excerpt
of its output. A request to itch.io is abandoned after 15 seconds; an `errors`
array in the answer is reported with the HTTP status, plus a hint for 401 (key
missing, invalid or revoked) and 403 (key lacks the scope); HTTP 429 is a rate
limit, with `Retry-After` when sent, and HTTP 500 and above a transient failure
to retry later. `games` and `latest` by game id record without a comparison, and
log a warning, when the previous version cannot be read.

## What is stored and what leaves the machine

`push` and `status` run butler, which talks to itch.io with the key. `latest`
sends the game id or project and the channel name to `api.itch.io`. `games` and
`credentials` send the key to `api.itch.io`.

Records hold ids, counts, states, version strings, channel names and butler's
log lines. A game record keeps its id, title, publish state, price and the
totals itch.io reports to the game's owner; the page address, which names the
owner's account, the cover and the owner's user object are dropped when the
answer is read, and versions recorded before 2026.10.31.1 lose those fields when
read back. No buyer or player data is requested, received or stored: the
purchase, download key and reward endpoints return buyers' email addresses and
ids, so they are not called. The key itself is never stored.

`push` keeps 50 versions; `status`, `latest` and `version` expire after 30 days;
`games` and `channel` versions after 365 days; `credentials` keeps its last 10.
`swamp behavior delete itch-game --yes` removes an instance; remove the key with
`swamp vault delete default itch-api-key` and revoke it on itch.io.

## Upgrading

2026.10.31.1 accepts the global arguments of either earlier line, so its upgrade
leaves an instance as written: a butler instance from 2026.10.21.1 (`target`,
`butler`, optional `apiKey` and `identity`) and an API instance from
2026.10.22.1 or 2026.10.22.2 (`apiKey` alone). Each gets every method; a method
that needs an argument the instance lacks fails with an error naming it.
Recorded history reads back under the same resource and data names.

## Changes

- 2026.10.31.1: one extension again. 2026.10.21.1 offered `push`, `status`,
  `latest` (by target) and `version`; 2026.10.22.1 and 2026.10.22.2, published
  from another repository, replaced them with `games`, `latest` (by game id) and
  `credentials`. This version carries all six methods and all seven resources.
  `target` and `apiKey` are both optional. A game record no longer keeps the
  page address, classification, page type or creation time. `latest` by target
  abandons a request after 15 seconds, as the API methods do. Every argument's
  description now reaches the registry.
- 2026.10.22.2: the registry shows every argument's description (API line).
- 2026.10.22.1: `games`, `latest` by game id and `credentials` (API line).
- 2026.10.21.1: `push`, `status`, `latest` by target and `version`.

## Interface notes

The command syntax, flags, channel rules and update check endpoint are
documented at <https://itch.io/docs/butler/>, and the API endpoints at
<https://itch.io/docs/api/serverside>. butler's `-j` machine-readable output and
the `status` command are listed in `butler --help` but not on the documentation
site; the parsing here was checked against butler v15.32.0. itch.io documents no
endpoint that lists a game's uploads, channels or build ids for an API key, so
the API half tracks each channel with `latest`.

## License

MIT. See `LICENSE`.
