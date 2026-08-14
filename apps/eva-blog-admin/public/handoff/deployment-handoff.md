# Eva Blog Private Author API Handoff

Deploy this app separately from the public reader and keep its host private.
The status publisher is a separate local app on the author's device.

Protected writes:

- `POST /api/articles`
- `POST /api/articles/:id/publish`
- `POST /api/status`
- `POST /api/status/auto` (scoped background-agent token, always private)
- `POST /api/status/daemon-token` (author session only; issues the scoped CLI token)
- `POST /api/summaries/activity`
- authenticated comment creation

GitHub OAuth creates a signed HTTP-only `eva_session` cookie. Article and
status writes additionally require the GitHub login to be listed in
`AUTHOR_GITHUB_LOGINS`. There is no mock session route.
