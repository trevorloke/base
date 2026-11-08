# base

**Base**, the broad application for social engagement, is a suite of three
apps for a campaign or cause, served at [base.win](https://base.win). Each
client gets its own copy of every app, with its own servers, databases and
subdomain (`<client>.base.win`).

| App | Folder | For |
|---|---|---|
| **Base Ground** (field and ground) | [`apps/ground`](apps/ground) | organizing: volunteers in the field app (`<client>.base.win/field`), staff at the desk (`<client>.base.win/ground`) |
| **Base Web** | [`apps/web`](apps/web) | the client's public website and its back office, on the client's own domain |
| **Base Air** | [`apps/air`](apps/air) | attention and social: listen, forecast, post inside red lines (`<client>.base.win/air`) |
| front door | [`apps/gateway`](apps/gateway) | base.win itself: sends `<client>.base.win` to that client's apps |

How they fit together (addresses, signing in once, settings, brand) is in
[SUITE.md](SUITE.md). Each app's own README covers running it, testing it and
going live.

`main` deploys every app's staging (`<client>.staging.base.win`). The `production`
branch deploys production and moves only through **Actions → Promote to
production**. Render's services are defined in [`render.yaml`](render.yaml).
