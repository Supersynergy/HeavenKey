ARG BASE_IMAGE
FROM ${BASE_IMAGE} AS python
FROM scratch
COPY --from=python / /
COPY --chmod=0555 heavenkey /usr/local/bin/heavenkey
ENV HOME=/tmp PATH=/usr/local/bin:/usr/bin:/bin
USER 65532:65532
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/heavenkey"]
