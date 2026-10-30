# @reset/steam-reviews

A Swamp behavior for a Steam app's public user reviews, with two pairs of
methods. `summary` and `recent` read Steamworks' documented Web API method
[`IUserReviewsService/GetAppReviews`](https://partner.steamgames.com/doc/webapi/IUserReviewsService):
the score and totals for a set of filters, and the reviews created in a window,
counted positive and negative overall and by language. `sample` and `summarise`
read the `query_summary` of Steam's public store endpoint
[`appreviews`](https://partner.steamgames.com/doc/store/getreviews) and keep the
score as a history, so the trend over weeks can be read back. Each method writes
what it read as a versioned resource a workflow can assert on with CEL.

It needs nothing beyond Swamp and an app id: reviews are public, and neither
endpoint needs a key. A Steamworks Web API publisher key associated with the app
raises GetAppReviews' rate limit and is optional.

| Method      | What it does                                                                                    | Writes                       |
| ----------- | ----------------------------------------------------------------------------------------------- | ---------------------------- |
| `summary`   | Reads the score and totals for a set of filters with one GetAppReviews call                     | `score`, `score`             |
| `recent`    | Pages through the reviews created in a window and counts them overall and by language           | `recent`, `recent`           |
| `sample`    | Reads the app's review score and counts from `appreviews` and records them as a new version     | `sample`, `app-<appId>`      |
| `summarise` | Reads every recorded sample back and records first, latest, min and max ratio, and their change | `summary`, `summary-<appId>` |

The Writes column names the resource and the instance name it is written under.

## Install and set up

```sh
swamp extension pull @reset/steam-reviews

# One behavior instance per app. 440 is Team Fortress 2; use any public app id.
swamp behavior create @reset/steam-reviews tf2-reviews --global-arg appId=440
```

480 is Spacewar, Valve's test app. It has no store page, so Steam answers its
review query with an empty response: `recent` writes an empty window, and
`summary` and `sample` fail saying so. Any app with a store page answers with
its score.

To use a publisher key, put it in a vault, never in a YAML file, and reference
it by name. `swamp vault put` reads the value from stdin or a hidden prompt:

```sh
pbpaste | swamp vault put default steam-web-api-key
swamp behavior create @reset/steam-reviews my-game --global-arg appId=480 \
  --global-arg 'key=${{ vault.get(default, steam-web-api-key) }}'
```

| Argument | Default  | Meaning                                                                                                   |
| -------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `appId`  | required | The Steam app id whose reviews are read.                                                                  |
| `key`    | none     | Steamworks Web API publisher key for the app, sensitive. Raises the rate limit of `summary` and `recent`. |

## The score and a window: `summary` and `recent`

```sh
swamp behavior run my-game summary
swamp behavior run my-game recent --input days=3
swamp behavior run my-game recent --input since=1792000000 --input 'languages:json=["english","german"]'
```

| Method    | Arguments                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `summary` | `languages` (`["all"]`), `purchaseType` (`steam`), `includeOfftopic` (false)                                                    |
| `recent`  | the same, plus `since` or `days` (7), `until` (now), `perPage` (100), `maxPages` (10), `keepAuthor` (false), `keepText` (false) |

Both call
`GET https://api.steampowered.com/IUserReviewsService/GetAppReviews/v1/` with
`input_json`, `review_type` all, and `filter` Recent. `purchaseType` is `steam`
(Steam purchasers only, the default and what the store's score counts), `all`,
or `nonSteam`. Off-topic activity Steam filtered out (review bombs) stays out
unless `includeOfftopic` is true.

The `score` resource carries `reviewScore` (Steam's 0 to 9 bucket),
`reviewScoreDesc` (such as `Very Positive`), `totalPositive`, `totalNegative`,
`totalReviews` and `positiveShare`, the positive fraction, or `null` when there
are no reviews.

The `recent` resource carries `since` and `until` (Unix seconds), `count`,
`positive`, `negative`, `positiveShare` (`null` when the window holds no
reviews), `byLanguage` (positive and negative counts per language code), and the
reviews themselves. Paging passes the window to Steam as `date_range_start` and
`date_range_end` and also stops at the first review older than `since`.
`stopReason` says why paging ended: `window` (a review older than the window),
`empty` (Steam returned no more), `cursorRepeat` (Steam returned a cursor
already used, or none), or `pageLimit`. Only `pageLimit` sets `truncated: true`:
the counts then cover the newest `perPage × maxPages` reviews of the window, not
all of it.

A 429 answer fails the method with the status and, when Steam sends one, the
Retry-After seconds, and a request longer than 15 seconds is abandoned.
Anonymous answers may be cached by Steam for up to ten minutes.

A workflow can fail when the reviews after a patch turn negative. An empty
window passes, since there is nothing to judge:

```yaml
- name: positive-enough
  task:
    type: assert
    expr: |-
      int(data.latest("my-game", "recent").attributes.count) == 0 ||
      double(data.latest("my-game", "recent").attributes.positiveShare)
      >= double(inputs.minPositiveShare)
    message: The recent reviews fell below the positive share allowed
    severity: high
```

## The trend: `sample` and `summarise`

```sh
# Record the current score and counts. Run it by hand or on a schedule.
swamp behavior run tf2-reviews sample

# Summarise everything recorded, or only what was recorded since a time.
swamp behavior run tf2-reviews summarise
swamp behavior run tf2-reviews summarise --input since=2026-10-01T00:00:00Z
```

Each `sample` run adds a version to the same record, so the history is the
record's versions, kept for 365 days. A sample record looks like this:

```json
{
  "appId": 440,
  "reviewScore": 8,
  "reviewScoreDesc": "Very Positive",
  "totalPositive": 1143070,
  "totalNegative": 112091,
  "totalReviews": 1255161,
  "positiveRatio": 0.9106959186909089,
  "sampledAt": "2026-10-22T12:00:00.000Z"
}
```

`positiveRatio` is positive reviews over positive and negative reviews, from 0
to 1, and null when the app has no reviews. The counts are Steam's for every
language and purchase type (`language=all&purchase_type=all`), so they differ
from `summary`'s default of Steam purchasers only.

The summary record holds `samples`, `since`, the `first` and `latest` samples,
the samples with the lowest (`min`) and highest (`max`) positive ratio, and
`change`, the latest minus the first:

```json
{
  "appId": 440,
  "samples": 30,
  "since": null,
  "first": { "positiveRatio": 0.9102, "totalReviews": 1250040, "...": "..." },
  "latest": { "positiveRatio": 0.9107, "totalReviews": 1255161, "...": "..." },
  "min": { "positiveRatio": 0.9101, "totalReviews": 1251202, "...": "..." },
  "max": { "positiveRatio": 0.9107, "totalReviews": 1255161, "...": "..." },
  "change": {
    "positiveRatio": 0.0005,
    "reviewScore": 0,
    "totalPositive": 4790,
    "totalNegative": 331,
    "totalReviews": 5121
  },
  "summarisedAt": "2026-10-22T12:00:05.000Z"
}
```

`since` is a UTC ISO-8601 time ending in `Z`. On a tie the earliest sample is
the minimum or maximum. Samples without reviews are left out of `min` and `max`,
which are null when no sample has reviews, and `change.positiveRatio` is null
when the first or latest sample has none. A workflow reads it with
`data.latest("tf2-reviews", "summary-440")`.

`sample` writes nothing when Steam does not answer with a review summary, and
says why: a response whose `success` is not 1, HTTP 429 (with `Retry-After` when
Steam sends one), HTTP 500 and above as a transient failure, a body without a
complete `query_summary`, or a request longer than 15 seconds. `summarise` fails
when no sample of the app has been recorded (in the `since` window, when one is
given), and skips, with a warning, any stored record that is not a sample of the
instance's app.

Review counts move slowly beside player counts. Once a day shows a trend across
weeks; once an hour shows the response to a launch or an update while it
happens. For the shape of the curve, query the samples and sort by time:

```sh
swamp data query 'modelName == "tf2-reviews" && name == "app-440" && version >= 0' \
  --select '{"at": attributes.sampledAt, "ratio": attributes.positiveRatio, "reviews": attributes.totalReviews}'
```

## Privacy

Reviews are data about players: Steam returns each review's author SteamID,
playtime and last-played time, and the text they wrote. By default a `recent`
resource keeps only each review's id, whether it was positive, when it was
created and its language, plus counts. `keepAuthor: true` adds the author's
SteamID and playtime at review; `keepText: true` adds the text, cut to 2000
characters. `sample` asks for no review bodies (`num_per_page=0`), so no
reviewer or review text is requested, received or stored. Swamp keeps what a
method writes as versioned records on the machine that ran it: `recent` declares
a 30-day lifetime and keeps 10 versions, `score` keeps 90 versions, `sample`
versions expire after 365 days and `summary` keeps 10. Turn either option on
only when you need it and know where those records go.

## Changes

- 2026.10.30.1: one extension again. Up to 2026.10.21.1 it offered `summary` and
  `recent`; 2026.10.22.1 and 2026.10.22.2 replaced them with `sample` and
  `summarise`. This version carries all four, and its upgrade leaves an instance
  made on either line as written. `summary` now writes the `score` resource,
  since `summary` holds what `summarise` writes. `summary` and `recent` abandon
  a request after 15 seconds, as `sample` does. Moved to
  <https://github.com/reset/swamp-extensions>, now its published home.
- 2026.10.22.2: the registry now shows every argument's description, which it
  showed empty before; `summarise`'s `since` argument, missing from the
  registry's list before, is listed.
- 2026.10.22.1: `sample` and `summarise`.
- 2026.10.21.1: `summary` and `recent`.

## License

MIT, see LICENSE.
