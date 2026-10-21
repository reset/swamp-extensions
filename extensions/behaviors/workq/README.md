# @reset/workq

A Swamp behavior for workq's work-tracking API. It reads who the caller is, an
org's projects, a project's items with the API's filters, one item and its
history, creates and changes items at the revision read, comments, and reads
releases and sprints. Every method writes what it read as a versioned resource,
so a workflow can assert on a release or a sprint with CEL and a report can read
it later.

It needs nothing beyond Swamp and a Cloudflare Access service token the
deployment admits. It talks to the documented HTTP API only: JSON under
`/api/v1`, described by the deployment's `/api/v1/openapi.json`, with the token
sent as `CF-Access-Client-Id` and `CF-Access-Client-Secret`. Methods that the
API also exposes as MCP tools carry the tool's name (`list_items`,
`create_item`, `change_item`).

## Before the first run: a service caller

A machine has no sign-in. The deployment's operator must arrange, once:

1. An Access service token for this caller, on the application in front of the
   deployment, admitted by that application's policy.
2. The token's client id in the deployment's `SERVICE_CALLERS` with the caller's
   name and its grants: a project by org and slug, or an org alone. The grants
   decide what the methods below may read and write; a `writes` list on the
   entry narrows it further, and every other write is refused (403).

Until both are in place every request is refused: a 403 `not a service caller`
for an unlisted client id, a redirect to sign in for a token Access does not
admit. The behavior names each in its error. That setup is a change to the
deployment, not to this behavior, and needs its operator's authorization.

## Install

```sh
swamp extension pull @reset/workq
```

## Set up a behavior instance

Put both halves of the token in a vault, never in a YAML file. `swamp vault put`
reads the value from stdin or a hidden prompt, so it never reaches your shell
history:

```sh
pbpaste | swamp vault put default workq-access-client-id
pbpaste | swamp vault put default workq-access-client-secret
```

Then create one instance per deployment, with the org and project most methods
should default to:

```sh
swamp behavior create @reset/workq tracker \
  --global-arg host=https://workq.example.com \
  --global-arg 'clientId=${{ vault.get(default, workq-access-client-id) }}' \
  --global-arg 'clientSecret=${{ vault.get(default, workq-access-client-secret) }}' \
  --global-arg org=acme \
  --global-arg project=rog
```

Global arguments:

| Argument       | Default  | Meaning                                                                               |
| -------------- | -------- | ------------------------------------------------------------------------------------- |
| `host`         | required | Base URL of the deployment.                                                           |
| `clientId`     | required | Client id of the Access service token, sent as `CF-Access-Client-Id`. Sensitive.      |
| `clientSecret` | required | Client secret of the token, sent as `CF-Access-Client-Secret`. Sensitive.             |
| `org`          | none     | Default org slug for every method that takes one. A method argument overrides it.     |
| `project`      | none     | Default project slug for every method that takes one. A method argument overrides it. |

## Methods

```sh
swamp behavior run tracker me
swamp behavior run tracker list_items --arg release=1.8.2 --arg limit=200
swamp behavior run tracker item --arg key=ROG-12
swamp behavior run tracker create_item --arg title='Audio device lost' --arg type=Bug
swamp behavior run tracker change_item --arg key=ROG-12 --arg status=Done
swamp behavior run tracker comment --arg key=ROG-12 --arg body='Fixed in 1.8.2'
swamp behavior run tracker release --arg version=1.8.2
```

| Method        | Arguments                                                                                                                                                                                   | Calls                                                                    | Writes                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------- |
| `me`          | none                                                                                                                                                                                        | `GET /me`                                                                | `me`                                               |
| `projects`    | `org`                                                                                                                                                                                       | `GET /orgs/{org}/projects`                                               | `projects-<org>`                                   |
| `list_items`  | `org`, `project`, `view`, `status`, `group`, `type`, `assignee`, `label`, `parent`, `unranked`, `release`, `sprint`, `milestone`, `query`, `order`, `limit` (50), `offset` (0), `pages` (1) | `GET …/projects/{project}/items`, up to 200 per page                     | `items-<org>-<project>`, `summary-<org>-<project>` |
| `item`        | `org`, `key`                                                                                                                                                                                | `GET /orgs/{org}/items/{key}`                                            | `item-<key>`                                       |
| `create_item` | `org`, `project`, `title`, `body`, `type`, `status`, `priority`, `assignee`, `labels`, `dueDate`, `parent`, `sprint`, `milestone`, `externalSource`, `externalId`                           | `POST …/projects/{project}/items`                                        | `item-<key>`                                       |
| `change_item` | `org`, `key`, `revision`, `requestId`, `title`, `body`, `type`, `status`, `priority`, `assignee`, `labels`, `dueDate`, `parent`, `release`, `sprint`, `milestone`                           | `GET /orgs/{org}/items/{key}` when no revision is given, then `PATCH` it | `item-<key>`                                       |
| `comment`     | `org`, `key`, `body`, `externalSource`, `externalId`                                                                                                                                        | `POST /orgs/{org}/items/{key}/comments`                                  | `comment-<key>-<id>`                               |
| `history`     | `org`, `key`                                                                                                                                                                                | `GET /orgs/{org}/items/{key}/history`                                    | `history-<key>`                                    |
| `releases`    | `org`, `project`                                                                                                                                                                            | `GET …/projects/{project}/releases`                                      | `releases-<org>-<project>`                         |
| `release`     | `org`, `project`, `version`                                                                                                                                                                 | `GET …/projects/{project}/releases/{version}`                            | `release-<org>-<project>-<version>`                |
| `sprints`     | `org`, `project`                                                                                                                                                                            | `GET …/projects/{project}/sprints`                                       | `sprints-<org>-<project>`                          |

`list_items` sends every filter the API offers, as the API names them (`query`
is sent as `q`; `release`, `sprint` and `milestone` take `none`, and `sprint`
takes `current`). It fetches `pages` pages of `limit` from `offset` and stops at
the first short page. The `summary` resource carries `count`, `byGroup`
(backlog, unstarted, started, completed, cancelled), `byStatus`, `byPriority`,
`unfinished` (the first three groups) and `unassigned`. Each list resource
carries `truncated: true` when the last page was full, so more rows may exist
beyond what was fetched.

`change_item` names the revision it read: the one given, or the item's current
one, read first. A write the item has moved on from is refused and the method
fails with a `WorkqError` whose `code` is `revision` and whose `current` is the
item as it stands; nothing is written. A status move the project's workflow does
not allow fails with `code: transition`. Every write carries a `requestId` (the
one given, or a UUID made for the call), which the API keeps the outcome under:
a resend with the same id is answered from that receipt and done once, and the
behavior logs a warning when that happened. Pass your own `requestId` when a
workflow step may be retried, since a fresh UUID per attempt is a fresh write.

`create_item` and `comment` are repeatable only with `externalSource` and
`externalId`: the same pair again answers the record the first call made, and
the log says so. Without the pair each call creates one more.

## Assert on a release from a workflow

```yaml
jobs:
  - name: readiness
    steps:
      - name: list-shipped
        task:
          type: behavior
          behavior: tracker
          methodName: list_items
          inputs:
            release: 1.8.2
            limit: 200
      - name: all-finished
        dependsOn:
          - step: list-shipped
            condition:
              type: succeeded
        task:
          type: assert
          expr: >-
            int(data.latest("tracker", "summary").attributes.byGroup.unstarted)
            + int(data.latest("tracker", "summary").attributes.byGroup.started)
            == 0
          message: items in release 1.8.2 are still unstarted or started
          severity: high
```

## Errors

A refused answer throws a `WorkqError` with the HTTP status and the API's
message: 401 when Access admitted no one, 403 when the client id is not a listed
service caller or its grants do not cover the request, 404 for anything the
grants do not make visible (the API answers 404, never 403, for a project the
caller may not see). A redirect is a token Access did not admit, sent to sign
in, and is reported as such rather than followed. A 409 carries the API's
`details.code` (`duplicate`, `revision`, `transition`, `in-use`, `no-tracker`,
`no-default`, `overlap`, `request`) in `code`. A 429 carries `retryAfterSeconds`
from `Retry-After`. Nothing is written before a method fails, so a failed step
leaves no misleading data behind.

## What the resources keep

Items, comments and history are written by people, about people's work. Every
resource keeps keys, titles, statuses and status groups, types, priorities,
labels, dates, counts and revisions, and people only as their ids (`assigneeId`,
`createdById`, `authorId`, `actorId`). No resource keeps an item body, a comment
body (the `comment` resource keeps its length), an email address, or the names
and addresses of directory groups (`me` keeps their count). `history` keeps old
and new values for statuses, types, priorities, labels, dates, keys and numbers
and drops them for titles, bodies, assignees, links and attachments. The
`assignee` filter of `list_items` is sent to the API and left out of the
resource's `filters`.

## Not in this version

The agent protocol under `…/items/{key}/lease` (leases, fenced writes and the
git fence with `fence/record`, `fence/intend` and `fence/settle`) is not
exposed: a workflow that needs several agents on one board should wait for a
version that carries it. Pages, views, attachments, milestones, grants and the
service-administrator routes are not exposed either.

## License

MIT, see LICENSE.
