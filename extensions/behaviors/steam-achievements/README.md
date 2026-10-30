# @reset/steam-achievements

Record a Steam app's global achievement unlock percentages, over time, from
Swamp. The behavior reads Steam's public Web API method
[`GetGlobalAchievementPercentagesForApp`](https://partner.steamgames.com/doc/webapi/ISteamUserStats#GetGlobalAchievementPercentagesForApp),
which needs no API key and no Steam account, so a Swamp repository and an app id
are all it takes.

| Method      | What it does                                                                                                      | Writes                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `sample`    | Reads every achievement's unlock percentage and records them as a new version                                     | `sample`, `app-<appId>`      |
| `summarise` | Reads every recorded sample back and records per achievement first, latest and change, the rarest and most common | `summary`, `summary-<appId>` |

Each `sample` run adds a version to the same record, so the history is the
record's versions. Versions are kept for 365 days.

## Install and set up

```sh
swamp extension pull @reset/steam-achievements

# One behavior instance per app. 440 is Team Fortress 2; use any public app id.
swamp behavior create @reset/steam-achievements tf2-achievements --global-arg appId=440
```

## Sample and summarise

```sh
# Record the current percentages. Run it by hand or on a schedule.
swamp behavior run tf2-achievements sample

# Summarise everything recorded, or only what was recorded since a time.
swamp behavior run tf2-achievements summarise
swamp behavior run tf2-achievements summarise --input since=2026-10-01T00:00:00Z
```

A sample record looks like this, with every achievement in Steam's order, most
common first:

```json
{
  "appId": 440,
  "count": 520,
  "achievements": [
    { "name": "TF_SCOUT_LONG_DISTANCE_RUNNER", "percent": 49.5 },
    { "name": "TF_HEAVY_DAMAGE_TAKEN", "percent": 39.9 },
    { "name": "...", "percent": 0 }
  ],
  "sampledAt": "2026-10-22T12:00:00.000Z"
}
```

`percent` is the share of the app's players who have unlocked the achievement,
from 0 to 100. Steam sends it as a decimal string such as `"49.5"`; the record
holds it as a number.

The summary record holds `samples`, `since`, the times of the first and latest
samples, `count` (achievements in the latest sample), the `rarest` and
`mostCommon` achievement of the latest sample, the names `added` and `removed`
between the first and the latest sample, and per achievement its `first` and
`latest` percentage and their `change`:

```json
{
  "appId": 440,
  "samples": 30,
  "since": null,
  "firstSampledAt": "2026-09-23T12:00:00.000Z",
  "latestSampledAt": "2026-10-22T12:00:00.000Z",
  "count": 520,
  "rarest": { "name": "TF_PASS_TIME_GRIND", "percent": 3.2 },
  "mostCommon": { "name": "TF_SCOUT_LONG_DISTANCE_RUNNER", "percent": 49.5 },
  "added": [],
  "removed": [],
  "achievements": [
    {
      "name": "TF_HEAVY_DAMAGE_TAKEN",
      "first": 39.7,
      "firstSeenAt": "2026-09-23T12:00:00.000Z",
      "latest": 39.9,
      "lastSeenAt": "2026-10-22T12:00:00.000Z",
      "change": 0.2
    }
  ],
  "summarisedAt": "2026-10-22T12:00:05.000Z"
}
```

`achievements` lists every achievement seen in any summarised sample, sorted by
name. An achievement added after the first sample takes `first` from the first
sample that has it, and one removed keeps the `latest` of the last sample that
had it; `firstSeenAt` and `lastSeenAt` say which. `change` is `latest` minus
`first` in percentage points, rounded to six decimals. On a tie the rarest or
most common is the first by name.

`since` is a UTC ISO-8601 time ending in `Z`. A workflow reads either record
with `data.latest("tf2-achievements", "summary-440")`.

## Achievement names

Achievements are named by their API names, such as `TF_KILL_NEMESIS`. Steam's
display names and descriptions come from `GetSchemaForGame`, which needs a Web
API key, so this behavior does not read them.

## Errors

`sample` writes nothing when Steam does not answer with a list of percentages,
and says why:

- HTTP 403 or 404 is reported as an app with no public achievement statistics,
  naming the app id. An app that exists without achievements, or a body with an
  empty list, is reported the same way.
- HTTP 429 is reported as a rate limit, with Steam's `Retry-After` when it sends
  one. Steam does not publish a rate limit for this method.
- HTTP 500 and above is reported as a transient failure to retry later.
- A body without an `achievementpercentages.achievements` list, or with an entry
  that has no name, a percentage outside 0 to 100, or a name seen twice, is
  reported with its status.
- A request that takes longer than 15 seconds is abandoned.

`summarise` fails when no sample of the app has been recorded (in the `since`
window, when one is given), and skips, with a warning, any stored record that is
not a sample of the instance's app.

## Finding an app id

The app id is the number in the app's store address: Team Fortress 2 is
`store.steampowered.com/app/440/`, so its id is 440.

## Choosing an interval

Global percentages move slowly for an established game: once a day shows a
trend across weeks. Around a launch or an update that adds achievements, once
an hour shows the new ones climb. Each sample is one record version holding
every achievement, so the interval and the number of achievements set how fast
the history grows.

## Reading the trend

`summarise` gives the ends. For the shape of the curve, query the samples and
sort by time:

```sh
swamp data query 'modelName == "tf2-achievements" && name == "app-440" && version >= 0' \
  --select '{"at": attributes.sampledAt, "achievements": attributes.achievements}'
```

## What is stored

Each sample holds the app id, the achievement count, each achievement's API name
and global percentage, and the time it was read. The method reports aggregates
over all players, so no player, account or per-player data is requested,
received or stored.

## Removing an instance

`swamp behavior delete tf2-achievements --yes` removes the instance. Its
recorded samples and summaries are versions in the repository's data store and
expire after the 365 days each version is kept.

## Changes

- 2026.10.30.1: moved to <https://github.com/reset/swamp-extensions>, now its published home, with an upgrade that leaves existing instances' arguments as they are. Behavior unchanged.
- 2026.10.22.2: the registry now shows every argument's description, which it showed empty before; `summarise`'s `since` argument, missing from the registry's list before, is listed.
- 2026.10.22.1: first release, `sample` and `summarise`.

## License

MIT, see LICENSE.
