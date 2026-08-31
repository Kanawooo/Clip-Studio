# Third-party notices

Clip Studio includes source files from open-source projects and installs
additional runtime components into `.runtime/`. Those projects remain subject
to their own licenses.

## Vendored skill sources

| Component | Source/version | License |
| --- | --- | --- |
| ClipSkills | `appergb/ClipSkills` commit `4d85c26f57111c9b0df894981cfef44d1d6bdb6b` | MIT; see [the vendored license](.pi/skills/clip-skills/LICENSE.txt) |
| HyperFrames skills | `heygen-com/hyperframes` commit `f0e637375f2c43b22192f1ad8c3aef1b5d010e8a` | Apache-2.0; see [license](.pi/skills/hyperframes/LICENSE.txt) and [credits](.pi/skills/hyperframes/CREDITS.md) |

The `talking-head-recut` skill contains adapted MIT-licensed material and keeps
its attribution in `.pi/skills/hyperframes/talking-head-recut/NOTICE.md`.

## npm runtime dependencies

| Component | Pinned version | License/source |
| --- | --- | --- |
| `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` | 0.84.4 | MIT, https://github.com/earendil-works/pi |
| `hyperframes` | 0.8.4 | Apache-2.0, https://github.com/heygen-com/hyperframes |
| `@modelcontextprotocol/sdk` | 1.30.0 | MIT, package `LICENSE` |

The npm lockfiles contain the complete dependency graph. Installed packages
retain their own license and notice files.

## Project-local downloaded runtimes

The installer downloads these components from their upstream release channels;
their binaries are not committed to this repository.

| Component | Installed version | License/source |
| --- | --- | --- |
| Node.js | 22.23.2 | Node.js license and bundled third-party notices, https://github.com/nodejs/node |
| FFmpeg and FFprobe | 8.1.2-50-g1a748fe2cd GPL shared build | GPL-compatible build with GPL dependencies, including libx264/libx265; FFmpeg license details: https://ffmpeg.org/legal.html; build source: https://github.com/BtbN/FFmpeg-Builds |
| PortableGit / Git for Windows | 2.55.0.5 | Git GPL-2.0 and component-specific licenses, https://gitforwindows.org/ |
| uv / uvx | 0.12.5 | MIT OR Apache-2.0, https://github.com/astral-sh/uv |
| CPython runtime | 3.12.12 | Python Software Foundation License, https://www.python.org/psf/license/ |
| whisper.cpp | b4938 | MIT, https://github.com/ggml-org/whisper.cpp |
| Chrome Headless Shell for Testing | 152.0.7928.2 | Google Chrome and bundled open-source component terms, https://googlechromelabs.github.io/chrome-for-testing/ |

The Python dependency lockfile records the exact media-analysis packages and
hashes installed by uv. Each installed distribution carries its own metadata
and license files.
