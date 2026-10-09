# pwmig/keycloak: Keycloak 26.0 + the EL9 libfaketime, preloaded only while the clock is on (KC_LD_PRELOAD).
# The app's copy of libfaketime needs GLIBC 2.38 and does not load on Keycloak's RHEL 9 base.
FROM rockylinux:9 AS faketime
RUN dnf -y install epel-release && dnf -y install libfaketime && dnf clean all
FROM quay.io/keycloak/keycloak:26.0
LABEL pwmig=1
COPY --from=faketime /usr/lib64/libfaketime.so.1 /opt/faketime/libfaketime.so.1
