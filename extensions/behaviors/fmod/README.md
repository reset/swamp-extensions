# @reset/fmod

Drive FMOD Studio from Swamp through its command line tool, `fmodstudiocl`.
The behavior type has three methods:

| Method       | What it does                                                                                        | Runs                                  |
| ------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `build`      | Builds banks for platforms and records which bank was built for which platform                      | `fmodstudiocl -build [...] project`   |
| `inspect`    | Lists the project's platforms, banks and events and the FMOD Studio version through a bundled script | `fmodstudiocl -script inspect.js ...` |
| `diagnostic` | Runs the tool's own project validation                                                              | `fmodstudiocl -diagnostic project`    |

Every method writes a record swamp keeps with its provenance: `build`,
`project`, `banks`, `events` and `diagnostic`. A workflow reads them with
`data.latest("<instance>", "<record>")`. Nothing is written when a run fails.

## Prerequisites

- Swamp, in a repository that has run `swamp repo init`.
- FMOD Studio on the machine. The command line tool is documented in the
  FMOD Studio User Manual, Advanced Topics, "FMOD Studio Command Line Tool"
  (<https://www.fmod.com/docs/2.03/studio/advanced-topics.html>), and the
  scripting API in the Scripting chapter and its reference
  (<https://www.fmod.com/docs/2.03/studio/scripting-api-reference.html>).
  Written against FMOD Studio 2.03.
- An FMOD Studio project (`.fspro`) in the repository or on the machine. The
  project's platforms are the ones in its build preferences.

## Install and set up

```sh
swamp extension pull @reset/fmod

swamp behavior create @reset/fmod fmod-examples \
  --global-arg project=audio/Examples.fspro
```

`Examples.fspro` is the name of FMOD's own example project; use your own.
Global arguments:

| Argument         | Default        | Meaning                                                                                                              |
| ---------------- | -------------- | -------------------------------------------------------------------------------------------------------------------- |
| `project`        | required       | Path of the `.fspro` file, absolute or relative to the repository.                                                   |
| `fmodstudio`     | `fmodstudiocl` | The command line tool: its name when on PATH, a path to it, or on macOS the app bundle (see below).                   |
| `timeoutSeconds` | `1800`         | The tool is killed and the method fails when it has not exited by then. Standard input is closed, so nothing prompts. |

No credential is involved: the tool reads the project from disk.

### Where the tool is

The manual lists the tool's location per operating system: on Windows under
`C:\Program Files\FMOD SoundSystem\FMOD Studio <VERSION>`, on Linux under
`/opt/fmodstudio`, on macOS inside the app bundle at
`/Applications/FMOD Studio.app/Contents/MacOS`. Set `fmodstudio` to the full
path when it is not on PATH.

On macOS `fmodstudiocl` is a launcher script that needs a terminal: started
from a process without one, such as swamp, it fails before FMOD Studio runs,
and the behavior reports that. Point `fmodstudio` at the app bundle instead:

```sh
swamp behavior create @reset/fmod fmod-examples \
  --global-arg project=audio/Examples.fspro \
  --global-arg 'fmodstudio=/Applications/FMOD Studio.app'
```

The behavior then starts the app with `open -W`, its output sent to files it
reads afterwards, the command-line environment variable set and the working
directory passed, which is what the launcher does. Two consequences of `open`:
its exit code is its own, so the methods judge success by what FMOD Studio
printed ("Build completed successfully.", "Project validation completed
successfully.", the inspect report), and a timeout kills `open`, not the app,
so quit FMOD Studio by hand after a timed-out run.

## Build banks

```sh
# Every bank for every platform in the project's build preferences.
swamp behavior run fmod-examples build

# Named banks for named platforms, as the banks browser and the build
# preferences name them.
swamp behavior run fmod-examples build \
  --input 'banks:json=["Master","SFX"]' \
  --input 'platforms:json=["Desktop"]'
```

Arguments: `banks` and `platforms` (empty means all; a name cannot contain a
comma because the tool takes comma-separated lists), `ignoreWarnings`
(`-ignore-warnings`), `exportGuids` (`-export-guids`), `sharedAudioSourceDir`
(`-shared-audio-source-dir`) and `logDir` (`-log-dir`, where FMOD Studio
writes its own log file).

The `build` record has the banks and platforms asked for, `platformsBuilt`
(each platform the tool prepared), `bankBuilds` (each `Building "<bank>" for
<platform>` line as `{bank, platform}`), `warnings`, the exit code, timing,
the number of output lines and a bounded excerpt of the non-progress lines
plus the tail, and `stderrLines`. The method fails, writing nothing, on a
`Build Banks Error` (an unknown bank or platform), a project that did not
open, a non-zero exit code or a missing completion line. Built banks land
where the project's build preferences say, by default the `Build/<platform>`
folder beside the project; `inspect` reports that setting.

## Inspect the project

```sh
swamp behavior run fmod-examples inspect
```

Writes a temporary script, runs it with `-script`, and records three
resources from what the script printed:

- `project`: the FMOD Studio version (`studio.version`), the project path,
  `builtBanksOutputDirectory` (empty for the default) and the platforms with
  their output sub-directory and metadata-only flag, plus `platformNames`.
- `banks`: `names` and each bank's GUID, `bank:/` path, master flag and the
  names of the events assigned to it.
- `events`: `count`, `paths` and each event's GUID, `event:/` path and the
  banks it is assigned to (empty for an unassigned event). The record keeps
  at most 2000 events and says `truncated: true` when the project has more.

The script uses the documented scripting API only: `Entity.findInstances`,
`ManagedObject` properties and relationships, `Bank.getPath`, `Event.getPath`
and `studio.project.workspace`. Snapshots are not listed as events.

## Validate the project

```sh
swamp behavior run fmod-examples diagnostic
```

Runs `-diagnostic`, the tool's check "for potential corruptions and errors",
and records how many validation steps it printed, the exit code, timing and a
bounded excerpt. It fails when the completion line is missing.

## A build workflow

A workflow that checks the bank exists before building it for one platform,
then asserts the platform was built:

```yaml
jobs:
  - name: build
    steps:
      - name: inspect
        task:
          type: behavior
          behavior: fmod-examples
          methodName: inspect
      - name: bank-exists
        dependsOn:
          - step: inspect
            condition:
              type: succeeded
        task:
          type: assert
          expr: >-
            inputs.bank in
            data.latest("fmod-examples", "banks").attributes.names
          message: Bank ${{ inputs.bank }} is not in the project
      - name: build
        dependsOn:
          - step: bank-exists
            condition:
              type: succeeded
        task:
          type: behavior
          behavior: fmod-examples
          methodName: build
          inputs:
            banks:
              - ${{ inputs.bank }}
            platforms:
              - ${{ inputs.platform }}
      - name: platform-built
        dependsOn:
          - step: build
            condition:
              type: succeeded
        task:
          type: assert
          expr: >-
            inputs.platform in
            data.latest("fmod-examples", "build").attributes.platformsBuilt
          message: ${{ inputs.platform }} was not built
```

## License

MIT, see LICENSE.
