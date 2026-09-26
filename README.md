# Engage Coaching Tracker (Tampermonkey userscript)

Runs on the QuickSight Elevate dashboard. It scrapes the coaching list, shows
only associates currently on site (via Find People), and syncs completions and
"in progress" claims across leaders through Firebase.

## Install (one time)

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. **If you have an older copy** of Engage Coaching Tracker in Tampermonkey
   (e.g. v41.45), delete it first. Old copies can't update themselves.
3. Click the install link and press **Install**:

   **https://raw.githubusercontent.com/gabrerut/engage-coaching-tracker/main/engage-coaching-tracker.user.js**

   If you just see a page of code, Tampermonkey isn't installed yet.

After that, updates arrive automatically.

## Using it

- Open the Find People page once so your site ID is captured (UNJ2 is built in).
- Keep one QuickSight coaching tab open so the list stays fresh for everyone.
- Set your login in the panel so completions are credited to you.

## Publishing an update (maintainer)

Edit `engage-coaching-tracker.user.js`, commit, and push to `main`. The
`bump-version.yml` workflow bumps `@version` (41 → 42 → 43 …) and commits it
back, and Tampermonkey pulls the new version on its next update check.
To land an exact version, include `[skip ci]` in your commit message.

Auto-update requires browsers to reach `raw.githubusercontent.com`.
