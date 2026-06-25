FROM alpine:3.20

ARG APICTL_VERSION=4.7.0

RUN apk add --no-cache \
    ca-certificates \
    curl \
    bash \
    jq \
    tar \
    gzip \
    nodejs \
    npm

# Download the APICTL binary that matches the container CPU architecture.
# This avoids forcing linux/amd64 for the APICTL runner on Apple Silicon.
RUN set -eux; \
    case "$(uname -m)" in \
      x86_64) asset_arch="amd64" ;; \
      aarch64|arm64) asset_arch="arm64" ;; \
      *) echo "Unsupported architecture: $(uname -m)"; exit 1 ;; \
    esac; \
    curl -fL "https://github.com/wso2/product-apim-tooling/releases/download/v${APICTL_VERSION}/apictl-${APICTL_VERSION}-linux-${asset_arch}.tar.gz" -o /tmp/apictl.tar.gz; \
    mkdir -p /tmp/apictl; \
    tar -xzf /tmp/apictl.tar.gz -C /tmp/apictl; \
    find /tmp/apictl -type f -name apictl -exec cp {} /usr/local/bin/apictl \;; \
    chmod +x /usr/local/bin/apictl; \
    apictl version; \
    rm -rf /tmp/apictl /tmp/apictl.tar.gz

WORKDIR /workspace

COPY package*.json /workspace/

RUN npm install

ENTRYPOINT ["/bin/bash", "-lc"]

CMD ["apictl version && tail -f /dev/null"]