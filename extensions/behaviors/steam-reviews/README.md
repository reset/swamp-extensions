# @reset/steam-reviews

A Swamp behavior for a Steam app's public user reviews. It reads them through
Steamworks' documented Web API method
[`IUserReviewsService/GetAppReviews`](https://partner.steamgames.com/doc/webapi/IUserReviewsService),
which replaces `store.steampowered.com/appreviews/<appid>?json=1`. `summary`
keeps the app's review score and totals; `recent` pages through the reviews
created in a window, newest first, and counts positive and negative reviews
overall and by language. Each method writes what it read as a versioned
resource, so a workflow can fail when the reviews after a patch turn negative,
and a report can chart the score over time.

It needs nothing beyond Swamp and an app id: reviews are public, and the method
needs no key. A Steamworks Web API publisher key associated with the app raises
the rate limit and is optional.

## Install

```sh
swamp extension pull @reset/steam-reviews
```

## Set up a behavior instance

One instance per app, with your app's id in place of 480:

```sh
swamp behavior create @reset/steam-reviews my-game --global-arg appId=480
```

480 is Spacewar, Valve's test app. It has no store page, so Steam answers its
review query with an empty response: `recent` writes an empty window and
`summary` fails saying so. Any app with a store page answers with its score.

To use a publisher key, put it in a vault, never in a YAML file, and reference
it by name. `swamp vault put` reads the value from stdin or a hidden prompt:

```sh
pbpaste | swamp vault put default steam-web-api-key
swamp behavior create @reset/steam-reviews my-game --global-arg appId=480 \
  --global-arg 'key=${{ vault.get(default, steam-web-api-key) }}'
```

Global arguments:

| Argument | Default  | Meaning                                                                              |
| -------- | -------- | ------------------------------------------------------------------------------------ |
| `appId`  | required | The Steam app id whose reviews are read.                                             |
| `key`    | none     | Steamworks Web API publisher key for the app, sensitive. Only raises the rate limit. |

## Methods

```sh
swamp behavior run my-game summary
swamp behavior run my-game recent --input days=3
swamp behavior run my-game recent --input since=1792000000 --input 'languages:json=["english","german"]'
```

| Method    | Arguments                                                                                                                       | Writes    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `summary` | `languages` (`["all"]`), `purchaseType` (`steam`), `includeOfftopic` (false)                                                    | `summary` |
| `recent`  | the same, plus `since` or `days` (7), `until` (now), `perPage` (100), `maxPages` (10), `keepAuthor` (false), `keepText` (false) | `recent`  |

Both call
`GET https://api.steampowered.com/IUserReviewsService/GetAppReviews/v1/` with
`input_json`, `review_type` all, and `filter` Recent. `purchaseType` is `steam`
(Steam purchasers only, the default and what the store's score counts), `all`,
or `nonSteam`. Off-topic activity Steam filtered out (review bombs) stays out
unless `includeOfftopic` is true.

The `summary` resource carries `reviewScore` (Steam's 0 to 9 bucket),
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
Retry-After seconds. Anonymous answers may be cached by Steam for up to ten
minutes.

## A workflow that uses it

`workflow-steam-reviews-watch.yaml` in this repository reads the summary and the
last few days of reviews, then fails when the window's positive share falls
below a threshold. An empty window passes, since there is nothing to judge:

```yaml
- name: positive-enough
  task:
    type: assert
    expr: |-
      int(data.latest("steam-reviews", "recent").attributes.count) == 0 ||
      double(data.latest("steam-reviews", "recent").attributes.positiveShare)
      >= double(inputs.minPositiveShare)
    message: The recent reviews fell below the positive share allowed
    severity: high
```

## Privacy

Reviews are data about players: Steam returns each review's author SteamID,
playtime and last-played time, and the text they wrote. By default a `recent`
resource keeps only each review's id, whether it was positive, when it was
created and its language, plus counts. `keepAuthor: true` adds the author's
SteamID and playtime at review; `keepText: true` adds the text, cut to 2000
characters. Swamp keeps what a method writes as versioned records on the machine
that ran it; `recent` declares a 30-day lifetime and keeps 10 versions. Turn
either option on only when you need it and know where those records go.

## License

MIT. See [LICENSE](LICENSE).
