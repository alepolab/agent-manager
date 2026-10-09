# pwmig/stackctl: the only pwmig container with the docker socket. Fixed actions for compose project
# pwmig only (see stackctl/stackctl.py). Build context: deploy/robot-migration.
FROM alpine:3.20
LABEL pwmig=1
RUN apk add --no-cache docker-cli docker-cli-compose python3 curl bash
COPY stackctl/stackctl.py /opt/stackctl.py
EXPOSE 7070
CMD ["python3", "/opt/stackctl.py"]
