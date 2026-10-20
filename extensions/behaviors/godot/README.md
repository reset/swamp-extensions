# @reset/godot

A Swamp behavior that drives the Godot 4 editor binary headlessly over its
documented command line. It reads the engine version and the project's
settings, reimports assets, reads the export presets, exports a preset to a
file and parses GDScript files for errors. Every method writes what it did as a
versioned resource, so a workflow can assert on an import, a check or an export
with CEL and a report can read it later.

It needs nothing beyond Swamp and a Godot 4 editor build on the machine (an
export template binary cannot import or export). No credentials are involved:
the behavior runs the binary with standard input closed and a deadline, and
reads `project.godot` and `export_presets.cfg` from the project directory.

## Install

```sh
swamp extension pull @reset/godot
```

## Set up a behavior instance

One instance per project. `projectPath` is the directory holding
`project.godot`, absolute or relative to the repository; the file's own path is
accepted too. `godot` is the editor binary's command name or path.

```sh
swamp behavior create @reset/godot godot-game \
  --global-arg projectPath=game \
  --global-arg godot=/opt/godot/Godot_v4.3-stable_linux.x86_64 \
  --global-arg timeoutSeconds=1800
```

Global arguments:

| Argument         | Default  | Meaning                                                                                         |
| ---------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `projectPath`    | required | Directory holding `project.godot`, absolute or relative to the repository.                      |
| `godot`          | `godot`  | The Godot 4 editor binary: a command name on PATH or a path.                                    |
| `timeoutSeconds` | `1800`   | One invocation is killed and the method fails when it has not exited after this many seconds.   |

No secrets are needed, so nothing references a vault. If a project's export
needs signing material, Godot reads it from `.godot/export_credentials.cfg`,
which stays on the machine and out of version control.

## Methods

```sh
swamp behavior run godot-game version
swamp behavior run godot-game import
swamp behavior run godot-game presets
swamp behavior run godot-game export --input preset=Linux --input path=../build/linux/game.x86_64
swamp behavior run godot-game export --input 'preset=Windows Desktop' --input path=../build/win/game.exe --input mode=debug
swamp behavior run godot-game check --input 'scripts:json=["player.gd","res://enemies/bat.gd"]'
```

| Method    | Arguments                                     | Runs                                                          | Writes    |
| --------- | --------------------------------------------- | ------------------------------------------------------------- | --------- |
| `version` | none                                          | `godot --version`, then reads `project.godot`                 | `version` |
| `import`  | none                                          | `godot --headless --path <project> --import`                  | `import`  |
| `presets` | none                                          | reads `export_presets.cfg`, no process                        | `presets` |
| `export`  | `preset`, `path`, `mode` (`release`)          | `godot --headless --path <project> --export-release <preset> <path>` | `export`  |
| `check`   | `scripts` (list)                              | `godot --headless --path <project> --check-only -s <script>`, once per script | `check`   |

`mode` chooses the flag: `release` runs `--export-release`, `debug` runs
`--export-debug` (the debug template; Godot documents that it implies
`--import`), `pack` runs `--export-pack`, which writes a PCK or ZIP by the
path's extension and no executable. `--headless` is passed on every run except
`--version`: Godot documents it as required where no GPU is available and as
what keeps a window from opening elsewhere.

A relative export `path` is relative to the project directory, as Godot resolves
it, not to the working directory; the method resolves the same way before it
checks the produced file. A `check` script is a resource path relative to the
project (`player.gd` is `res://player.gd`) or an absolute filesystem path.

## Records

`version` carries the string `--version` printed and its parts: `major`,
`minor`, `patch` (0 when the string omits it), `status` such as `stable` or
`beta1`, `build` such as `official`, and `hash` when a commit hash follows.
`project` holds `application/config/name`, `config/version` and
`run/main_scene` from `project.godot`, plus `features`, the
`config/features` list the editor writes with the engine version and renderer
the project was last saved with (empty when absent).

`import` and `export` carry `startedAt`, `finishedAt`, `durationSeconds`,
`exitCode`, `errorCount`, `errorLines` (lines with `ERROR`, `SCRIPT ERROR` or
`Parse Error`, capped at 200), `logLines` and a bounded `logExcerpt`. `export`
adds `preset`, `platform` from the presets file, `mode`, the resolved
`outputPath`, `fileSize` and `isDirectory` (a macOS `.app` is a directory).

`presets` carries `count`, `names` and one entry per `[preset.N]` section of
`export_presets.cfg`: `name`, `platform`, `exportPath`, `runnable`,
`dedicatedServer` and `exportFilter`.

`check` carries one entry per script with its `exitCode`, `passed` and the
parse errors (`message`, and `line` when Godot's `at:` line names one), plus
`passed` and `failed` counts. A script with parse errors does not fail the
method: the record is the result, and a workflow asserts on `failed`.

## Errors

A method throws before writing anything, so a failed step leaves no misleading
record behind:

- the binary is not found: the error names `godot` and says to install the
  editor or set the path;
- `--version` prints no version string, or `project.godot` or
  `export_presets.cfg` is missing: the error names the file;
- `export` is asked for a preset the presets file does not define: the error
  lists the names it does define, before Godot runs;
- Godot reports a missing export template: the error names the platform and
  says to install the templates matching the editor version;
- a non-zero exit code, or an export that exits 0 without producing the file:
  the error quotes the log excerpt;
- the deadline passes: the process is killed and the error says so.

Godot's documentation does not state the exit codes of `--import`,
`--check-only` and the export flags, nor the wording of its error lines. The
behavior treats a non-zero exit as failure, counts error lines by their
`ERROR` prefixes, and checks the produced file itself rather than trusting the
exit code of an export.

## A build workflow

Import, parse the scripts, assert that both were clean, then export:

```yaml
jobs:
  - name: build
    steps:
      - name: import
        task:
          type: behavior
          behavior: godot-game
          methodName: import
      - name: check
        dependsOn:
          - step: import
            condition:
              type: succeeded
        task:
          type: behavior
          behavior: godot-game
          methodName: check
          inputs:
            scripts: ${{ inputs.scripts }}
      - name: clean
        dependsOn:
          - step: check
            condition:
              type: succeeded
        task:
          type: assert
          expr: >-
            int(data.latest("godot-game", "import").attributes.errorCount) == 0
            && int(data.latest("godot-game", "check").attributes.failed) == 0
          message: the import printed errors or a script failed to parse
          severity: high
      - name: export
        dependsOn:
          - step: clean
            condition:
              type: succeeded
        task:
          type: behavior
          behavior: godot-game
          methodName: export
          inputs:
            preset: ${{ inputs.preset }}
            path: ${{ inputs.path }}
```

## License

MIT, see LICENSE.
