# swamp-extensions

Swamp Club workspace, workflows and extension sources for SMK's game-development vertical.
AGENTS.md says how to change it; `.agents/smk-context.md` holds the per-skill facts and names the
tracker pages that hold the plan.

```sh
direnv allow            # the dev shell: smk, deno, swamp, the checks
make ci                 # smk's checks, then bin/test
swamp workflow validate host-report
```

## Layout

- `extensions/behaviors/<name>/`: one published extension per directory, self-contained
  (`manifest.yaml` with `paths.base: manifest`, source, tests, README, LICENSE). Every manifest's
  `repository` is this repository's public address, <https://github.com/reset/swamp-extensions>.
- `workflows/`: the workflows this repository runs. `models/`: behavior instances the workflows use.
- `docs/`: field notes that become feed posts, kept here until they are published, and
  `docs/workloads.md`, the studio workload each workflow is a flight of.
- `.claude/skills/swamp`, `.claude/skills/swamp-getting-started`: the vendor's skills, verbatim.
- `serve/`: the release `swamp serve` runs from on a Linux host (its own flake, nixpkgs only) and its
  user unit; `bin/serve-deploy <host>` installs a revision. `docs/workloads.md` says which workflows
  it schedules and what the others need.
- `vaults/`: vault declarations (no secrets; `local_encryption` keeps its key under `.swamp/`, ignored).
