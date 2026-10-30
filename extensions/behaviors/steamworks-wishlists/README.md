# @reset/steamworks-wishlists

Record a Steam app's daily wishlist activity (adds, deletes, purchases from a
wishlist, gifts, and adds by platform) from Valve's documented Steamworks
partner Web API, and summarise it. Every `sample` is a new version of the app's
record for a range of dates; `summarise` turns the history into totals, the
trend of daily adds, and the best and worst days.

| Method      | What it does                                                                         | Writes                         |
| ----------- | ------------------------------------------------------------------------------------ | ------------------------------ |
| `sample`    | Reads each date in a range, one request per date, and records the day's activity     | `wishlists`, `wishlists-<app>` |
| `summarise` | Reads every recorded version back and records totals, trend, and best and worst days | `summary`, `summary-<app>`     |

Versions of `wishlists` are kept for 730 days, `summary` keeps its last 10.

## Endpoint

One documented method is called, on Valve's partner host only:
[`GET https://partner.steam-api.com/IPartnerFinancialsService/GetAppWishlistReporting/v001/`](https://partner.steamgames.com/doc/webapi/IPartnerFinancialsService),
with `appid` and `date` (YYYY-MM-DD, "GMT bounded" in Valve's words). It answers
with a `wishlist_summary` of `wishlist_adds`, `wishlist_deletes`,
`wishlist_purchases`, `wishlist_gifts` and `wishlist_adds_windows`, `_mac` and
`_linux`, which are recorded, and by-country and by-language breakdowns, which
are not. For a date outside the app's available range the answer is empty
except for `app_min_date`; such dates are recorded in `emptyDates`.

Valve's API reports activity per day. It has no field for the running total of
outstanding wishlists, so this extension records none and does not compute one.

The documentation this was built from, verified on 2026-10-22:

- [IPartnerFinancialsService](https://partner.steamgames.com/doc/webapi/IPartnerFinancialsService):
  the method, its parameters and its answer, the Financial API Group key, and
  the advice on which dates to query.
- [Authentication using Web API Keys](https://partner.steamgames.com/doc/webapi_overview/auth):
  publisher keys, and the `x-webapi-key` request header as an alternative to
  the `key` parameter.
- [Web API Overview](https://partner.steamgames.com/doc/webapi_overview): the
  partner host, IP allow lists, and the strict rate limits Valve applies to an
  address after 403 answers.
- [Wishlist Reporting](https://partner.steamgames.com/doc/marketing/wishlist/reporting):
  the same data in the Steamworks reporting site.

It has been tested only against fixtures built from those documented shapes. It
has not been run against Valve's API.

## The key

`GetAppWishlistReporting` needs a publisher Web API key with Financial
permissions. Valve issues it to a Financial API Group, created on the Manage
Groups page of Steamworks; the key reads financial data for every app on the
partner account, so treat it like a password. Valve recommends adding an IP
allow list to the key under "Manage WebAPI Key" on the group's page; with one,
requests from any other address are refused with HTTP 403.

Put the key in a vault. `swamp vault put` reads the value from stdin or a
hidden prompt, so it never reaches your shell history:

```sh
pbpaste | swamp vault put default steamworks-financial-key

swamp extension pull @reset/steamworks-wishlists

# One behavior instance per app.
swamp behavior create @reset/steamworks-wishlists my-game-wishlists \
  --global-arg appId=440 \
  --global-arg 'apiKey=${{ vault.get(default, steamworks-financial-key) }}'
```

The key is a sensitive global argument, so swamp refuses a literal. It is sent
only in the `x-webapi-key` header Valve documents, and only to
`https://partner.steam-api.com`; redirects are refused, so it cannot follow one
to another host. It is never part of a URL, never written to a record and never
logged, and it is removed from any error text before that text is reported.

## Sample

```sh
# Yesterday and today in GMT, the two dates Valve suggests querying each day.
swamp behavior run my-game-wishlists sample

# A backfill, at most 92 dates per run.
swamp behavior run my-game-wishlists sample \
  --input from=2026-09-01 --input to=2026-09-30
```

`to` defaults to today and may not be later; `from` defaults to the day before
`to`. Each date is one request, sent one at a time, and the run stops at the
first failure. A record looks like this:

```json
{
  "appId": 440,
  "from": "2026-10-21",
  "to": "2026-10-22",
  "fetchedAt": "2026-10-22T12:00:00.000Z",
  "appMinDate": "2010-01-01",
  "days": [
    {
      "date": "2026-10-21",
      "adds": 30,
      "deletes": 15,
      "purchases": 10,
      "gifts": 5,
      "addsWindows": 22,
      "addsMac": 3,
      "addsLinux": 5
    },
    {
      "date": "2026-10-22",
      "adds": 12,
      "deletes": 4,
      "purchases": 2,
      "gifts": 0,
      "addsWindows": 10,
      "addsMac": 1,
      "addsLinux": 1
    }
  ],
  "emptyDates": []
}
```

A count Valve leaves out of `wishlist_summary` is recorded as 0, the default of
its protobuf `uint32` type. An answer that names a different `appid` is
refused.

## Summarise

```sh
swamp behavior run my-game-wishlists summarise
swamp behavior run my-game-wishlists summarise \
  --input from=2026-10-01 --input to=2026-10-22
```

Every recorded version is read, and each date takes its row from the version
read most recently, since a day read while it was still open may have grown.
`from` and `to`, when given, bound the dates that count. The summary holds the
number of versions and dates read, the first and last date, each count added up,
the average daily adds, the trend, and the best and worst days by adds (the
earliest date on a tie):

```json
{
  "appId": 440,
  "from": null,
  "to": null,
  "samples": 30,
  "days": 4,
  "firstDate": "2026-10-01",
  "lastDate": "2026-10-04",
  "totals": {
    "adds": 22,
    "deletes": 4,
    "purchases": 8,
    "gifts": 0,
    "addsWindows": 22,
    "addsMac": 0,
    "addsLinux": 0
  },
  "averageAdds": 5.5,
  "trend": {
    "direction": "rising",
    "earlierAverageAdds": 4,
    "laterAverageAdds": 7,
    "addsPerDayChange": 1
  },
  "bestDay": { "date": "2026-10-03", "adds": 10, "...": "the day's row" },
  "worstDay": { "date": "2026-10-01", "adds": 2, "...": "the day's row" },
  "summarisedAt": "2026-10-22T12:00:05.000Z"
}
```

`trend` compares the average daily adds of the earlier and later halves of the
dates (the middle date is left out of both when there is an odd number), and
`addsPerDayChange` is the least-squares slope of daily adds against the date.
It is null with fewer than two dates. A workflow reads either record with
`data.latest("my-game-wishlists", "summary-440")`.

## Rate limits and when to sample

Valve publishes no request quota for this method. What it documents is that
requests answered with HTTP 403, as happens with a key that lacks Financial
permissions or from an address outside the key's allow list, bring strict rate
limits on the calling address. So requests go one at a time, a 403 stops the
run at once with an explanation and nothing is retried, and one run is capped
at 92 dates.

Valve also documents that wishlist data is refreshed at least once a day and
that a closed date does not change, so it suggests querying yesterday and today
each day and not querying older dates again. The default range does exactly
that; sample once a day.

## Errors

`sample` writes nothing when any date fails, and says why:

- HTTP 403 is reported as a refused key: not a publisher key with Financial
  permissions, or an address outside its allow list. Fix the key before trying
  again.
- HTTP 429 is reported with `Retry-After` when Valve sends it.
- HTTP 500 and above is reported as a transient failure to retry later.
- HTTP 400, 401 and 404 are reported with the status and the start of the body.
- A body that is not JSON, or not the documented answer, is reported with its
  status.
- A request that takes longer than 15 seconds is abandoned.
- A range that runs backwards, ends after today, names a date that does not
  exist, or spans more than 92 dates fails before any request.

`summarise` fails when nothing has been recorded (or nothing between `from` and
`to`), and skips, with a warning, any stored record that is not a sample of the
instance's app.

## What is stored

Each version holds the app id, the dates requested, when they were read, the
app's earliest date with data, and each date's seven counts. The counts are
totals Valve reports for the app; no data about the people who wishlisted is
requested, received or stored. The by-country and by-language breakdowns are in
Valve's answer and are not recorded.

## Removing an instance

`swamp behavior delete my-game-wishlists --yes` removes the instance. Its
records are versions in the repository's data store and expire with their
retention. Remove the key with
`swamp vault delete default steamworks-financial-key`, and change it on the
Financial API Group's page if it may have been exposed.

## Changes

- 2026.10.30.1: moved to <https://github.com/reset/swamp-extensions>, now its published home, with an upgrade that leaves existing instances' arguments as they are. Behavior unchanged.
- 2026.10.23.1: first release, `sample` and `summarise`.

## License

MIT, see LICENSE.
