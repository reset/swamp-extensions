# @reset/patch-notes

A Swamp behavior that drafts a game's patch notes from the pull requests merged
since the last release. It reads a Forgejo or Gitea repository through its
`/api/v1` REST API, or a GitHub repository through the GitHub REST API, resolves
two refs (tags, branches or commits) to their commit dates, and gathers the pull
requests merged into the base branch after the first and up to the second. Each
pull request is classified by its labels: with the default prefix `patch:`, a
pull request labelled `patch:fix` lands under "Fix" and one labelled
`patch:new-content` under "New content". The draft is Markdown grouped by
category, and the `bbcode` method renders it, or any Markdown you hand it, as
Steam announcement BBCode.

It needs nothing beyond Swamp. A public repository needs no token; a private one
needs a read-only token. It talks to documented endpoints only:

| Step                     | GitHub                                         | Forgejo, Gitea                                 |
| ------------------------ | ---------------------------------------------- | ---------------------------------------------- |
| Ref to commit and date   | `GET /repos/{owner}/{repo}/commits/{ref}`      | `GET /repos/{owner}/{repo}/commits?sha={ref}`  |
| Commits between the refs | `GET /repos/{owner}/{repo}/compare/{a}...{b}`  | `GET /repos/{owner}/{repo}/compare/{a}...{b}`  |
| Closed pull requests     | `GET /repos/{owner}/{repo}/pulls?state=closed` | `GET /repos/{owner}/{repo}/pulls?state=closed` |

A pull request belongs to the range when its merge commit is one of the commits
between the two refs, so a tag on a merge commit puts that pull request in the
release the tag closes and not in the next one. Only a forge that reports no
merge commit for a pull request falls back to its merge time.

## The name

`@reset/patch-notes` was briefly a different extension: 2026.10.22.1, published
by mistake from another repository, announced a Steam game's new patch notes in
Discord. That announcer is retired. Announcing is now done with
`@reset/steam-news`, whose `fetch` method flags the posts its previous read did
not hold, and a Discord post. 2026.10.31.1 is the drafter again.

## Upgrading

Upgrading to 2026.10.31.1 leaves a drafter instance (2026.10.21.1) as it is: its
global arguments are kept exactly as written. An instance whose arguments were
written for the announcer cannot be migrated, since the two share no arguments.
Swamp hands an upgrade the arguments and not the version they came from, so the
upgrade judges them by name: an argument the drafter never took, or a missing
`owner` or `repo`, fails `swamp behavior validate` and any method run with an
error that names the change, rather than being dropped. Recreate such an
instance with `owner` and `repo` to draft notes, or move its announcing to
`@reset/steam-news`.

## Install

```sh
swamp extension pull @reset/patch-notes
```

## Set up a behavior instance

For a public GitHub repository, no token is needed (GitHub allows 60
unauthenticated requests an hour):

```sh
swamp behavior create @reset/patch-notes my-game-notes \
  --global-arg owner=example-studio \
  --global-arg repo=example-game
```

For Forgejo, Gitea or Codeberg, name the API root and put a read-only token in a
vault. `swamp vault put` reads the value from stdin or a hidden prompt, so it
never reaches your shell history:

```sh
pbpaste | swamp vault put default forge-read-token
swamp behavior create @reset/patch-notes my-game-notes \
  --global-arg forge=forgejo \
  --global-arg apiUrl=https://forge.example.com/api/v1 \
  --global-arg owner=example-studio \
  --global-arg repo=example-game \
  --global-arg 'token=${{ vault.get(default, forge-read-token) }}'
```

Global arguments:

| Argument      | Default                             | Meaning                                                                                 |
| ------------- | ----------------------------------- | --------------------------------------------------------------------------------------- |
| `forge`       | `github`                            | `github`, or `forgejo` for Forgejo and Gitea.                                           |
| `apiUrl`      | `https://api.github.com` for GitHub | API root. Required for Forgejo, such as `https://codeberg.org/api/v1`.                  |
| `owner`       | required                            | Repository owner, a user or an organization.                                            |
| `repo`        | required                            | Repository name.                                                                        |
| `base`        | `main`                              | Branch the pull requests were merged into.                                              |
| `token`       | none                                | Read-only token, sensitive. Sent as `Bearer` to GitHub and as `token` to Forgejo.       |
| `labelPrefix` | `patch:`                            | Label prefix that names a category. An empty prefix makes the first label the category. |
| `keepAuthors` | `false`                             | Keep each pull request's author login. Off by default, since a login is personal data.  |

## Methods

```sh
swamp behavior run my-game-notes gather --input start=v1.4.0 --input end=v1.5.0
swamp behavior run my-game-notes draft --input title="Update 1.5" --input 'exclude:json=["internal"]'
swamp behavior run my-game-notes bbcode
```

| Method   | Arguments                                                               | Writes                                    |
| -------- | ----------------------------------------------------------------------- | ----------------------------------------- |
| `gather` | `start`, `end` (the base branch), `maxPages` (10)                       | resource `gather`                         |
| `draft`  | `title` (`Patch notes`), `order` ([]), `exclude` ([]), `numbers` (true) | resource `draft`, file `notes` (Markdown) |
| `bbcode` | `markdown` (the latest draft's Markdown)                                | resource `bbcode`, file `steam`           |

`gather` keeps, for each pull request, its number, title, labels, category,
merge time, merge commit and web URL, and never its body. It reads pull requests
newest update first and stops a day before the `start` commit, since a merge is
an update. When `maxPages` runs out first, or the compare listed fewer commits
than it reported, the resource says `truncated: true`; raise `maxPages` and run
it again. The resource also carries `commits`, the commits between the refs,
`count` and `byCategory`, the count per category, for asserts.

`draft` puts the categories named in `order` first, the rest alphabetically and
`uncategorized` (no label under the prefix) last, and lists each category's pull
requests oldest merge first. Edit the file it writes before publishing; the
draft is a starting point for a person, not the notes themselves.

`bbcode` converts headings to `[h1]` to `[h3]`, bullet and numbered lists to
`[list]` and `[olist]`, bold, italic, strike and links to their tags and a rule
to `[hr]`, as Steam's announcement formatting help describes them. To render
notes you edited, pass them back with `--input markdown=@notes.md`.

## Use it in a workflow

```yaml
jobs:
  - name: notes
    steps:
      - name: gather
        task:
          type: behavior
          behavior: my-game-notes
          methodName: gather
          inputs:
            start: ${{ inputs.start }}
      - name: enough
        dependsOn:
          - step: gather
            condition:
              type: succeeded
        task:
          type: assert
          expr: |-
            !data.latest("my-game-notes", "gather").attributes.truncated &&
            int(data.latest("my-game-notes", "gather").attributes.count) > 0
          message: nothing merged since ${{ inputs.start }}
          severity: high
      - name: draft
        dependsOn:
          - step: enough
            condition:
              type: succeeded
        task:
          type: behavior
          behavior: my-game-notes
          methodName: draft
```

The repository this extension comes from runs that workflow as
`workflows/workflow-patch-notes-draft.yaml`.

## Limits

- The compare listing is complete on GitHub up to `maxPages` pages of 100
  commits; a Forgejo server lists as many commits as its configuration allows.
  When either falls short of the reported total, `truncated` is true.
- Each pull request lands in one category, the first label under the prefix.
- The behavior reads only; it never labels, edits or comments.

## Privacy

Pull request titles and author logins can name people. Logins are dropped unless
`keepAuthors` is set, and the resources keep titles and URLs only. Swamp keeps
the newest 20 versions of each resource on the machine that ran the method;
delete them with `swamp data delete` when a title should not be kept.

## License

MIT. See [LICENSE](LICENSE).
