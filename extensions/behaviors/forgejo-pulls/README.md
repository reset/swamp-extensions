# @reset/forgejo-pulls

A Swamp behavior for pull requests on a Forgejo forge; Gitea answers the same
routes. It lists and reads pull requests, reads a commit's statuses by context,
lists and posts comments, and asks the repository's merge bot to merge by
posting the marker line the bot listens for. Every method writes what it read as
a versioned resource, so a workflow can gate the ask on the statuses with CEL
and a report can read it later.

It is shaped for a bot such as automerge, which has no API of its own: it reads
a line starting with `=merge=` (merge once the required checks pass) or `=rush=`
(merge now, untested) in a pull request's body or comments, and Forgejo does the
rest. The markers are global arguments, so any forge whose bot reads marker
comments fits. It needs nothing beyond Swamp and an access token, and talks to
the documented HTTP API only: `Authorization: token`, and the pulls, commit
status and issue comment routes under `/api/v1/`.

## Install

```sh
swamp extension pull @reset/forgejo-pulls
```

## Set up a behavior instance

Put the token in a vault, never in a YAML file. `swamp vault put` reads the value
from stdin or a hidden prompt, so it never reaches your shell history:

```sh
pbpaste | swamp vault put default forge-token
```

Then create one instance per forge, with the repository the workflows act on as
the default:

```sh
swamp behavior create @reset/forgejo-pulls forge \
  --global-arg host=https://forge.example.com \
  --global-arg 'token=${{ vault.get(default, forge-token) }}' \
  --global-arg owner=studio \
  --global-arg repo=game
```

A forge behind Cloudflare Access also needs a service token, sent as
`CF-Access-Client-Id` and `CF-Access-Client-Secret` on every request. Without
them Access answers with a redirect to its login page, which the behavior reports
as such:

```sh
pbpaste | swamp vault put default forge-access-client-id
pbpaste | swamp vault put default forge-access-client-secret

swamp behavior create @reset/forgejo-pulls forge \
  --global-arg host=https://forge.example.com \
  --global-arg 'token=${{ vault.get(default, forge-token) }}' \
  --global-arg 'accessClientId=${{ vault.get(default, forge-access-client-id) }}' \
  --global-arg 'accessClientSecret=${{ vault.get(default, forge-access-client-secret) }}'
```

Global arguments:

| Argument             | Default    | Meaning                                                                                                                                   |
| -------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `host`               | required   | Base URL of the forge.                                                                                                                    |
| `token`              | required   | Access token, sensitive, sent as `Authorization: token`. `read:repository` reads; `write:issue` posts comments, `ask-merge` and `ask-rush`. |
| `owner`              | none       | Default repository owner. A method argument overrides it.                                                                                 |
| `repo`               | none       | Default repository name. A method argument overrides it.                                                                                  |
| `accessClientId`     | none       | Cloudflare Access service token id. Set with `accessClientSecret` or not at all.                                                          |
| `accessClientSecret` | none       | Cloudflare Access service token secret, sensitive.                                                                                        |
| `mergeMarker`        | `=merge=`  | The line the merge bot reads as a merge ask.                                                                                              |
| `rushMarker`         | `=rush=`   | The line the merge bot reads as an untested merge ask.                                                                                    |

## Methods

```sh
swamp behavior run forge pulls --arg state=open
swamp behavior run forge pull --arg number=42
swamp behavior run forge statuses --arg number=42 --arg 'required:json=["buildq"]'
swamp behavior run forge comments --arg number=42
swamp behavior run forge comment --arg number=42 --arg body='Rebased onto main.'
swamp behavior run forge ask-merge --arg number=42
```

Every method takes `owner` and `repo`, each falling back to the global of its
name; a method with neither fails before any request.

| Method      | Arguments                                         | Calls                                                                                  | Writes                                                          |
| ----------- | ------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `pulls`     | `state` (open), `page` (1), `pages` (1)           | `GET /repos/{owner}/{repo}/pulls`, 50 per page                                         | `pulls-<owner>-<repo>`                                          |
| `pull`      | `number`                                          | `GET /repos/{owner}/{repo}/pulls/{number}`                                             | `pull-<owner>-<repo>-<number>`                                  |
| `statuses`  | `number` or `sha`, `required` (none)              | `GET /repos/{owner}/{repo}/commits/{sha}/status`, 50 per page, after the pull by number | `statuses-<owner>-<repo>-<number or sha>`                       |
| `comments`  | `number`                                          | `GET /repos/{owner}/{repo}/issues/{number}/comments`                                   | `comments-<owner>-<repo>-<number>`                              |
| `comment`   | `number`, `body`                                  | `POST /repos/{owner}/{repo}/issues/{number}/comments`                                  | `comment-<owner>-<repo>-<id>`                                   |
| `ask-merge` | `number`                                          | the pull, then a comment of `mergeMarker`, then the pull again                         | `comment-<owner>-<repo>-<id>`, `pull-<owner>-<repo>-<number>`   |
| `ask-rush`  | `number`                                          | the pull, then a comment of `rushMarker`, then the pull again                          | `comment-<owner>-<repo>-<id>`, `pull-<owner>-<repo>-<number>`   |

Each pull request carries `number`, `title`, `state`, `draft`, `merged`,
`mergeable` (the forge's verdict, when it has one), `headRef`, `headSha`,
`baseRef`, `baseSha`, the timestamps, `comments` (a count), `htmlUrl` and `asks`:
which marker its body asks with, read the way the bot reads it. The `statuses`
resource carries the combined `state` (`none` when the commit has no status),
the latest status of each context with its `state`, `description` and
`targetUrl`, and `required`: the `contexts` asked for, `passed` (every one
reports success; true when none was asked for) and `unmet`, one line per context
that is missing or not successful, for the failure message. List resources carry
`truncated: true` when more rows may exist beyond what was fetched.

`ask-merge` and `ask-rush` read the pull request first and refuse one that is
merged or not open, so nothing is posted to a pull request the bot cannot act
on. Each call posts one more comment, which is harmless to a bot that reads the
latest ask but is still a write: a workflow that may retry the step should guard
it on the `comment` resource it wrote, or declare `writes: true` when the step
runs on a remote worker. `ask-rush` asks for an untested merge: the bot merges at
once past the required checks, and only takes the ask from a repository
administrator. Use it for a hotfix with the base already red, not as a shortcut.

## How a marker is read

A line of a body or comment asks when it starts with the marker, after any
indentation, with text after it allowed (`=rush= prod is down`). A marker
mid-sentence, in a list item, a quote, backticks or a fenced code block does not,
so a body can describe the markers without asking. When both appear, the rush
ask wins. This is what the `asks` fields report; the bot itself decides.

## Gate a merge from a workflow

```yaml
jobs:
  - name: gate
    steps:
      - name: read-statuses
        task:
          type: behavior
          behavior: forge
          methodName: statuses
          inputs:
            number: ${{ inputs.number }}
            required: ["buildq"]
      - name: required-passed
        dependsOn:
          - step: read-statuses
            condition:
              type: succeeded
        task:
          type: assert
          expr: >-
            data.latest("forge", "statuses-studio-game-" + string(inputs.number)).attributes.required.passed == true
          message: >-
            unmet: ${{ data.latest("forge", "statuses-studio-game-" + string(inputs.number)).attributes.required.unmet }}
          severity: high
      - name: approve
        dependsOn:
          - step: required-passed
            condition:
              type: succeeded
        task:
          type: manual_approval
          prompt: Ask the merge bot to merge?
          timeout: 3600
      - name: ask-merge
        dependsOn:
          - step: approve
            condition:
              type: succeeded
        task:
          type: behavior
          behavior: forge
          methodName: ask-merge
          inputs:
            number: ${{ inputs.number }}
```

## Errors and rate limits

A refused answer throws a `ForgejoError` with the HTTP status and the forge's
message: 401 for a missing or invalid token, 403 for a token without the scope or
a user who cannot act on the repository, 404 for a repository the token cannot
see. A redirect, which an access proxy in front of the forge answers when the
Access headers are missing or wrong, throws with the host it redirected to. A
429 answer throws with `retryAfterSeconds` read from `Retry-After`. Nothing is
written before a method fails, so a failed step leaves no misleading data
behind.

## What the resources keep

Pull requests and comments are written by people. The resources keep numbers,
titles, states, shas, branch names, status contexts and states, descriptions,
links, timestamps and counts. They never keep a body or a comment's text, only
which marker it asks with, and nothing about a person: no author, reviewer,
assignee or email. The text `comment` posts is sent to the forge and dropped;
only the comment's id, link and ask are kept.

## Why not an existing extension

The registry was searched for `forgejo` and `gitea` on 2026-10-21 and each
Forgejo or Gitea extension's listing read against this need: list open pull
requests; read one with its state, mergeable verdict, head sha and base; read
the head commit's statuses by context; list comments; post a comment. Five
exist; none covers the statuses, the comments or a forge behind Cloudflare
Access, and none reads the markers.

| Extension                           | Score | Pull requests                                                                                               | Lacks                                                                                               |
| ----------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `@shrug/forgejo`                    | B 80  | `list_pulls`, `get_pull`, `create_issue_comment` (confirm-gated)                                            | commit statuses, comment listing, Access headers; repository unverified, no license                 |
| `@dataverket/forgejo`               | A 93  | `pr_list`, `pr_get` (mergeable and head CI state), `pr_merge` (merges directly)                             | comment listing and posting, statuses by context, Access headers; a direct merge bypasses the bot   |
| `@thomas/forgejo`                   | A 93  | the same as `@dataverket/forgejo`, which forks it                                                           | the same                                                                                            |
| `@jamesakeech/forgejo-code`         | A 93  | none: file tree and file reading on top of `@shrug/forgejo`                                                 | everything here                                                                                     |
| `@dataverket/forgejo-github-mirror` | A 93  | none: a workflow mirroring an org to GitHub on `@dataverket/forgejo`                                        | everything here                                                                                     |

Extending `@shrug/forgejo` with the missing methods was the other option. Its
`token` and `host` cannot carry the Access headers a forge behind Cloudflare
Access needs, so its existing methods would not reach the forge either, and its
listing shows a required `metadata` global of unclear purpose. The need here is
small and specific, so a behavior of its own with the privacy rules above was
the cheaper path.

## License

MIT, see LICENSE.
