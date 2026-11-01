# SMK context for swamp-extensions

Facts the `smk` skills need beyond `AGENTS.md` and `README.md`. The tracker smkproj.toml declares
holds the work item SMK-247, the plan (page 3715), the field notes (3716) and feedback for the
Swamp team (3717); `smk wiki show <id>` reads a page.

## Tools-engineer

- **Swamp stays here.** This is the only repository that carries `.swamp.yaml`. Game, client and
  service repositories never do, and `swamp` is not run inside them: every swamp command sends
  telemetry to telemetry.swamp-club.com (command path, argument names such as the behavior name,
  exit code, duration, platform, the AI tool it detected). What one entry holds is on page 3716.
- **Vendor skills.** Swamp is initialized with `--tool none`. Its two skills, `swamp` and
  `swamp-getting-started`, live in `.claude/skills/` here, copied verbatim from the vendor's
  install of the swamp release `.swamp.yaml` pins, so nothing of Swamp's loads in a session
  outside this repository. Refresh them by hand from a new release; never let `swamp repo init`
  write into a user's own skills directory. smkproj.toml's `Format.Exclude` keeps the formatter
  off them. Read Swamp's public manual and these skills, not its AGPL source.
- **Interfaces.** Published extensions talk to documented interfaces only: the Rollbar-compatible
  crash API (Rollbar itself, or crashq with one host change), steamcmd, Steam's Web API, Unity
  batch mode, Godot's command line, FMOD Studio's command line, Wwise's WAAPI, itch.io's butler,
  Forgejo's and GitHub's REST APIs, and the HTTP APIs of buildq, workq and socialq for the three
  extensions named for them. Someone with Swamp and no SMK can use the rest on day one.
- **Extensions.** One per directory under `extensions/behaviors/<name>/`, self-contained:
  `manifest.yaml` with `paths.base: manifest`, source, tests, README, LICENSE. Every manifest's
  `repository` is this repository's public address. Deno formats, lints, type-checks and tests
  them from `bin/test`; biome stays off them (`Format.Exclude`).
- **Publish lifecycle**, the vendor's, in `.claude/skills/swamp/references/extension/guide.md`:
  `deno check`, registration (`swamp behavior type search`), the adversarial review, unit tests,
  `swamp extension fmt --check`, `swamp extension quality`, then `swamp extension push --dry-run`.
  The push itself is live-state (AGENTS.md "Landing").
- **Instances.** `models/` holds the behavior instances the workflows use. An instance references
  vault keys by name for a service's host as well as its credentials (`<service>-host`): a public
  domain still names the company and the private services behind it, and `bin/test` fails an
  instance that names a host by address. An instance that would name a studio's own project, app
  or service stays out; the committed ones are placeholders or public targets. `vaults/` holds
  vault declarations without secrets; `local_encryption` keeps its key under `.swamp/`, ignored.
- The forge's address (`.nix/flake.nix`'s inputs and `.claude/settings.json`'s marketplace) is the
  only internal hostname the repository carries.

## Infra-engineer

- `serve/` is the release `swamp serve` runs from on a Linux host (its own flake, nixpkgs only:
  swamp's Linux binary and the Godot 4.3 editor) and its systemd user unit
  `serve/swamp-serve.service`. It listens on loopback with token auth and reads a checkout of this
  repository at the revision installed. `docs/workloads.md` says which workflows it schedules and
  what the others need before they can run there.
- `bin/serve-deploy <host> [<revision>]` installs a revision with smk's service verb and rolls
  back unless the new serve answers its health route. It is live-state; its header says what the
  host needs first and where the credentials come from.
- Deno and swamp are pinned in `.nix/flake.nix`. swamp's version and hashes are those the vendor's
  Homebrew tap names for the release `.swamp.yaml` records, which `serve/flake.nix` runs too: move
  all three together.

## Docs

- Tracker pages: 3715 the plan, 3716 field notes (including what one telemetry entry holds), 3717
  feedback for the Swamp team. Friction met while working here goes onto page 3717, in the entry
  form that page describes.
- `docs/` holds field notes that become feed posts, kept here until they are published;
  `docs/setup-post.md` is the first draft, unsubmitted. Posting to the feed is live-state.
- `docs/workloads.md`: nothing the studio relies on runs only here. Every workflow in `workflows/`
  is a flight of a workload whose relied-on path is SMK's; the flight runs beside it and is
  measured, never substituted for it. Records worth keeping are exported to SMK's own store, so
  this repository, its schedules and Swamp's data layer can be dropped without loss.

## Privacy

Crash occurrences read from crashq or Rollbar through the `@reset/rollbar` extension are data about
players (install ids, device and OS facts, custom fields a game attached), and swamp stores what a
method writes as versioned records under `.swamp/data/`, ignored by Git but kept on the machine that
ran it. The controller for a studio's own games is the studio; for a client's game, the client.
Open gaps: a notice that this processing exists, an inventory of which fields each resource keeps
(prefer counts and ids over payloads), the record lifetime and garbage-collection counts each
resource declares, and how an erasure request reaches records stored here.
