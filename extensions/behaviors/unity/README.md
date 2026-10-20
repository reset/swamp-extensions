# @reset/unity

Drive the Unity Editor in batch mode from Swamp. The behavior type runs the
editor executable with the command-line arguments Unity's manual documents and
reads what the editor wrote: no editor bridge, no package to add to the project,
nothing listening inside the editor. It has four methods:

| Method    | What it does                                                                                             | Runs                                                     |
| --------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `version` | Reads `ProjectSettings/ProjectVersion.txt` and resolves the editor executable for that version           | nothing                                                  |
| `compile` | Opens the project and quits, reading the C# compiler errors and warnings from the editor log             | `-batchmode -nographics -quit -projectPath -logFile`     |
| `test`    | Runs the Unity Test Framework in Edit Mode or Play Mode and reads its NUnit result file                  | `-runTests -testPlatform -testResults` (and the filters) |
| `build`   | Runs a static method the project supplies, for a build target, with any further arguments passed through | `-buildTarget -executeMethod`, then the extra arguments  |

Every method writes a record swamp keeps with its provenance: `version`,
`compile`, `test` and `build`. A workflow reads them with
`data.latest("<instance>", "<record>")` and asserts on their fields.

## Prerequisites

- Swamp, in a repository that has run `swamp repo init`.
- The editor version the project names, installed with Unity Hub at its default
  location, or anywhere when the `editor` global argument says where. Unity
  Hub's defaults are `C:\Program Files\Unity\Hub\Editor` on Windows,
  `/Applications/Unity/Hub/Editor` on macOS and `~/Unity/Hub/Editor` on Linux.
- A licensed editor on that machine. The behavior does not activate licenses and
  takes no serial, user name or password: activate once by hand or with Unity's
  own `-serial` flow, and `compile`, `test` and `build` fail with the licensing
  line from the log when the editor has no license.
- For `test`: the Unity Test Framework package in the project, with the tests in
  Edit Mode or Play Mode assemblies.
- For `build`: a static method in an Editor folder of the project that makes the
  build, such as one that calls `BuildPipeline.BuildPlayer`. The behavior does
  not supply one.

## Install and set up

```sh
swamp extension pull @reset/unity

swamp behavior create @reset/unity unity-project \
  --global-arg projectPath=unity \
  --global-arg timeoutSeconds=1800
```

There are no secrets to vault: the instance holds paths and a timeout only.

| Argument         | Default             | Meaning                                                                                                                      |
| ---------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `projectPath`    | required            | The Unity project directory (holds `Assets` and `ProjectSettings`), absolute or relative to the repository.                  |
| `editor`         | none                | Path of the editor executable to run. When unset, Unity Hub's default location for the project's version on the current OS.  |
| `timeoutSeconds` | `1800`              | The editor is killed and the method fails when it has not exited after this long.                                            |
| `logDir`         | `.swamp/unity/logs` | Where editor logs and test result files are written, absolute or relative to the repository. One file per run, by timestamp. |

The editor runs with standard input closed and a deadline, so a dialog, a hung
task or a second editor holding the project open cannot hang a workflow. The log
file is read after the run; when the editor wrote none, its console output is
read instead. Each record keeps the log file's path, the number of lines it had
and a bounded excerpt: every line that names an error, warning, exception,
license or build outcome, plus the last 20 lines, capped at 120.

## Resolve the editor

```sh
swamp behavior run unity-project version
```

Reads `m_EditorVersion` (and `m_EditorVersionWithRevision` when present) from
`ProjectSettings/ProjectVersion.txt`, and writes a `version` record with
`editorVersion`, the `editorPath` that was chosen, whether it came from the
`editor` argument or Unity Hub (`editorSource`), whether it exists
(`editorExists`), every path that was considered (`candidates`) and the host
`platform`. It never fails for a missing editor; the other methods do. On Linux
three paths are tried: `~/Unity/Hub/Editor/<version>/Editor/Unity`,
`~/Unity/Hub/Editor/<version>/Unity` and
`/opt/Unity/Hub/Editor/<version>/Editor/Unity`.

## Compile

```sh
swamp behavior run unity-project compile
swamp behavior run unity-project compile --input maxDiagnostics=200
```

Runs `-batchmode -nographics -quit -projectPath <path> -logFile <file>`. The
editor imports the project, compiles the scripts and exits. The `compile` record
has `errorCount` and `warningCount` (distinct diagnostics, since the editor
prints some twice), the first `maxDiagnostics` of them as `diagnostics` with
`file`, `line`, `column`, `severity`, `code` and `message`,
`diagnosticsTruncated`, the editor's `exitCode`, `durationSeconds`, the
`summaryLine` when the log has one (`Scripts have compiler errors.`), and the
log excerpt. Compiler errors are data, not a method failure: the record is
written with its counts, so a workflow asserts on `errorCount`. The method fails
when the editor exits non-zero with no compiler error in the log, when the log
has a licensing failure, or on the deadline.

## Test

```sh
swamp behavior run unity-project test
swamp behavior run unity-project test --input platform=PlayMode
swamp behavior run unity-project test --input 'testFilter=Game.Tests.PlayerTests' --input 'testCategory=Fast;!Slow'
```

Runs
`-batchmode -nographics -projectPath <path> -runTests -testPlatform
<EditMode|PlayMode> -testResults <file> -logFile <file>`,
with `-testFilter` and `-testCategory` when given. `-quit` is not passed: the
Test Framework documents it as unsupported while tests run, and the editor exits
when the run ends. The result file is the NUnit XML the Test Framework writes
under `logDir`. The `test` record has the run's `result`, `total`, `passed`,
`failed`, `inconclusive` and `skipped` from the file's `test-run` element, the
first `maxFailures` failed test cases as `failures` with `name`, `fullName`, the
failure `message` and `stackTrace` when there is one, `failuresTruncated`, the
`resultsFile` and `logFile` paths, the `exitCode` and the log excerpt. Failed
tests are data: assert on `failed`. The method fails when no result file was
written (the error names the compiler errors when the log has some, since the
tests cannot run then), on a licensing failure, or on the deadline.

## Build

```sh
swamp behavior run unity-project build \
  --input method=Builds.Pipeline.BuildWindows \
  --input buildTarget=win64 \
  --input 'extraArgs:json=["-outputPath","Builds/win64"]'
```

Runs
`-batchmode -nographics -quit -projectPath <path> -buildTarget <target>
-executeMethod <method> <extraArgs...> -logFile <file>`.
`method` is `Class.Method` or `Namespace.Class.Method`, static, in an Editor
folder of the project; it reads its own parameters with
`System.Environment.GetCommandLineArgs`, which is how Unity documents passing
them. `buildTarget` is one of the names the manual lists: `android`,
`cloudrendering`, `ios`, `linux64`, `osxuniversal`, `tvos`, `visionos`,
`windowsstoreapps`, `webgl`, `win`, `win64`. `extraArgs` are appended as they
are and may not repeat an argument the method sets itself. The `build` record
has the `method`, `buildTarget`, `extraArgs`, `exitCode`, `durationSeconds`, the
`summaryLine` when the log has one, and the log excerpt. A non-zero exit fails
the method, since Unity documents that an exception in the method or
`EditorApplication.Exit` with a non-zero code is how a build reports failure;
the error quotes the summary line and the compiler error count.

## A verification workflow

Compile, assert the project is clean, run the Edit Mode tests, assert none
failed:

```yaml
jobs:
  - name: verify
    steps:
      - name: compile
        task:
          type: behavior
          behavior: unity-project
          methodName: compile
      - name: compiles
        dependsOn:
          - step: compile
            condition:
              type: succeeded
        task:
          type: assert
          expr: >-
            int(data.latest("unity-project", "compile").attributes.errorCount)
            == 0
          message: The project has compiler errors
      - name: test
        dependsOn:
          - step: compiles
            condition:
              type: succeeded
        task:
          type: behavior
          behavior: unity-project
          methodName: test
          inputs:
            platform: EditMode
      - name: tests-pass
        dependsOn:
          - step: test
            condition:
              type: succeeded
        task:
          type: assert
          expr: >-
            int(data.latest("unity-project", "test").attributes.failed) == 0
          message: Tests failed
```

## What Unity documents, and what it does not

The arguments, the Hub locations, the build target names, the return code 1 on
an exception in batch mode and the NUnit result format come from Unity's manual,
the Test Framework manual and NUnit's documentation. Unity does not document the
editor log's line shapes or the exit code of a test run ("no common definition
for exit codes"), so the compiler diagnostic pattern
(`path(line,column): error CSnnnn: message`, the C# compiler's own format), the
licensing failure lines and the summary lines are patterns observed in editor
logs, and `test` reads the result file rather than the exit code.

## License

MIT, see LICENSE.
