# @reset/wwise

A Swamp behavior for an open Wwise Authoring instance, driven through WAAPI,
Audiokinetic's Wwise Authoring API, over its WAMP WebSocket endpoint. It reads
Wwise and project facts, runs WAQL queries, lists the project's Events and
SoundBanks with their inclusions, generates SoundBanks within a deadline and
saves the project. Every method writes what it read as a versioned resource, so
a workflow can assert on it with CEL and a report can read it later.

It needs nothing beyond Swamp and a running Wwise with the Wwise Authoring API
enabled. It speaks the documented interface only: WAMP over WebSocket with the
`wamp.2.json` subprotocol on realm `realm1`, and the procedures
`ak.wwise.core.getInfo`, `ak.wwise.core.getProjectInfo`,
`ak.wwise.core.object.get`, `ak.wwise.core.soundbank.getInclusions`,
`ak.wwise.core.soundbank.generate` and `ak.wwise.core.project.save`. The WAMP
caller lives in the behavior itself: no npm WAMP client is pulled in.

## Install

```sh
swamp extension pull @reset/wwise
```

## Set up a behavior instance

WAAPI has no credentials: Wwise accepts connections from the local machine, and
from the addresses listed under Project, User Preferences, Allow connections
from. So the instance holds only the endpoint and a timeout, and nothing goes in
a vault. For Wwise on the same machine the host can be left out:

```sh
swamp behavior create @reset/wwise wwise-local
```

For a Wwise on another machine that lists this one in its allow list, give the
host:

```sh
swamp behavior create @reset/wwise wwise-build-host \
  --global-arg host=ws://wwise.example.net:8080/waapi \
  --global-arg timeoutSeconds=60
```

Global arguments:

| Argument         | Default                     | Meaning                                                                                            |
| ---------------- | --------------------------- | -------------------------------------------------------------------------------------------------- |
| `host`           | `ws://127.0.0.1:8080/waapi` | WAAPI's WAMP endpoint. Port 8080 is Wwise's default; the HTTP endpoint on 8090 is not used.        |
| `timeoutSeconds` | `30`                        | Seconds a connection or an ordinary call may take before the method fails. `generate` has its own. |

## Methods

```sh
swamp behavior run wwise-local info
swamp behavior run wwise-local query --arg 'waql=$ from type Sound where volume < -6' --arg 'return:json=["name","path","Volume"]'
swamp behavior run wwise-local events
swamp behavior run wwise-local banks
swamp behavior run wwise-local generate --arg 'banks:json=["Main","Music"]' --arg 'platforms:json=["Windows"]'
swamp behavior run wwise-local save
```

| Method     | Arguments                                                                                                                                                                                                                   | Calls                                                               | Writes         |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------- |
| `info`     | none                                                                                                                                                                                                                        | `getInfo`, `getProjectInfo`                                         | `info`         |
| `query`    | `waql`, `return` (`id`, `name`, `type`, `path`), `offset` (0), `limit` (1000), `name` (`query`), `platform`, `language`                                                                                                     | `object.get` with `skip` and `take` appended                        | `query-<name>` |
| `events`   | `offset` (0), `limit` (5000)                                                                                                                                                                                                | `object.get` with `$ from type Event`                               | `events`       |
| `banks`    | `offset` (0), `limit` (5000)                                                                                                                                                                                                | `object.get` with `$ from type SoundBank`, `getInclusions` per bank | `banks`        |
| `generate` | `banks` (all), `platforms` (all), `languages` (all), `skipLanguages`, `rebuildSoundBanks`, `clearAudioFileCache`, `writeToDisk` (true), `rebuildInitBank`, `deadlineSeconds` (1800), `failOnError` (true), `logLimit` (500) | `soundbank.generate`                                                | `generation`   |
| `save`     | `autoCheckOutToSourceControl` (true)                                                                                                                                                                                        | `project.save`, then `getProjectInfo`                               | `save`         |

Each listing resource carries `count` and `truncated`: the behavior asks Wwise
for one object more than `limit`, so `truncated: true` means the query matched
more than was kept, and `offset` reaches the rest. `events` keeps `id`, `name`,
`path` and `notes`. `banks` keeps the same for each SoundBank plus `bnkFilePath`
when Wwise reports a generated file, and `inclusions` with each included
object's GUID, `name`, `type`, `path` and `filter` (`events`, `structures`,
`media`).

`query` runs any WAQL query and keeps the accessors in `return` for each object,
as Wwise answers them: core accessors such as `id`, `name`, `type`, `path`,
`notes` and `shortId`, properties such as `Volume`, and dotted chains such as
`OutputBus.name`. Several queries coexist under different `name` suffixes. A
query that Wwise rejects fails the method with Wwise's message.

`generate` is a synchronous WAAPI call that can take minutes, so it has its own
`deadlineSeconds`. The `generation` resource keeps what was asked, `succeeded`,
`seconds`, counts by severity (`messages`, `warnings`, `errors`, `fatal`), the
first `error` and the log entries up to `logLimit` (`logTruncated` says when
more were cut). By default an entry at severity Error or Fatal Error fails the
method and nothing is written; with `failOnError: false` the resource is written
with `succeeded: false` instead, for a workflow that wants the log either way.
`writeToDisk` defaults to true, unlike the raw WAAPI call, because a build step
wants the files.

`save` records the project's name, path and `isDirty` after the save, read back
through `getProjectInfo`. `info` keeps Wwise's version object, platform,
configuration, process id and directories, and the project's name, path, id,
dirty state, platforms (with each SoundBank output path), languages and
directories, or `project: null` when no project is open.

## Assert on the project from a workflow

```yaml
jobs:
  - name: banks
    steps:
      - name: generate
        task:
          type: behavior
          behavior: wwise-local
          methodName: generate
          inputs:
            banks: ["Main"]
            platforms: ["Windows"]
            failOnError: false
      - name: clean-log
        dependsOn:
          - step: generate
            condition:
              type: succeeded
        task:
          type: assert
          expr: >-
            data.latest("wwise-local", "generation").attributes.succeeded &&
            int(data.latest("wwise-local", "generation").attributes.counts.warnings) == 0
          message: the SoundBank generation reported errors or warnings
          severity: high
```

## Errors and timeouts

A failure throws a `WaapiError` whose `code` says what happened: `connect` when
no WAMP session could be opened (Wwise not running, the Wwise Authoring API
disabled in User Preferences, or this machine missing from the allow list),
`timeout` when the connection or a call passed its deadline, `call` when Wwise
answered a WAMP ERROR (then `uri` is the error URI and the message is Wwise's),
`protocol` when a frame could not be understood, `closed` when Wwise ended the
session under a call, and `aborted` when the run was cancelled. Nothing is
written before a method fails, so a failed step leaves no misleading data
behind. Every session ends with GOODBYE and the socket is closed on every path,
including timeouts and cancellation.

## Paths on macOS

WAAPI reports and expects Windows-style paths on macOS: the root folder is drive
`Z:` and the home folder drive `Y:`, so a project at
`/Volumes/work/Game/Game.wproj` appears as `Z:\Volumes\work\Game\Game.wproj` in
the `info`, `save` and `banks` resources.

## Security

WAAPI gives whoever reaches it control of Wwise. Keep ports 8080 and 8090 behind
the firewall, list only the machines that need access in User Preferences, and
never `*`. A `host` with userinfo in the URL is never recorded: the resources,
logs and errors keep the URL without it.

## License

MIT, see LICENSE.
