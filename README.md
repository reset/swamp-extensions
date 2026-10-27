# swamp-extensions

Swamp Club workspace, workflows and extension sources for SMK's game-development vertical. See
AGENTS.md for the rules this repository keeps and the wiki pages that hold the plan.

```sh
direnv allow            # the dev shell: smk, deno, swamp, the checks
make ci                 # smk's checks, then bin/test
swamp workflow validate host-report
```
