# Skill Sources

Every skill in this repository is vendored from its official source and committed
into this Git repository. The backend never loads skills from the user home
directory, other projects, or a global Pi installation.

## ClipSkills

- Repository: https://github.com/appergb/ClipSkills
- Commit SHA: 4d85c26f57111c9b0df894981cfef44d1d6bdb6b
- Vendored directory: `clip-skills/`
- Local path: `.pi/skills/clip-skills/`
- Note: only the official `clip-skills/` directory of the repository is vendored.

## HyperFrames

- Repository: https://github.com/heygen-com/hyperframes
- Commit SHA: f0e637375f2c43b22192f1ad8c3aef1b5d010e8a
- Vendored directory: `skills/`
- Local path: `.pi/skills/hyperframes/`
- Note: only the official `skills/` directory of the repository is vendored.
  HyperFrames ships multiple domain/workflow/CLI skills; all of them belong to
  this single HyperFrames skill source.

## Distribution changes

- Official directory structure and runtime skill content are preserved.
- HyperFrames `LICENSE.txt` and `CREDITS.md` record the upstream license and
  source commit.
- The embedded HyperFrames media-use telemetry key is removed. Telemetry is
  disabled unless `HYPERFRAMES_POSTHOG_API_KEY` is explicitly supplied.
- Public source distributions omit upstream test files and test corpora.
- Both sources are checked into Git (`package-lock.json` is committed too).
