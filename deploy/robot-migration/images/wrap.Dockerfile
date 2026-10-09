# pwmig/<name>: an external image under our own tag. Built (not pulled) so the host's image tags never move:
# BuildKit fetches the base without tagging it in the host's image store.
ARG BASE
FROM ${BASE}
LABEL pwmig=1
