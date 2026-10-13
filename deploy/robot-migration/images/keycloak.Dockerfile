# pwmig/keycloak: Keycloak 26.0 + the EL9 libfaketime, preloaded only while the clock is on (KC_LD_PRELOAD).
# The app's copy of libfaketime needs GLIBC 2.38 and does not load on Keycloak's RHEL 9 base.
FROM rockylinux:9 AS faketime
RUN dnf -y install epel-release && dnf -y install libfaketime && dnf clean all
FROM quay.io/keycloak/keycloak:26.0
LABEL pwmig=1
COPY --from=faketime /usr/lib64/libfaketime.so.1 /opt/faketime/libfaketime.so.1
# The pwmig_keycloak-data volume mounts here. The base image has no such folder, so docker created the
# volume root as root and Keycloak (uid 1000) could not write its H2 file. A folder owned by 1000 in the
# image is copied, with its owner, into the empty volume on first mount.
USER root
RUN mkdir -p /opt/keycloak/data/h2 && chown 1000:0 /opt/keycloak/data/h2
USER 1000
# Optimized start: Keycloak's build step (Quarkus augmentation) runs once here instead of on every start,
# as `start-dev` did. Under libfaketime that per-start build is what took ~9 minutes and ~3 CPUs on each
# clock move. dev-file is the same H2 store under data/h2 that start-dev used, so the volume carries over.
RUN /opt/keycloak/bin/kc.sh build --db=dev-file
