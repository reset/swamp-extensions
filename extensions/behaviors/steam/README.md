# @reset/steam

Publish a game's builds to Steam from Swamp. The behavior type has four methods:

| Method    | What it does                                                                                         | Talks to                                    |
| --------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `upload`  | Runs `steamcmd +run_app_build` with a generated or supplied app build script and records the BuildID | steamcmd on the machine                     |
| `builds`  | Reads the app's newest builds and the branch each one is live on                                     | `ISteamApps/GetAppBuilds`, `GetAppBetas`    |
| `betas`   | Reads the app's branches and the build live on each                                                  | `ISteamApps/GetAppBetas`                    |
| `setLive` | Sets a build live on a branch, unless it already is                                                  | `ISteamApps/GetAppBetas`, `SetAppBuildLive` |

Every method writes a record swamp keeps with its provenance: `upload`,
`builds`, `release` and `betas`. A workflow reads them with
`data.latest("<instance>", "<record>")`.

## Prerequisites

- Swamp, in a repository that has run `swamp repo init`.
- For `upload`: steamcmd on the machine, and a Steam account that may upload
  builds for the app. Valve's instructions are at
  <https://partner.steamgames.com/doc/sdk/uploading>.
- For `builds`, `betas` and `setLive`: a publisher Web API key of the Steamworks
  group that owns the app (Steamworks, Users and Permissions, Manage Groups,
  Create WebAPI Key). A user key does not work and gets HTTP 403.

## Install and set up

```sh
swamp extension pull @reset/steam

# Secrets live in a vault. The behavior instance only references them.
swamp vault put default STEAM_PASSWORD        # prompts, hidden input
swamp vault put default STEAM_WEB_API_KEY     # prompts, hidden input

swamp behavior create @reset/steam steam-app \
  --global-arg appId=480 \
  --global-arg username=steam-build-account \
  --global-arg 'password=${{ vault.get(default, STEAM_PASSWORD) }}' \
  --global-arg 'webApiKey=${{ vault.get(default, STEAM_WEB_API_KEY) }}' \
  --global-arg contentRoot=build/StandaloneLinux64
```

`appId` 480 and depot 481 below are Valve's public test app (Spacewar). Use your
own ids. `steamcmd` defaults to the command name and can be a path.
`contentRoot` is the directory the depot patterns are relative to and is only
needed when `upload` generates the script. Leave `password` out when steamcmd on
that machine already holds a cached login (see Steam Guard below).

## Upload a build

```sh
# Generated script: one depot, everything under contentRoot, set live on "beta".
swamp behavior run steam-app upload \
  --input 'depots:json={"481":"*"}' \
  --input 'description=Nightly 2026-10-20' \
  --input setLive=beta

# Your own app build script, run as it is.
swamp behavior run steam-app upload --input vdf=steam/app_build_480.vdf
```

A depot mapping is a `localPath` pattern, or an object with `localPath`,
`depotPath`, `recursive` and `exclusions`. The generated script sets
`BuildOutput` to `.swamp/steam/build-output/<appId>` under the repository unless
`buildOutput` says otherwise. steamcmd keeps its chunk cache there, so a
re-upload of mostly unchanged content is fast.

`upload` runs steamcmd with standard input closed and a deadline
(`timeoutSeconds`, default 3600), so a prompt cannot hang the run. It parses the
output for `Successfully finished AppID <id> build (BuildID <n>)` and writes an
`upload` record with the BuildID, exit code, the lines that name a depot and a
bounded log excerpt. The password and any Steam Guard code are redacted from the
record and from error messages. The password is still passed to steamcmd as an
argument, which is how steamcmd takes it, so it is visible in the process list
on that machine while steamcmd runs.

## Steam Guard

Steam Guard protects the build account. steamcmd caches a login per machine and
user, so the practice is:

1. On a new machine, log in once by hand so steamcmd can ask for the code:
   `steamcmd +login <account>`, type the password, type the code from the mobile
   authenticator or the email, then `quit`. From then on `upload` uses the
   cached login, and `password` can be left out of the instance.
2. A code is accepted once and changes every 30 seconds. Two uploads from the
   same account at the same time can spend each other's codes. Run them one at a
   time.
3. For a single run on a machine without a cached login, pass the code:
   `--input steamGuardCode=ABCDE`. The method passes it with
   `+set_steam_guard_code` before the login. It is never recorded.

A failed login looks like
`Logging in user 'x' to Steam Public...FAILED
(Two-factor code mismatch)`, or
steamcmd stops at a `Steam Guard code:` prompt. `upload` fails with an error
that names Steam Guard and quotes that line instead of hanging. Do not retry in
a loop: Steam rate limits logins, and a spent code is refused until the next
30-second step. A `FAILED (Invalid
Password)` line is reported as a plain login
failure, not as Steam Guard.

## Read builds and set one live

```sh
swamp behavior run steam-app builds --input count=50
swamp behavior run steam-app betas
swamp behavior run steam-app setLive --input buildId=1234567 --input branch=beta
```

`builds` writes a `builds` record with `buildIds` (newest first), each build's
description, creation time, creator account id, the branches it is live on, and
the raw build object Steam returned. `truncated` is true when Steam returned as
many builds as were asked for, so older ones may exist.

`setLive` first reads the branches. When the build is already live on the branch
it writes the `release` record with `alreadyLive: true` and makes no change, so
a retried workflow does not ask Steam twice. Otherwise it posts
`SetAppBuildLive` with the key in the request body. The `public` branch is the
default branch players get. Steamworks can require a confirmation in the Steam
mobile app for default-branch changes: pass `approverSteamId` (a SteamID64) and
that account gets the confirmation.

HTTP 401 and 403 are reported as a rejected key. A `result` other than 1 in
Steam's response is reported with Steam's `message`. The key goes in the query
string of GET calls because that is how the Web API takes it, and it is redacted
from every error message.

## A promotion workflow

A workflow that reads the builds, asserts the named one is among them, waits for
a person, then sets it live:

```yaml
jobs:
  - name: promote
    steps:
      - name: builds
        task:
          type: behavior
          behavior: steam-app
          methodName: builds
          inputs:
            count: 100
      - name: build-exists
        dependsOn:
          - step: builds
            condition:
              type: succeeded
        task:
          type: assert
          expr: >-
            inputs.buildId in
            data.latest("steam-app", "builds").attributes.buildIds
          message: Build ${{ inputs.buildId }} is not among the newest builds
      - name: approve
        dependsOn:
          - step: build-exists
            condition:
              type: succeeded
        task:
          type: manual_approval
          prompt: Set build ${{ inputs.buildId }} live on ${{ inputs.branch }}?
          timeout: 86400
      - name: set-live
        dependsOn:
          - step: approve
            condition:
              type: succeeded
        task:
          type: behavior
          behavior: steam-app
          methodName: setLive
          inputs:
            buildId: ${{ inputs.buildId }}
            branch: ${{ inputs.branch }}
```

## License

MIT, see LICENSE.
