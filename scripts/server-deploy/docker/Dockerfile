# Siyue API and mail worker runtime image.
#
# The build context is the release bundle produced by scripts/server-deploy/build-artifact.sh, whose
# app/ directory already holds the compiled server and its production dependencies. Nothing is
# compiled here: the image build needs no toolchain, no network and very little RAM, which matters on
# the 1.6 GB deployment host.
#
# The native modules in the bundle are npm-shipped N-API prebuilds (argon2 ships linux-x64 glibc and
# musl variants), so a bundle built on another platform still runs here. verify-artifact.sh checks that
# no compiled, host-specific binary is present.
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}
ARG SIYUE_RELEASE=unknown
LABEL org.opencontainers.image.title="siyue-server" \
      org.opencontainers.image.description="Siyue account API and mail worker" \
      org.opencontainers.image.revision="${SIYUE_RELEASE}"
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node app/ /app/
USER node
EXPOSE 8787
CMD ["node", "dist/index.js"]
