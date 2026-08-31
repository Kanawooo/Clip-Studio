# HyperFrames source attribution

This directory is vendored from the `skills/` directory of HyperFrames:

- Repository: https://github.com/heygen-com/hyperframes
- Source commit: `f0e637375f2c43b22192f1ad8c3aef1b5d010e8a`
- Copyright: 2026 HeyGen, Inc.
- License: Apache License 2.0; see [LICENSE.txt](LICENSE.txt)

Notices included in individual upstream skills remain in their original
locations. In particular, `talking-head-recut/NOTICE.md` retains the upstream
attribution for adapted MIT-licensed material.

Clip Studio removes the upstream embedded PostHog project key from
`media-use/scripts/lib/telemetry.mjs`. Telemetry is disabled by default and can
only be enabled by explicitly supplying `HYPERFRAMES_POSTHOG_API_KEY`.
