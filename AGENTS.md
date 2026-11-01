# AGENTS.md — swamp-extensions

Guidance for coding agents changing this repository. README.md says what it does; this says how to
change it.

## What this is

The one repository where SMK's stack and Swamp Club meet: a Swamp workspace (`.swamp.yaml`,
initialized `--tool none`), its workflows and behavior instances, and the extensions it publishes,
TypeScript under Deno; shell for its own scripts. Scaffolded by smk proj from smkproj.toml;
re-render with smk proj. Neither side depends on the other: no smk verb, skill or smkproj.toml
field references Swamp, and nothing published from here calls smk, reads smkproj.toml or loads the
smk plugin. It is public: no credentials, personal data, company or client name, and an instance
names a service's host by vault key (`<service>-host`), never by address.

## Check

`make ci`: smk's checks, then `bin/test` (Deno check, fmt, lint and tests over `extensions/`, the
host-naming check, `swamp behavior validate` and `swamp workflow validate` over `models/` and
`workflows/`). The dev shell pins Deno and swamp in `.nix/flake.nix`, swamp at `.swamp.yaml`'s
`swampVersion`; `bin/test` fails, naming it, when either is absent.

## Landing

Work in a tree (`trees add <name>`), commit on its `worktree/<name>` branch, open the pull request
with `smk pr create` and request its merge with `gh pr merge --auto --merge`, without asking: the
host is GitHub, main's ruleset requires the `buildq` status that `.buildq/pipeline.yml` sets by
running `make ci`, and the repository allows merge commits only. A merge deploys and publishes
nothing. Live-state changes outside a merge (`swamp extension push`, `bin/serve-deploy`, creating
or renaming a collective, posting to the feed, filing issues or pull requests with the vendor,
joining its Discord) need explicit authorization.

## Where the rest lives

- `.agents/smk-context.md`: per-skill facts (telemetry, vendor skills, extension interfaces and
  publishing, the serve host, tracker pages, privacy), read by the skill that needs them.
- `docs/workloads.md`: each workflow as a flight of a studio workload, and what runs on the host.
- README.md: the layout.
