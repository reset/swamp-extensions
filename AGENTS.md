# swamp-extensions

The one repository where SMK's stack and Swamp Club meet. It depends on both: smk and the dev shell
for the repository's own checks, swamp for the workspace, behaviors, workflows and extensions. Neither
depends on it, and that is the rule this repository exists to keep: no smk verb, skill or smkproj.toml
field references Swamp, and nothing published from here calls the smk binary, reads smkproj.toml or
loads the smk plugin. Work item: SMK-247. Plan: wiki page 3715. Field notes: 3716. Feedback for the
Swamp team: 3717.

## Rules

- This is the only repository that carries `.swamp.yaml`. Game, client and service repositories never
  do, and `swamp` is not run inside them: every swamp command sends telemetry to
  telemetry.swamp-club.com (command path, argument names such as the behavior name, exit code,
  duration, platform, the AI tool it detected). What one entry holds is on wiki page 3716.
- Swamp is initialized with `--tool none`. Its two skills live in `.claude/skills/` here, copied from
  the vendor's install of swamp 20261020.024627.0, so nothing of Swamp's loads in a session outside
  this repository. Refresh them by hand from a new release; never let `swamp repo init` write into
  `~/.claude/skills`.
- Published extensions talk to documented interfaces only: the Rollbar-compatible crash API (Rollbar
  itself, or crashq with one host change), steamcmd, Steam's Web API, Unity batch mode, Wwise's WAAPI,
  itch.io's butler, Forgejo's and GitHub's REST APIs.
  Someone with Swamp and no SMK can use them on day one.
- Publishing an extension, creating or renaming a collective, posting to the feed, joining the Discord
  as reset and filing Lab issues or pull requests each need Jamie's explicit authorization. Friction
  met while working here goes onto wiki page 3717, in the entry form that page describes.
- This repository is public, with the full smk tooling and dev shell. Others read it and consume what it
  publishes; they need not be able to build it. Nothing private goes in: no credentials, no personal
  data, no company or client name (the repository speaks for a studio, not for one), instances
  reference vault keys by name for a service's host as well as its credentials (`<service>-host`,
  since a public domain still names the company and the private services behind it), and the
  forge's address in the dev shell is the only internal hostname it carries.
- The origin is <https://github.com/reset/swamp-extensions>; there is no copy on the forge. Pull requests
  open with `smk pr create` and merge with `gh pr merge --merge` once `make ci` has passed on the branch:
  neither `smk pr merge` nor automerge acts on GitHub. buildq, automerge and workq reaching a GitHub
  repository is SMK-253, with this repository as its test.
- Read Swamp's public manual and the vendor skills under `.claude/skills/`, not its AGPL source.
- Nothing the studio relies on runs only here. Every workflow in `workflows/` is a flight of a
  workload whose relied-on path is SMK's, named in `docs/workloads.md`; the flight runs beside it
  and is measured, never substituted for it. Records worth keeping are exported to SMK's own
  store, so this repository, its schedules and Swamp's data layer can be dropped without loss.

## Layout

- `extensions/behaviors/<name>/`: one published extension per directory, self-contained
  (`manifest.yaml` with `paths.base: manifest`, source, tests, README, LICENSE). Every manifest's
  `repository` is this repository's public address, <https://github.com/reset/swamp-extensions>.
- `workflows/`: the workflows this repository runs. `models/`: behavior instances the workflows use.
- `docs/`: field notes that become feed posts, kept here until they are published.
- `.claude/skills/swamp`, `.claude/skills/swamp-getting-started`: the vendor's skills, verbatim.
- `serve/`: the release `swamp serve` runs from on a Linux host (its own flake, nixpkgs only) and its user
  unit; `bin/serve-deploy <host>` installs a revision with smk's service verb. docs/workloads.md
  says which workflows it schedules and what the others need.
- `vaults/`: vault declarations (no secrets; `local_encryption` keeps its key under `.swamp/`, ignored).

## Checks

`make ci` runs smk's checks (`smk format --check`, `smk lint`, `smk typecheck`) and `bin/test`, which
type-checks and tests every extension with Deno and validates every behavior instance and workflow with
swamp. Deno and swamp are both pinned in `.nix/flake.nix`, swamp at `.swamp.yaml`'s `swampVersion`, so
the dev shell runs the same release on a Mac and on a build agent; `bin/test` fails, naming it, where
swamp is absent. buildq builds every push from GitHub with `.buildq/pipeline.yml`, and its `buildq`
status is the check main's ruleset requires.

Extension work follows the vendor's lifecycle in `.claude/skills/swamp/references/extension/guide.md`:
`deno check`, registration (`swamp behavior type search`), the adversarial review, unit tests,
`swamp extension fmt --check`, `swamp extension quality`, and `swamp extension push --dry-run`. The
push itself waits for authorization.

## Privacy

Crash occurrences read from crashq or Rollbar through the crash-reporting extension are data about
players (install ids, device and OS facts, custom fields a game attached), and swamp stores what a
method writes as versioned records under `.swamp/data/`, ignored by Git but kept on the machine that
ran it. The controller for a studio's own games is the studio; for a client's game, the client.
Open gaps for the privacy skill: a notice that this processing exists, an inventory of which fields
each resource keeps (prefer counts and ids over payloads), the record lifetime and garbage-collection
counts each resource declares, and how an erasure request reaches records stored here.
