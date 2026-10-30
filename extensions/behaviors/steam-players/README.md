# @reset/steam-players

Record how many people are playing a Steam app, over time, from Swamp. The
behavior reads Steam's public Web API method
[`ISteamUserStats/GetNumberOfCurrentPlayers`](https://partner.steamgames.com/doc/webapi/ISteamUserStats#GetNumberOfCurrentPlayers),
which needs no API key and no Steam account, so a Swamp repository and an app id
are all it takes.

| Method      | What it does                                                                    | Writes                       |
| ----------- | ------------------------------------------------------------------------------- | ---------------------------- |
| `sample`    | Reads the app's current concurrent player count and records it as a new version | `sample`, `app-<appId>`      |
| `summarise` | Reads every recorded sample back and records the count, first, min, max, latest | `summary`, `summary-<appId>` |

Each `sample` run adds a version to the same record, so the history is the
record's versions. Versions are kept for 365 days.

## Install and set up

```sh
swamp extension pull @reset/steam-players

# One behavior instance per app. 440 is Team Fortress 2; use any public app id.
swamp behavior create @reset/steam-players tf2-players --global-arg appId=440
```

## Sample and summarise

```sh
# Record the current count. Run it as often as you like, by hand or on a schedule.
swamp behavior run tf2-players sample

# Summarise everything recorded, or only what was recorded since a time.
swamp behavior run tf2-players summarise
swamp behavior run tf2-players summarise --input since=2026-10-01T00:00:00Z
```

The summary record looks like this:

```json
{
  "appId": 440,
  "samples": 3,
  "since": null,
  "first": { "playerCount": 61234, "sampledAt": "2026-10-21T09:00:00.000Z" },
  "min": { "playerCount": 58210, "sampledAt": "2026-10-21T10:00:00.000Z" },
  "max": { "playerCount": 64003, "sampledAt": "2026-10-21T11:00:00.000Z" },
  "latest": { "playerCount": 64003, "sampledAt": "2026-10-21T11:00:00.000Z" },
  "summarisedAt": "2026-10-21T11:00:05.000Z"
}
```

`since` is a UTC ISO-8601 time ending in `Z`. On a tie the earliest sample is
the minimum or maximum. A workflow reads either record with
`data.latest("tf2-players", "summary-440")`, and the raw history is one query
away:

```sh
swamp data query 'modelName == "tf2-players" && name == "app-440" && version >= 0' \
  --select '{"at": attributes.sampledAt, "players": attributes.playerCount}'
```

## Errors

`sample` writes nothing when Steam does not answer with a count, and says why:

- An app id Steam does not know comes back as HTTP 404 with `result` 42, and the
  error names the app id and the result.
- HTTP 429 is reported as a rate limit, with Steam's `Retry-After` when it sends
  one. Steam does not publish a rate limit for this method.
- HTTP 500 and above is reported as a transient failure to retry later.
- A request that takes longer than 15 seconds is abandoned.

`summarise` fails when no sample of the app has been recorded (in the `since`
window, when one is given), and skips, with a warning, any stored record that is
not a sample of the instance's app.

The count is what Steam reports for the moment of the request: players in the
app on Steam, not across other stores. Steam caches it, so samples taken seconds
apart usually return the same number.

## Finding an app id

The app id is the number in the app's store address: Team Fortress 2 is
`store.steampowered.com/app/440/`, so its id is 440. Any app with a public store
page works, released or not, though an unreleased app usually reports zero.

## Choosing an interval

Steam caches the count, so sampling more often than every few minutes records
the same number again. Every 15 minutes shows a day's peaks and troughs; once an
hour is enough for a trend across weeks. Each sample is one record version, so
the interval also sets how fast the history grows.

## Comparing apps

Make one instance per app and sample each on the same schedule. Their summaries
are separate records (`summary-<appId>`), so a workflow can read several with
`data.latest` and compare them, for example your game against the titles you
launched beside.

## Reading the trend

`summarise` gives the extremes. For the shape of the curve, query the samples
and sort by time:

```sh
swamp data query 'modelName == "tf2-players" && name == "app-440" && version >= 0' \
  --select '{"at": attributes.sampledAt, "players": attributes.playerCount}'
```

A launch or an update shows as a step in the series rather than in the summary.

## What is stored

Each sample holds three fields: the app id, the count and the time it was read.
The count is an aggregate that Steam publishes for anyone to read, so no player
data is requested, received or stored.

## Removing an instance

`swamp behavior delete tf2-players --yes` removes the instance. Its recorded
samples and summaries are versions in the repository's data store and expire
after the 365 days each version is kept.

## Changes

- 2026.10.30.1: moved to <https://github.com/reset/swamp-extensions>, now its published home, with an upgrade that leaves existing instances' arguments as they are. Behavior unchanged.
- 2026.10.22.1: the registry now shows every argument's description, which it showed empty before; `summarise`'s `since` argument, missing from the registry's list before, is listed.
- 2026.10.21.7: removing an instance in the README.
- 2026.10.21.8: packaged without this README, by mistake.
- 2026.10.21.9: the README is back in the package.

- 2026.10.21.6: what is stored in the README.

- 2026.10.21.5: reading the trend in the README.

- 2026.10.21.4: comparing apps in the README.

- 2026.10.21.3: choosing an interval in the README.

- 2026.10.21.2: finding an app id in the README.

## License

MIT, see LICENSE.
