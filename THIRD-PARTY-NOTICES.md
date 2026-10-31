# Third-party notices

The source code in this repository is MIT licensed (see `LICENSE`). The **built
installer and portable executable bundle third-party programs** which keep their
own licences. If you redistribute a build, keep this file with it.

| Component | Version source | Licence | Where to get it |
|---|---|---|---|
| **yt-dlp** (`yt-dlp.exe`) | latest GitHub release at build time | The Unlicense (public domain) | https://github.com/yt-dlp/yt-dlp |
| **FFmpeg / ffprobe** (`ffmpeg.exe`, `ffprobe.exe`) | gyan.dev "essentials" build | **GPL v3** (that build is compiled with GPL components) | https://www.gyan.dev/ffmpeg/builds/ — source: https://ffmpeg.org/download.html |
| **Deno** (`deno.exe`) | latest GitHub release | MIT | https://github.com/denoland/deno |
| **Electron** (the app shell) | see `package.json` | MIT | https://github.com/electron/electron |
| **Chromium** (inside Electron) | shipped with Electron | BSD-style + third-party licences | https://www.chromium.org/ |

## Why this matters

The app does not link against these programs — it runs them as separate
executables. That keeps the MIT licence valid for the app's own code. However,
**FFmpeg's GPL build** is distributed as a binary inside the installer, so a
redistribution must also:

1. include this notice and FFmpeg's licence text, and
2. make the corresponding FFmpeg source available (the link above satisfies
   that; FFmpeg's own "how to comply with the GPL" page is at
   https://ffmpeg.org/legal.html).

Nothing in this repository contains the binaries — `bin/` is gitignored and is
populated by `npm run fetch-engines`, which downloads them from the projects
above at build time. Whoever builds the installer is the one distributing them.
