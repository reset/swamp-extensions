# @reset/rollbar

A Swamp behavior for any Rollbar-compatible crash-reporting API: api.rollbar.com
itself, or a service that answers the same endpoints, such as crashq, with one
host change. It lists and reads items (grouped errors), their occurrences and
their history, resolves, mutes and assigns items, records and lists deploys,
reads the three reports (occurrence counts, activated counts and the top active
items) and tests a project's fingerprint rules against one occurrence. Every
method writes what it read as a versioned resource, so a workflow can assert on
the crash backlog and its trend with CEL and a report can read it later.

It needs nothing beyond Swamp and a project access token. It talks to the
documented HTTP API only: `X-Rollbar-Access-Token`, the
`{"err": 0, "result": ...}` envelope, and the item, instance, deploy, deploys
and reports routes under `/api/1/`.

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

| Argument      | Default                   | Meaning                                                                                                                                      |
| ------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`        | `https://api.rollbar.com` | Base URL of the API.                                                                                                                         |
| `token`       | required                  | Project access token, sensitive. `read` lists and reads, `write` resolves, mutes and assigns, `post_server_item` records deploys.            |
| `environment` | none                      | Default environment filter for `items`, `deploys` and the three reports, and the default target of `deploy`. A method argument overrides it. |

## Methods

```sh
swamp behavior run my-game items --arg status=active --arg level=error
swamp behavior run my-game item --arg counter=42
swamp behavior run my-game occurrences --arg counter=42 --arg limit=50
swamp behavior run my-game resolve --arg counter=42 --arg resolvedInVersion=1.4.2
swamp behavior run my-game deploy --arg environment=production --arg revision=abc123
swamp behavior run my-game top-active --arg hours=24
swamp behavior run my-game occurrence-counts --arg bucketSize=86400
swamp behavior run my-game events --arg counter=42
```

| Method              | Arguments                                                                      | Calls                                                          | Writes                        |
| ------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------- | ----------------------------- |
| `items`             | `status`, `level`, `environment`, `query`, `page` (1), `pages` (1)             | `GET /api/1/items/`, 100 per page                              | `items`, `summary`            |
| `item`              | `id` or `counter`                                                              | `GET /api/1/item/{id}` or `/api/1/item_by_counter/{n}`         | `item-<counter>`              |
| `occurrences`       | `id` or `counter`, `limit` (20), `page` (1)                                    | `GET /api/1/item/{id}/instances/`                              | `occurrences-<counter>`       |
| `resolve`           | `id` or `counter`, `resolvedInVersion`                                         | `PATCH /api/1/item/{id}` then a re-read                        | `item-<counter>`              |
| `mute`              | `id` or `counter`                                                              | `PATCH /api/1/item/{id}` then a re-read                        | `item-<counter>`              |
| `assign`            | `id` or `counter`, `assignedUserId`                                            | `PATCH /api/1/item/{id}` then a re-read                        | `item-<counter>`              |
| `deploy`            | `revision`, `environment`, `localUsername`, `comment`, `status`                | `POST /api/1/deploy/`                                          | `deploy-<id>`                 |
| `deploys`           | `environment`, `page` (1)                                                      | `GET /api/1/deploys/`, 20 per page                             | `deploys`                     |
| `occurrence-counts` | `bucketSize` (86400), `environments`, `minLevel` (error), `maxLevel`, `itemId` | `GET /api/1/reports/occurrence_counts`                         | `occurrence-counts`           |
| `activated-counts`  | `buckets` (60), `environments`                                                 | `GET /api/1/reports/activated_counts`                          | `activated-counts`            |
| `top-active`        | `hours` (24), `environments`, `byOccurrences` (false)                          | `GET /api/1/reports/top_active_items`                          | `top-active`                  |
| `events`            | `id` or `counter`                                                              | `GET /api/1/item/{id}/events`                                  | `events-<counter>`            |
| `fingerprint-test`  | `projectId`, `instance`, `rules`, `ignoreClientFingerprint`                    | `POST /api/1/project/{id}/fingerprint_rules/test`, crashq only | `fingerprint-test-<instance>` |

The `summary` resource carries `count`, `byLevel`, `byStatus` and
`activeErrors`, the number of active items at level error or critical. The
`items`, `summary`, `occurrences` and `deploys` resources carry `truncated`,
true exactly when more rows exist beyond those fetched. `items` reads it from
`total_count` when the API answers one; otherwise, when the last page read is
full, each of these methods asks for the next page once and counts its rows
without keeping them.

`environments` is a list; it falls back to the global `environment` and an empty
list means any environment.

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

## Reports

`occurrence-counts` answers 60 buckets of a minute, an hour or a day (the
default), the last one the current and partial bucket, counting occurrences at
or above `minLevel` (error by default). `activated-counts` answers 2 to 366
daily buckets of items first seen or reactivated. Both resources keep the
buckets as `{timestamp, count}` rows, oldest first, and set `total`,
`newestTimestamp` and `newestCount` flat, so an assert on today's count is one
expression:

```yaml
- name: trend
  task:
    type: behavior
    behavior: my-game
    methodName: occurrence-counts
- name: quiet-today
  dependsOn:
    - step: trend
      condition:
        type: succeeded
  task:
    type: assert
    expr: >-
      int(data.latest("my-game", "occurrence-counts").attributes.newestCount)
      < 100
    message: more than 100 error or critical occurrences today
```

`top-active` answers the ten active items with the most occurrences over the
last `hours` (24 by default), ordered by level and then occurrences unless
`byOccurrences` is set, each with its hourly `counts` and `occurrences`, the sum
over the window. The resource keeps each item's id, counter, title, level,
environment and counts, and the unique occurrence count, last occurrence time,
lifetime total and status when the API reports them.

`events` reads an item's history, oldest first: each event's type (`status`,
`level`, `assigned_user_id`, `title`, `resolved_in_version` or `comment`), the
value before and after (a comment's text is the value after), and the user or
occurrence that caused it. Values are cut to 300 characters.

`fingerprint-test` is crashq's own call and answers 404 on Rollbar. It sends one
occurrence id (`instance`) and, to try unsaved rules, `rules` and
`ignoreClientFingerprint`, and keeps what the occurrence groups by: the index of
the rule that held (absent when the default grouping did), the fingerprint, its
hash, the title, and the id and counter of the item that counts it, when one
does. The occurrence itself stays on the server. A `read` token may call it.

## Errors and rate limits

A refused answer throws a `RollbarError` with the HTTP status and the API's
message: 401 for a missing or malformed token, 403 for an unknown, disabled or
out-of-scope token, 404 for an item outside the token's project. A 429 answer
throws with `retryAfterSeconds` read from `X-Rate-Limit-Remaining-Seconds` or
`Retry-After`, and the message says how long to wait. Nothing is written before
a method fails, so a failed step leaves no misleading data behind.

## What each resource keeps, and for how long

Crash occurrences are data about the player who hit the crash, and text built
from them can name that player: an item's title is its first exception message,
which can hold a player name or a user path, and an event can carry a title
change or a comment. No resource stores an occurrence's payload: no person
block, no custom fields, no frames, no request or server data. Swamp removes an
expired version, and versions beyond the count kept, when `swamp data gc` runs.

| Resource                                | Keeps                                                                                                                                                                      | Expires after | Versions kept |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------- |
| `occurrences`                           | each occurrence's id, timestamp, environment, code version, level, and exception class and message (cut to 300 characters)                                                 | 30 days       | 5             |
| `items`, `item`                         | each item's id, counter, title, level, status, environment, occurrence counts and times, versions and assignee id; `items` also its filters, the search `query` among them | 30 days       | 5             |
| `summary`                               | counts by level and status, the active error count, and the same filters as `items`, `query` among them                                                                    | 30 days       | 5             |
| `top-active`                            | each item's id, counter, title, level, environment, hourly counts, and status and totals when the API reports them                                                         | 30 days       | 5             |
| `events`                                | each event's type, the values before and after, each cut to 300 characters (a comment's text is the value after), and the user or occurrence that caused it                | 30 days       | 5             |
| `fingerprint-test`                      | the rule index, fingerprint, hash, title, and the counting item's id and counter                                                                                           | 30 days       | 5             |
| `deploy`, `deploys`                     | deploy ids, environment, revision, status, times, and the local username and comment the deploy was recorded with                                                          | never         | 20, 10        |
| `occurrence-counts`, `activated-counts` | bucket timestamps and counts, the environments, levels and item id asked for                                                                                               | never         | 60            |

Deploys and the count reports hold no player data, so they are kept. Log lines
name counters, levels, statuses and counts, never a title, a query's text or a
fingerprint.

## What is left out, and why

Erasure (`DELETE /api/1/instances/?install_id=`, `?person_id=` or `?ip=`) is
deliberately not a method of a published behavior: an erasure request names a
person, is answered once by the controller of the data, and belongs in the
studio's own tooling with its own record, not in a step a workflow can retry or
a schedule can run. Project, token, user and notification administration are
account-level calls and stay out for the same reason.

## Rollbar and crashq

Both answer the same routes with the same envelope. crashq adds `first_version`
and `last_version` to each item, which the `items` and `item` resources keep
when present, and accepts `limit` up to 5000 on the instances route, where
Rollbar pages 20 at a time. Timestamps are Unix seconds of the server's receipt
time on both.

The three report routes, their parameters and their `[timestamp, count]` rows
are Rollbar's (its reference documents `bucket_size`, `environments`,
`min_level`, `max_level` and `item_id` on `occurrence_counts`; `buckets` and
`environments` on `activated_counts`; `hours`, `environments` and
`sort=occurrences` on `top_active_items`). Where they differ:

- `top_active_items`: Rollbar's item carries `occurrences` for the window, a
  numeric level and no status; crashq answers the item as the item calls do,
  with `total_occurrences` and `status`. The resource reads both: `occurrences`
  is the API's figure or, failing that, the sum of `counts`.
- `activated_counts`: Rollbar buckets days in the project's timezone, crashq in
  UTC. Rollbar also takes `bucket_size`, which only accepts 86400, so it is not
  sent.
- `GET /api/1/item/{id}/events` is not in Rollbar's public reference; on crashq
  it answers the item's events, comments among them.
- `POST /api/1/project/{id}/fingerprint_rules/test` is crashq only.

## License

MIT, see LICENSE.
