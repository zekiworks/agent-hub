# The clean machine for tests/smoke/install-sh.sh: Ubuntu with what install.sh asks for (git, curl, unzip) and no Bun,
# a user `maya`, and systemd (PID 1 only in the systemd mode; otherwise it is just installed and not running).
# python3-minimal only serves as a decoy process the Hub-process checks must not take for a Hub.
FROM ubuntu:26.04
RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates unzip procps systemd systemd-sysv dbus dbus-user-session python3-minimal \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -s /bin/bash maya
ENV LANG=C.UTF-8
