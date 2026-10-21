# @reset/socialq

A Swamp behavior that reads a socialq deployment, the self-hosted social
publishing and recording service, through its HTTP API: whether it answers and
which build it runs, who the token is, the organization's accounts, the
calendar and how far the recorder has read each account, the wrap-up report,
today's collection jobs, the job ledger and the taxonomy. Every method writes
what it read as a versioned resource, so a workflow can assert on the recorder's
coverage with CEL and a report can read it later.

It is read-only by construction, twice over. The behavior's transport sends GET
and has no way to send another method. And the machine identity it uses is a
Cloudflare Access service token, which socialq refuses every write whatever its
holder sends (socialq's README, "How a request is served" and "Smoke run"): a
service token is a publisher member of one organization, never an administrator
or an operator, and changes nothing.

It needs nothing beyond Swamp and a service token that socialq's deployment
admits. It talks to the documented HTTP API only: the two Access headers
`CF-Access-Client-Id` and `CF-Access-Client-Secret`, the JSON routes under
`/api/`, and the `{"error": ...}` body of a refusal.

## Install

```sh
swamp extension pull @reset/socialq
```

## Deployment prerequisite: a service token that socialq admits

Someone with socialq's deploy token performs this once per deployment, as
socialq's README describes under "Smoke run". The behavior cannot do it, and
needs nothing more afterwards.

1. Make a Cloudflare Access service token beside the application, admitted by
   its own non-identity policy on the host the behavior will read (socialq's
   infrastructure makes one for its smoke run; a second one for this behavior is
   the same shape).
2. Insert a `people` row whose `email` holds the token's client id, and a
   `memberships` row making it a `publisher` of the organization it may read:

   ```sh
   op run --env-file=ops/deploy.env -- npm exec -w worker -- wrangler d1 execute socialq --remote \
     --command "INSERT INTO people (id, email, name, role, active) VALUES ('swamp', '<client id>', 'Swamp reader', 'publisher', 1); INSERT INTO memberships (org_id, person_id, role) VALUES ('<org id>', 'swamp', 'publisher')"
   ```

3. Decide which host the behavior reads. On the deployment's domain the
   organization routes answer for the operator organization, so the membership
   is there; on `<slug>.` the domain, in that organization. `/api/me` on the
   domain also lists every organization the token is a publisher of.

Renewing the token is a new one in Terraform, the vault entries below replaced,
and the `people` row's email changed to the new client id.

## Set up a behavior instance

Put both halves of the token in a vault, never in a YAML file. `swamp vault put`
reads the value from stdin or a hidden prompt, so it never reaches your shell
history:

```sh
pbpaste | swamp vault put default socialq-client-id
pbpaste | swamp vault put default socialq-client-secret
```

Then create one instance per deployment or organization host:

```sh
swamp behavior create @reset/socialq social \
  --global-arg host=https://socialq.example.com \
  --global-arg 'clientId=${{ vault.get(default, socialq-client-id) }}' \
  --global-arg 'clientSecret=${{ vault.get(default, socialq-client-secret) }}'
```

Global arguments:

| Argument       | Default  | Meaning                                                                                                                     |
| -------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `host`         | required | Origin of the deployment (`https://socialq.example.com`, the console) or an organization's own host (`https://<slug>.…`). |
| `clientId`     | required | Client id of the Cloudflare Access service token, sent as `CF-Access-Client-Id`. Sensitive.                                 |
| `clientSecret` | required | Client secret of the service token, sent as `CF-Access-Client-Secret`. Sensitive.                                           |

## Methods

```sh
swamp behavior run social health
swamp behavior run social calendar --arg from=2026-10-01 --arg to=2026-10-31
swamp behavior run social report --arg from=2026-10-01 --arg to=2026-10-31
swamp behavior run social activity
swamp behavior run social taxonomy --arg archived=true
```

| Method     | Arguments                                        | Calls                                        | Writes                 |
| ---------- | ------------------------------------------------ | -------------------------------------------- | ---------------------- |
| `health`   | none                                             | `GET /api/health`, no token needed           | `health`               |
| `me`       | none                                             | `GET /api/me`                                | `me`                   |
| `accounts` | none                                             | `GET /api/accounts`                          | `accounts`             |
| `calendar` | `from`, `to` (today and the 30 days before)      | `GET /api/calendar?from&to`, at most 62 days | `calendar`, `coverage` |
| `report`   | `from`, `to` (today and the 30 days before)      | `GET /api/reports?from&to`, at most 366 days | `report`               |
| `activity` | none                                             | `GET /api/activity`                          | `activity`             |
| `jobs`     | `state` (`failed,dead,unknown`), `limit` (100)   | `GET /api/jobs?state&limit`                  | `jobs`                 |
| `taxonomy` | `archived` (false)                               | `GET /api/taxonomy[?archived=1]`             | `taxonomy`             |

A range that is not calendar days, runs backwards or is longer than the route
allows is refused before any request. Every method can be repeated without
harm: nothing it does changes the deployment.

`jobs` is for administrators on socialq, and a service token is never one, so
today it answers 403 ("administrators only") and writes nothing. It is here for
the day socialq admits a token to the ledger; until then, dead and failed
collection jobs are read from `activity`, which anyone signed in may read.

### What the coverage resource says

`coverage`, written beside `calendar`, is what a workflow asserts on. Per
account it keeps `daysWithData`, the days of the range on which a posts
collection finished; `lastCollectedAt` and `readAgeDays`, when the recorder
last finished reading the account and how many whole days ago that was, both
absent when it never has; and `backfillPending`. Over the connected accounts
only it keeps `connected`, `neverRead`, and `oldestReadAgeDays` with
`oldestReadHandle`, the account the recorder read longest ago. With no connected
account read, `oldestReadAgeDays` is 0 and `neverRead` carries the signal.

`activity` keeps `byState`, the day's collection jobs counted by `due`,
`leased`, `done`, `failed`, `unknown` and `dead`, beside `running` and
`jobCount`.

## Assert on coverage from a workflow

```yaml
jobs:
  - name: coverage
    steps:
      - name: read-calendar
        task:
          type: behavior
          behavior: social
          methodName: calendar
      - name: read-recently
        dependsOn:
          - step: read-calendar
            condition:
              type: succeeded
        task:
          type: assert
          expr: >-
            int(data.latest("social", "coverage").attributes.neverRead) == 0 &&
            int(data.latest("social", "coverage").attributes.oldestReadAgeDays) <= 2
          message: a connected account has not been read in the last two days
          severity: high
```

## Errors

A refused answer throws a `SocialqError` with the HTTP status and socialq's
message: 403 for a token that is not a publisher member of the organization
("not a member of this organization", "not a SocialQ user", "a service token is
never an administrator") or asked for an administrator's route ("administrators
only"), 404 for a hostname no organization answers on, 400 for a bad range. A
missing or wrong token never reaches socialq: Cloudflare Access answers with a
redirect to its sign-in page, which the behavior does not follow and reports as
a 302 naming the cause. A 429 answer throws with `retryAfterSeconds` from
`Retry-After`. Nothing is written before a method fails, so a failed step leaves
no misleading data behind, and the token never appears in a log line.

## What the resources keep, and whose data it is

The organization that deploys socialq is the controller of what socialq holds
(socialq's README, "Data processing"); this behavior reads a small part of it on
the organization's behalf and keeps that part as versioned records under
`.swamp/data/` on the machine that ran it. What it keeps is deliberately narrow:
ids, networks, the organization's own handles on them, counts, dates, statuses
and job states.

| Resource   | Keeps                                                                                                    | Never keeps                                                                                                    |
| ---------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `health`   | ok, app, version                                                                                         |                                                                                                                |
| `me`       | console flag, role, operator flag, organization id and slug, organizations by id, slug and role          | the person row's id, email or name, organization names and origins                                             |
| `accounts` | id, network, handle, status, created and updated dates, counts by status                                 | display name, the network's id, who connected the account                                                      |
| `calendar` | variant, post and account ids, network, handle, format, status, origin, day, file and tag counts         | the post's text, permalink, external id, tag names                                                             |
| `coverage` | account id, network, handle, status, day count, last read, age in days, backfill flag, the three counts  |                                                                                                                |
| `report`   | the report's rows (network, source, follower and metric sums) and each account's two follower readings   |                                                                                                                |
| `activity` | day, running count, counts by state, per account its jobs' id, kind, state, attempts, outcome, run facts | the error text, who asked for a job, the `mine` list                                                           |
| `jobs`     | id, kind, state, target id, operation key, attempts, dates, counts by state                              | the error text, the handle, the lease, who asked for a job                                                     |
| `taxonomy` | collection id, parent, name, archived flag; tag id, collection, kind, name, campaign days, posts, flag   | a campaign's brief, a tag's description, color or icon, who made it                                            |

Handles are the organization's own public handles on each network, which
socialq's README treats as the organization's data, not a person's. `activity`
and `jobs` expire after 30 days and keep 20 versions; the others never expire
and keep 10 or 20 versions. An erasure request against socialq does not reach
these records: whoever runs the behavior deletes them with `swamp data`.

## Which routes are documented in prose only

socialq's README documents every route this behavior calls in prose, not with
a schema, and the field names below were pinned from the Worker's route files
at the time of writing. The behavior depends on them staying as they are, and
tolerates an absent field by leaving it out of the resource.

| Route               | Documented in prose under | Field names pinned from the route file                        |
| ------------------- | ------------------------- | ------------------------------------------------------------- |
| `GET /api/health`   | Smoke run, Deploy         | `ok`, `app`, `version`                                        |
| `GET /api/me`       | Console, Organizations    | `role`, `operator`, `org`, `console`, `orgs` and their fields |
| `GET /api/accounts` | Connecting                | `accounts[]` and its fields                                   |
| `GET /api/calendar` | Calendar                  | `items[]`, `coverage[]` and their fields                      |
| `GET /api/reports`  | Console, Metrics          | `rows[]`, `accounts[]` and their fields                       |
| `GET /api/activity` | Activity                  | `day`, `accounts[]`, `running` and their fields               |
| `GET /api/jobs`     | Jobs                      | `jobs[]` and its fields; `state` and `limit` are documented   |
| `GET /api/taxonomy` | Taxonomy                  | `collections[]`, `tags[]` and their fields; `posts` is named  |

The refusal body `{"error": ...}`, the statuses, the 62 and 366 day bounds, the
`state` filter and the `archived=1` switch are all stated in the README.

## Tests

The tests run every method against an in-process fake of socialq's API on
127.0.0.1, which answers the shapes above and refuses what socialq's README says
it refuses: a token outside the organization (403), an administrator's route
(403), and any write (403, a guard the behavior never reaches). Nothing in the
tests, and nothing in the checks, calls a deployed socialq.

## License

MIT, see LICENSE.
