#!/bin/sh
# Vercel's Ignored Build Step for the remote dashboard (vercel.json
# `ignoreCommand`). Exit 0 skips the build, non-zero builds.
#
# It lives in a file because Vercel refuses an ignoreCommand longer than 256
# characters (`projectSettings.commandForIgnoringBuildStep`), and the list of
# paths the shell and the function are built from outgrew that. The loops
# commit their journals to main many times a day, and Hobby allows 100
# deployments a day, so a commit that touches none of these paths skips.
# `vercel-config.test.ts` reads the list below and holds it to every file
# the build and the Vite shell bundle.
exec git diff --quiet HEAD^ HEAD -- \
  dashboard/ui \
  dashboard/command-requests.ts \
  dashboard/contracts.ts \
  dashboard/overview.ts \
  dashboard/routes.ts \
  dashboard/route-table.ts \
  dashboard/remote \
  dashboard/build.ts \
  dashboard/vite-config.ts \
  lineup/contracts.ts \
  tsconfig.json \
  vercel.json \
  api \
  package.json \
  bun.lock
