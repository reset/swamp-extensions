# @reset/rollbar

A Swamp behavior for any Rollbar-compatible crash-reporting API: api.rollbar.com
itself, or a service that answers the same endpoints, such as crashq, with one
host change. It lists and reads items (grouped errors) and their occurrences,
resolves, mutes and assigns items, and records and lists deploys. Every method
writes what it read as a versioned resource, so a workflow can assert on the
crash backlog with CEL and a report can read it later.

It needs nothing beyond Swamp and a project access token. It talks to the
documented HTTP API only: `X-Rollbar-Access-Token`, the
`{"err": 0, "result":
...}` envelope, and the item, instance, deploy and deploys
routes under `/api/1/`.

## Install

```sh
swamp extension pull @reset/rollbar
```

## Set up a behavior instance

Put the token in a vault, never in a YAML file. `swamp vault put` reads the
value from stdin or a hidden prompt, so it never reaches your shell history:

```sh
pbpaste | swamp vault put default rollbar-read-token
```

Then create one instance per project. For Rollbar itself the host can be left
out, since it defaults to `https://api.rollbar.com`:

```sh
swamp behavior create @reset/rollbar my-game \
  --global-arg 'token=${{ vault.get(default, rollbar-read-token) }}' \
  --global-arg environment=production
```

For crashq, or any other compatible service, add the host:

```sh
swamp behavior create @reset/rollbar my-game \
  --global-arg host=https://crash.example.com \
  --global-arg 'token=${{ vault.get(default, rollbar-read-token) }}'
```

Global arguments:

| Argument      | Default                   | Meaning                                                                                                                           |
| ------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `host`        | `https://api.rollbar.com` | Base URL of the API.                                                                                                              |
| `token`       | required                  | Project access token, sensitive. `read` lists and reads, `write` resolves, mutes and assigns, `post_server_item` records deploys. |
| `environment` | none                      | Default environment filter for `items` and `deploys`, and the default target of `deploy`. A method argument overrides it.         |

## Methods

```sh
swamp behavior run my-game items --arg status=active --arg level=error
swamp behavior run my-game item --arg counter=42
swamp behavior run my-game occurrences --arg counter=42 --arg limit=50
swamp behavior run my-game resolve --arg counter=42 --arg resolvedInVersion=1.4.2
swamp behavior run my-game deploy --arg environment=production --arg revision=abc123
```

| Method        | Arguments                                                          | Calls                                                  | Writes                  |
| ------------- | ------------------------------------------------------------------ | ------------------------------------------------------ | ----------------------- |
| `items`       | `status`, `level`, `environment`, `query`, `page` (1), `pages` (1) | `GET /api/1/items/`, 100 per page                      | `items`, `summary`      |
| `item`        | `id` or `counter`                                                  | `GET /api/1/item/{id}` or `/api/1/item_by_counter/{n}` | `item-<counter>`        |
| `occurrences` | `id` or `counter`, `limit` (20), `page` (1)                        | `GET /api/1/item/{id}/instances/`                      | `occurrences-<counter>` |
| `resolve`     | `id` or `counter`, `resolvedInVersion`                             | `PATCH /api/1/item/{id}` then a re-read                | `item-<counter>`        |
| `mute`        | `id` or `counter`                                                  | `PATCH /api/1/item/{id}` then a re-read                | `item-<counter>`        |
| `assign`      | `id` or `counter`, `assignedUserId`                                | `PATCH /api/1/item/{id}` then a re-read                | `item-<counter>`        |
| `deploy`      | `revision`, `environment`, `localUsername`, `comment`, `status`    | `POST /api/1/deploy/`                                  | `deploy-<id>`           |
| `deploys`     | `environment`, `page` (1)                                          | `GET /api/1/deploys/`, 20 per page                     | `deploys`               |

The `summary` resource carries `count`, `byLevel`, `byStatus` and
`activeErrors`, the number of active items at level error or critical. Each list
resource carries `truncated: true` when the last page was full, so more rows may
exist beyond what was fetched.

`resolve`, `mute` and `assign` can be repeated without harm. `deploy` cannot:
each call records one more deploy, so a workflow that may retry the step should
guard it on the `deploy-<id>` resource it wrote, or declare `writes: true` when
the step runs on a remote worker.

## Assert on the backlog from a workflow

```yaml
jobs:
  - name: backlog
    steps:
      - name: list-active
        task:
          type: behavior
          behavior: my-game
          methodName: items
          inputs:
            status: active
      - name: under-threshold
        dependsOn:
          - step: list-active
            condition:
              type: succeeded
        task:
          type: assert
          expr: >-
            int(data.latest("my-game", "summary").attributes.activeErrors) < 1
          message: there are active items at level error or critical
          severity: high
```

## Errors and rate limits

A refused answer throws a `RollbarError` with the HTTP status and the API's
message: 401 for a missing or malformed token, 403 for an unknown, disabled or
out-of-scope token, 404 for an item outside the token's project. A 429 answer
throws with `retryAfterSeconds` read from `X-Rate-Limit-Remaining-Seconds` or
`Retry-After`, and the message says how long to wait. Nothing is written before
a method fails, so a failed step leaves no misleading data behind.

## What the occurrence resource keeps

Crash occurrences are data about the player who hit the crash. The `occurrences`
resource keeps the occurrence id, timestamp, environment, code version, level,
and the exception class and message (cut to 300 characters). It never stores the
payload: no person block, no custom fields, no frames, no request or server
data. The resource expires after 30 days and keeps five versions. Items and
deploys hold no player data.

## Rollbar and crashq

Both answer the same routes with the same envelope. crashq adds `first_version`
and `last_version` to each item, which the `items` and `item` resources keep
when present, and accepts `limit` up to 5000 on the instances route, where
Rollbar pages 20 at a time. Timestamps are Unix seconds of the server's receipt
time on both.

## License

MIT, see LICENSE.
