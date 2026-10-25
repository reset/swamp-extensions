# @reset/buildq

A Swamp behavior for buildq, a self-hosted continuous-integration coordinator
whose HTTP API has Buildkite's shape. It lists and reads a repository's builds,
reads a job's log tail, artifacts and annotations, reads the queue and the
agents, lists an organization's builds, and rebuilds, cancels and unblocks
builds. Every method writes what it read as a versioned resource, so a workflow
can assert on a build with CEL and a report can read it later.

It needs nothing beyond Swamp, the coordinator's address and a buildq API
token. It talks to the documented HTTP API only: JSON in snake_case under
`/api/`, `Authorization: Bearer <API token>` on every read, `Authorization:
token <forge token>` on rebuild, cancel and unblock, and the Cloudflare Access
service-token headers when Access still stands in front of the coordinator.

## Install

```sh
swamp extension pull @reset/buildq
```

## Set up a behavior instance

buildq answers no read without a credential: `/api/v2/`, `/api/queue` and
`/api/agents` are 401 to an anonymous caller. A service reads with an API
token, sent as `Authorization: Bearer`: a management token an administrator
of the organization makes (`POST /api/v2/organizations/<org>/tokens`), or a
personal token (`pt_...`) a person holds. A read-scoped management token
(`{"name": "...", "scope": "read"}`) reads only `builds`, `build` and the
pipeline lookup; `log`, `artifacts`, `annotations`, `queue` and `agents` need a
full-scope one or a personal token. Put it in a vault, never in a YAML file.
`swamp vault put` reads the value from stdin or a hidden prompt, so it never
reaches your shell history:

```sh
pbpaste | swamp vault put default buildq-api-token
swamp behavior create @reset/buildq my-game-ci \
  --global-arg host=https://buildq.example.net \
  --global-arg organization=acme --global-arg pipeline=game \
  --global-arg 'apiToken=${{ vault.get(default, buildq-api-token) }}'
```

A repository's builds live under its pipeline,
`/api/v2/organizations/<org>/pipelines/<pipeline>/builds`; buildq no longer
serves `/api/repos/`. An instance may name the repository as the forge does
instead, with `owner` and `repo`, and each method then asks buildq which
pipeline builds it (`GET /api/v2/pipelines?repository=<owner>/<repo>`, one
more request) before it reads:

```sh
swamp behavior create @reset/buildq my-game-ci \
  --global-arg host=https://buildq.example.net \
  --global-arg owner=example --global-arg repo=game \
  --global-arg 'apiToken=${{ vault.get(default, buildq-api-token) }}'
```

Writes (`rebuild`, `cancel`, `unblock`) send a forge token instead, the only
credential buildq takes on them for a person: it needs `read:user`, and its
owner must be a buildq user (their forge login on the settings page) who can
push to the repository. One request carries one `Authorization` header, so a
write sends only the forge token, and `unblock`'s read of the build afterwards
sends the API token:

```sh
pbpaste | swamp vault put default buildq-forge-token
swamp behavior create @reset/buildq my-game-ci \
  --global-arg host=https://buildq.example.net \
  --global-arg organization=acme --global-arg pipeline=game \
  --global-arg 'apiToken=${{ vault.get(default, buildq-api-token) }}' \
  --global-arg 'token=${{ vault.get(default, buildq-forge-token) }}'
```

A coordinator Cloudflare Access still stands in front of answers a request
without a service token with a redirect to the login page. Make a service token
in the Access dashboard, vault both halves, and add
`accessClientId=${{ vault.get(default, buildq-access-client-id) }}` and
`accessClientSecret=${{ vault.get(default, buildq-access-client-secret) }}`.
They get a request past Access only; buildq still needs the API token.

Global arguments:

| Argument             | Default  | Meaning                                                                                                                                         |
| -------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`               | required | Base URL of the coordinator.                                                                                                                    |
| `organization`       | none     | Organization slug. With `pipeline`, the repository's builds are read under the pipeline. Alone, the default of `org-builds`.                     |
| `pipeline`           | none     | Pipeline slug, with `organization`.                                                                                                             |
| `owner`, `repo`      | none     | The repository, as the forge names it. Give both. Without `organization` and `pipeline`, its pipeline is looked up before each method.           |
| `apiToken`           | none     | buildq API token, sensitive, sent as `Authorization: Bearer` on every request but `rebuild`, `cancel` and `unblock`. Every method needs it.      |
| `token`              | none     | Forge token, sensitive, sent as `Authorization: token` on `rebuild`, `cancel` and `unblock` only. It needs `read:user`, and its owner must be a buildq user who can push to the repository. |
| `accessClientId`     | none     | Cloudflare Access service token id, sent as `CF-Access-Client-Id` on every request. Give it with `accessClientSecret`. Not a buildq credential.  |
| `accessClientSecret` | none     | Cloudflare Access service token secret, sensitive, sent as `CF-Access-Client-Secret`.                                                            |

An instance is one repository's: resource names carry the build number, not the
repository, and each resource records the host and repository it was read from.
`queue`, `agents` and `org-builds` read across repositories and need no `owner`
and `repo`.

## Methods

```sh
swamp behavior run my-game-ci builds --arg branch=main --arg limit=5
swamp behavior run my-game-ci build --arg number=13
swamp behavior run my-game-ci log --arg number=13 --arg job=13.1 --arg tailKiB=256
swamp behavior run my-game-ci annotations --arg number=12
swamp behavior run my-game-ci rebuild --arg number=12
swamp behavior run my-game-ci unblock --arg number=15 --arg job=15.2 --arg fields='{"branch": "beta"}'
```

| Method        | Arguments                                    | Calls                                                      | Writes                               |
| ------------- | -------------------------------------------- | ---------------------------------------------------------- | ------------------------------------ |
| `builds`      | `limit` (50, at most 500), `branch`, `commit` | `GET .../builds?limit&branch&commit`                      | `builds`, and `newest` for the first |
| `build`       | `number`                                     | `GET .../builds/{number}`                                  | `build-<number>`, `summary-<number>` |
| `log`         | `number`, `job` (`<number>.1`), `tailKiB` (64) | `GET .../builds/{number}/jobs/{job}/log`                 | the file `log-<job>`, `logtail-<job>` |
| `artifacts`   | `number`                                     | `GET .../builds/{number}/artifacts`                        | `artifacts-<number>`                 |
| `annotations` | `number`                                     | `GET .../builds/{number}/annotations`                      | `annotations-<number>`               |
| `queue`       | none                                         | `GET /api/queue`                                           | `queue`                              |
| `agents`      | none                                         | `GET /api/agents`                                          | `agents`                             |
| `org-builds`  | `organization`, `limit` (50, at most 500)    | `GET /api/v2/organizations/{org}/builds?limit`             | `orgbuilds-<organization>`           |
| `rebuild`     | `number`                                     | `POST .../builds/{number}/rebuild`                         | `build-<new>`, `summary-<new>`, from the answer |
| `cancel`      | `number`                                     | `POST .../builds/{number}/cancel`                          | `build-<number>`, `summary-<number>`, from the answer |
| `unblock`     | `number`, `job`, `fields`                    | `PUT .../builds/{number}/jobs/{job}/unblock`, then a read of the build | `build-<number>`, `summary-<number>` |

`...` is `/api/v2/organizations/<org>/pipelines/<pipeline>`, the instance's
pipeline or the one buildq names for its `owner` and `repo`.
`commit` is a prefix. `builds` carries `truncated: true` when it holds as many
builds as `limit`, so more may exist; so does `orgbuilds`.

The `summary` resource is what a workflow asserts on. It carries the build's
`number`, `branch`, `commit`, `state`, `blocked`, `passed` (the state is
`passed`), `finished` (the state is passed, failed, canceled or skipped),
`durationSeconds`, `jobStates` (a count per state: scheduled, assigned, running,
canceling, passed, failed, canceled, skipped, blocked, unblocked, broken; a
block is blocked until answered, then unblocked), `failedJobs` (required jobs
that failed), `reason` (the first required job that is neither passed nor an
answered block, with its one-line summary) and `jobs`, each with its `state`, `exitStatus`,
`signalReason`, `summary`, `waitSeconds`, `durationSeconds` and `phaseSeconds`
by phase name (fetch, lfs, checkout, command, artifacts, cleanup, upload).
`builds` writes it as `newest` for the first build it lists; `build`, `rebuild`,
`cancel` and `unblock` write it as `summary-<number>`.

`build` keeps the same build in full: each job's timestamps, agent, platform,
phases with their start and end, a block's key, prompt and field keys, and the
`lease`, `lastSeen` and `lastOutput` the API reports while an agent holds the
job (a job whose `lastSeen` moves while `lastOutput` does not is alive and
silent).

`log` keeps the last `tailKiB` KiB of the job's log, cut to whole lines, as a
text file (`data.latest("my-game-ci", "log-13.1").path`), never the whole log,
and `logtail-<job>` says the log's size in bytes, how much was kept and whether
it was cut. A job's id is `<build>.<n>`; `job` defaults to the build's first.

`rebuild` and `cancel` write the build buildq answers with, so nothing is read
after the change is made. `cancel` can be repeated: a build that has already
ended answers 409 with the build as it ended, which the method takes as done and
logs. `rebuild` cannot: each call makes one more build, so a workflow that may
retry the step should guard it on the `build-<new>` resource it wrote. `unblock`
answers a block once; a second answer is refused with 409 and the method
throws. buildq answers an unblock with the job alone, so the method reads the
build back; when that read fails, the block stays answered, and the method
logs a warning saying so, writes nothing and succeeds, rather than failing a
step whose change was made.

## Assert on the newest build from a workflow

```yaml
jobs:
  - name: check
    steps:
      - name: newest
        task:
          type: behavior
          behavior: my-game-ci
          methodName: builds
          inputs:
            branch: main
            limit: 1
      - name: passed
        dependsOn:
          - step: newest
            condition:
              type: succeeded
        task:
          type: assert
          expr: >-
            data.latest("my-game-ci", "newest").attributes.passed == true
          message: >-
            build #${{ data.latest("my-game-ci", "newest").attributes.number }}
            of main is ${{ data.latest("my-game-ci", "newest").attributes.state }}:
            ${{ data.latest("my-game-ci", "newest").attributes.reason }}
          severity: high
```

A branch with no build writes `builds` with `count: 0` and no `newest`, so
assert on `count` first when the branch may be new.

## Errors

A refused answer throws a `BuildqError` with the HTTP status and the API's
message: 401 when buildq did not take the API token or the forge token, 403
when a read-scoped API token asks for more than builds, an API token answers a
block, the forge token lacks `read:user` or its owner is no buildq user or
cannot push to the repository, or Access refused the request, 404 for a build,
job, pipeline or organization the coordinator does not have or the API token
may not see, 409 for a block that is not waiting, 422 for an answer that does
not fit the block's fields. A redirect is never followed: a 308 to another
host, which is how buildq answers on a hostname it moved from, throws naming the
host to set, and a 302 to a login page throws naming where it went and the
Access arguments to set. A method refuses to run before any request is made
when it has no API token, or, for a write, no forge token; `unblock` needs both.
Nothing is written before a method fails, so a failed step leaves no misleading
data behind.

## What the resources keep

Builds are about code, but buildq records who pushed, asked for or answered
them: `creator`, `requested_by` and a block's `unblocked_by`. None of those is
kept. A block keeps `unblocked: true` and `unblockedAt` instead. A build's `env`
(what a create call gave it) and `meta_data` (what its jobs set) are dropped
too. Agent names, hosts, the OS user an agent runs as and its unit are kept: a
workflow reads the agent's journal with them. The queue and agents resources
expire after 7 days and the log tail after 30; builds and summaries are kept.

## Left out of this version

The management API (`/api/v2/organizations` and `/api/v2/pipelines`, written
with `Authorization: Bearer <BUILDQ_API_TOKEN>`) is not driven: organizations
and pipelines are declared by a Terraform provider, and reading them here would
only duplicate what it holds. The create-build call (`POST .../builds`, for a
preflight of a branch under `buildq/preflight/`) is not driven either, since a
preflight starts from a working tree, which `smk ci preflight` owns.

## License

MIT, see LICENSE.
