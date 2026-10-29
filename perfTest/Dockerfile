FROM ubuntu:latest

ENV DEBIAN_FRONTEND=noninteractive

# build-essential + python3 are required to compile the optional unix-dgram
# dependency. Without it the UDS tests degrade and the harness under-reports.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl gnupg build-essential python3 strace \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN chmod +x /app/perfTest/run.sh

ENV MODE=test

ENTRYPOINT ["/app/perfTest/run.sh"]
