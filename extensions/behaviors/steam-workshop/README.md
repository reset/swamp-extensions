# @reset/steam-workshop

Record a Steam Workshop item's public statistics, over time, from Swamp. The
behavior reads Steam's public Web API method
[`GetPublishedFileDetails`](https://partner.steamgames.com/doc/webapi/ISteamRemoteStorage#GetPublishedFileDetails),
which needs no API key and no Steam account, so a Swamp repository and an item
id are all it takes.

| Method      | What it does                                                                                         | Writes                        |
| ----------- | ---------------------------------------------------------------------------------------------------- | ----------------------------- |
| `sample`    | Reads the item's counts, title, app, creator, times, size and tags and records them as a new version | `sample`, `item-<itemId>`     |
| `summarise` | Reads every recorded sample back and records each count's first, latest and change, and last update  | `summary`, `summary-<itemId>` |

Each `sample` run adds a version to the same record, so the history is the
record's versions. Versions are kept for 365 days.

## Install and set up

```sh
swamp extension pull @reset/steam-workshop

# One behavior instance per item. 104691717 is PAC3 for Garry's Mod; use any public item id.
swamp behavior create @reset/steam-workshop pac3 --global-arg itemId=104691717
```

## Sample and summarise

```sh
# Record the current statistics. Run it by hand or on a schedule.
swamp behavior run pac3 sample

# Summarise everything recorded, or only what was recorded since a time.
swamp behavior run pac3 summarise
swamp behavior run pac3 summarise --input since=2026-10-01T00:00:00Z
```

A sample record looks like this:

```json
{
  "itemId": "104691717",
  "title": "PAC3",
  "appId": 4000,
  "creator": "76561190000000001",
  "createdAt": "2012-10-26T03:41:02.000Z",
  "updatedAt": "2026-10-15T03:26:31.000Z",
  "subscriptions": 915651,
  "lifetimeSubscriptions": 2403729,
  "favorited": 45834,
  "lifetimeFavorited": 54548,
  "views": 875451,
  "fileSize": 8707715,
  "tags": ["Addon", "tool", "Fun", "Roleplay"],
  "sampledAt": "2026-10-22T12:00:00.000Z"
}
```

`appId` is the app the item is for (Steam's `consumer_app_id`) and `creator` is
the SteamID64 of the account that published it. `subscriptions` and
`favorited` count those subscribed or favouriting now; the `lifetime` counts
include everyone who ever did. `fileSize` is in bytes; Steam sends it as a
decimal string, and the record holds it as a number. `createdAt` and
`updatedAt` are Steam's Unix times as UTC ISO-8601.

The summary record holds `samples`, `since`, the times of the first and latest
samples, the latest `title`, `appId`, `createdAt` and `updatedAt`,
`updatedSinceFirst` (whether `updatedAt` moved between the first and the latest
sample), and in `changes` the `first`, `latest` and `change` of each count and
the file size:

```json
{
  "itemId": "104691717",
  "title": "PAC3",
  "appId": 4000,
  "samples": 30,
  "since": null,
  "firstSampledAt": "2026-09-23T12:00:00.000Z",
  "latestSampledAt": "2026-10-22T12:00:00.000Z",
  "createdAt": "2012-10-26T03:41:02.000Z",
  "updatedAt": "2026-10-15T03:26:31.000Z",
  "updatedSinceFirst": true,
  "changes": {
    "subscriptions": { "first": 910204, "latest": 915651, "change": 5447 },
    "lifetimeSubscriptions": {
      "first": 2391022,
      "latest": 2403729,
      "change": 12707
    },
    "favorited": { "first": 45610, "latest": 45834, "change": 224 },
    "lifetimeFavorited": { "first": 54290, "latest": 54548, "change": 258 },
    "views": { "first": 870120, "latest": 875451, "change": 5331 },
    "fileSize": { "first": 8701002, "latest": 8707715, "change": 6713 }
  },
  "summarisedAt": "2026-10-22T12:00:05.000Z"
}
```

`change` is `latest` minus `first`, so a drop in current subscribers is
negative. `since` is a UTC ISO-8601 time ending in `Z`. A workflow reads either
record with `data.latest("pac3", "summary-104691717")`.

## Errors

`sample` writes nothing when Steam does not answer with the item's details, and
says why:

- An item Steam has no public record of (its result 9, for an id that does not
  exist or an item that is private, friends-only or removed) is reported as
  such, naming the item id. Any other per-item result is reported with its code.
- HTTP 429 is reported as a rate limit, with Steam's `Retry-After` when it sends
  one. Steam does not publish a rate limit for this method.
- HTTP 500 and above is reported as a transient failure to retry later.
- A body that is not JSON, has no single entry under
  `response.publishedfiledetails`, answers for another item, or lacks a count,
  time, title or creator, is reported with its status and the field.
- A request that takes longer than 15 seconds is abandoned.

`summarise` fails when no sample of the item has been recorded (in the `since`
window, when one is given), and skips, with a warning, any stored record that is
not a sample of the instance's item.

## Finding an item id

The item id is the `id` in the item's page address:
`steamcommunity.com/sharedfiles/filedetails/?id=104691717` is item 104691717.
It is passed as a string because Steam's ids are 64-bit.

## Choosing an interval

Counts on an established item move slowly: once a day shows a trend across
weeks. Around a release or an update, once an hour shows the subscriptions
climb. Each sample is one small record version, so the interval sets how fast
the history grows.

## Reading the trend

`summarise` gives the ends. For the shape of the curve, query the samples and
sort by time:

```sh
swamp data query 'modelName == "pac3" && name == "item-104691717" && version >= 0' \
  --select '{"at": attributes.sampledAt, "subscriptions": attributes.subscriptions}'
```

## What is stored

Each sample holds the item's id, title, app, creation and update times, counts,
size and tags, the time it was read, and the creator's SteamID64, which Steam
publishes on the item's page. The item's description, preview image and file
are not stored, and no subscriber, viewer or other per-player data is
requested, received or stored: the counts are aggregates.

## Removing an instance

`swamp behavior delete pac3 --yes` removes the instance. Its recorded samples
and summaries are versions in the repository's data store and expire after the
365 days each version is kept.

## Changes

- 2026.10.30.1: moved to <https://github.com/reset/swamp-extensions>, now its published home, with an upgrade that leaves existing instances' arguments as they are. Behavior unchanged.
- 2026.10.22.1: first release, `sample` and `summarise`.

## License

MIT, see LICENSE.
