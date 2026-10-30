# @reset/steamworks-builds

Record which build each of a Steam app's branches runs, and the app's recent
builds, from Valve's Steamworks partner Web API, and summarise how the branches
moved. Every `sample` is a new version of the app's record; `summarise` turns
the history into each branch's builds, how often it moved, and the newest
build.

| Method      | What it does                                                                                   | Writes                     |
| ----------- | ---------------------------------------------------------------------------------------------- | -------------------------- |
| `sample`    | Reads the branches and recent builds, records them, and flags branches on a new build          | `builds`, `builds-<app>`   |
| `summarise` | Reads every recorded version back and records each branch's build history and the newest build | `summary`, `summary-<app>` |

Versions of `builds` are kept for 730 days, `summary` keeps its last 10.

## Endpoints

Two methods are called, one at a time, on Valve's partner host only:

- [`GET https://partner.steam-api.com/ISteamApps/GetAppBetas/v1/`](https://partner.steamgames.com/doc/webapi/ISteamApps)
  with `appid`: the app's branches.
- [`GET https://partner.steam-api.com/ISteamApps/GetAppBuilds/v1/`](https://partner.steamgames.com/doc/webapi/ISteamApps)
  with `appid` and `count` (10 when omitted): the app's recent builds.

Valve documents these methods and their parameters, but not their answers. The
shapes this extension reads were observed from real answers on 2026-10-23:

- `GetAppBetas` answers `response.betas`, a map from branch name to
  `BuildID`, `Description`, `ReqPassword` (0 or 1) and `ReqLocalCS`.
- `GetAppBuilds` answers `response.builds`, a map from build id to `BuildID`,
  `CreationTime` (epoch seconds), `Description`, `AccountIDCreator` and
  `depots`, a map from depot id to the depot's manifest GID and sizes.
- Both carry `response.result`, 1 on success, and `response.message`.

If Valve changes these shapes, `sample` fails with the field that no longer
matches rather than recording a partial read.

Two things are never recorded. Valve returns whether a branch needs a password,
never the password itself, and only the flag is kept. `AccountIDCreator` is the
Steam account that uploaded the build, which is personal data, so it is read
past.

## The key

The methods need a Steamworks publisher Web API key for a group that owns the
app (Users & Permissions, Manage Groups, the group's Web API key). Store it in a
vault and pass it as an expression. swamp refuses a literal value, because the
argument is marked sensitive.

```sh
pbpaste | swamp vault put default steamworks-publisher-key
swamp behavior create @reset/steamworks-builds my-game-builds \
  --global-arg 'apiKey=${{ vault.get(default, steamworks-publisher-key) }}' \
  --global-arg appId=480
```

The key goes only in the `x-webapi-key` request header that
[Valve documents](https://partner.steamgames.com/doc/webapi_overview/auth), and
only to `https://partner.steam-api.com`, with redirects refused. It is never in
a URL, a record or a log, and it is removed from any error text.

## Sample

```sh
# The branches and the 10 most recent builds.
swamp behavior run my-game-builds sample

# More history, up to 100 builds.
swamp behavior run my-game-builds sample --input count=50
```

Each version records every branch with its description, whether it needs a
password, the live build id, and that build's creation time and depots when it
is among the recent builds read. It also records the recent builds themselves,
newest first. `changedBranches` names the branches whose live build differs
from the previous version, and `removedBranches` the ones that are gone.

## Summarise

```sh
swamp behavior run my-game-builds summarise
swamp behavior run my-game-builds summarise --input branch=public
```

For each branch: the builds it ran, in order, with the first version that
showed each (a build it returns to appears again), how many times it moved,
and whether the latest version still had it. It also names the newest build any
version read.

## Rate limits and when to sample

Valve publishes no request quota for these methods. Its
[Web API overview](https://partner.steamgames.com/doc/webapi_overview) says an
address answered 403 gets strict rate limits, so a 403 stops the run with an
explanation and is never retried. Sampling once an hour is plenty to catch a
branch moving.

## Errors

- **403:** the key isn't a publisher key that owns the app, or the calling
  address isn't on the key's allow list. Fix the key before retrying.
- **429:** reported with `Retry-After` when Valve sends it.
- **5xx:** a transient failure, retry later.
- **`result` other than 1:** reported with Valve's `message`.
- **An answer that isn't the observed shape:** reported with the field that
  didn't match.

## Changes

- 2026.10.30.1: moved to <https://github.com/reset/swamp-extensions>, now its published home, with an upgrade that leaves existing instances' arguments as they are. Behavior unchanged.
- 2026.10.23.1: first release, `sample` and `summarise`.

## License

MIT, see LICENSE.
