# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:26.13.1-alpine3.24
ARG JAVA_IMAGE=eclipse-temurin:25-jre-alpine-3.24

# Install production Node dependencies.
FROM ${NODE_IMAGE} AS node-deps

WORKDIR /app

RUN apk add --no-cache git

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --no-audit --no-fund



# Keep only Minecraft Java 26.1 data and its shared dependencies.
RUN set -eux; \
    data=/app/node_modules/minecraft-data/minecraft-data/data; \
    for dir in "$data"/bedrock/*; do \
        [ -d "$dir" ] || continue; \
        case "${dir##*/}" in \
            common) ;; \
            *) rm -rf "$dir" ;; \
        esac; \
    done; \
    for dir in "$data"/pc/*; do \
        [ -d "$dir" ] || continue; \
        case "${dir##*/}" in \
            common|26.1|1.20|1.20.2|1.16.1|latest) ;; \
            *) rm -rf "$dir" ;; \
        esac; \
    done



# Download and verify the exact ViaProxy release.
FROM alpine:3.24 AS viaproxy-download

RUN apk add --no-cache ca-certificates wget

RUN wget -q -O /ViaProxy-3.4.14.jar \
    https://github.com/ViaVersion/ViaProxy/releases/download/v3.4.14/ViaProxy-3.4.14.jar \
    && echo "2894bbfb2f4342f8fde887af6c689313efd5b0e46a8006775eea0e21e2948ab5  /ViaProxy-3.4.14.jar" \
    | sha256sum -c -


# Lightweight runtime.
FROM ${JAVA_IMAGE} AS runtime

RUN apk add --no-cache libstdc++ libgcc libatomic \
    && addgroup -S -g 10001 minebot \
    && adduser -S -D -H -u 10001 -G minebot minebot

ENV JAVA_HOME=/opt/java/openjdk
ENV PATH="/opt/java/openjdk/bin:/usr/local/bin:${PATH}"
ENV NODE_ENV=production
ENV MINEBOT_HTTP_HOST=0.0.0.0
ENV MINEBOT_HTTP_PORT=3000
ENV VIAPROXY_JAR=/app/tools/viaproxy/ViaProxy-3.4.14.jar

WORKDIR /app

COPY --from=node-deps /usr/local/bin/node /usr/local/bin/node

COPY --from=node-deps --chown=10001:10001 \
    /app/node_modules ./node_modules

COPY --from=viaproxy-download --chown=10001:10001 \
    /ViaProxy-3.4.14.jar ./tools/viaproxy/ViaProxy-3.4.14.jar

COPY --chown=10001:10001 src ./src
COPY --chown=10001:10001 public ./public

USER 10001:10001

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=60s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "src/index.js"]
