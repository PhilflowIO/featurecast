# The system half of a recording on a GPU host: the libraries Chromium links
# against, ffmpeg for the render stage, and pnpm. Nothing featurecast-specific
# lives in the image. Dependencies and the pinned browser are installed into
# the mounted checkout at run time from the lockfile (see record.sh), so the
# image does not go stale when Playwright or the browser pin moves.
#
# The Playwright base image is used for its system libraries only; its own
# browsers are not the pinned ones and are never used.
FROM mcr.microsoft.com/playwright:v1.63.0-noble
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
