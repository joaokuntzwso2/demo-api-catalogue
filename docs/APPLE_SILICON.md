# Apple Silicon / ARM64 note

Some WSO2 product container images are published primarily for `linux/amd64`.
On Apple Silicon Macs, the platform demo forces WSO2 API Manager, WSO2 Integrator/Micro Integrator and the APICTL runner to run as `linux/amd64` through Docker emulation.

If Docker Desktop asks to enable Rosetta or amd64 emulation, enable it.

Run:

```bash
docker-compose --profile platform up --build
```

If you still see a manifest error, clean the failed build and retry:

```bash
docker-compose --profile platform down -v --remove-orphans
docker builder prune -f
docker-compose --profile platform build --no-cache wso2-integrator apictl
docker-compose --profile platform up --build
```


## Apple Silicon build notes

The platform demo intentionally runs WSO2 API Manager and WSO2 Micro Integrator as `linux/amd64`, because those product Docker images may not publish native ARM64 manifests for every release tag. The APICTL runner, however, is built natively using Alpine and downloads the matching `linux-arm64` or `linux-amd64` APICTL binary automatically. This avoids mixed-architecture build-cache errors on Docker Desktop for Mac.

If Docker Desktop reports a content digest error, clean only the demo images and rebuild the two platform images separately:

```bash
docker-compose --profile platform down -v --remove-orphans
docker builder prune -af
docker image rm wso2-api-catalogue-demo-apictl wso2-api-catalogue-demo-wso2-integrator 2>/dev/null || true
docker-compose --profile platform build --no-cache apictl
docker-compose --profile platform build --no-cache wso2-integrator
docker-compose --profile platform up
```

If the Micro Integrator image build fails with a `wso2carbon` chown error, make sure `wso2-integrator/mi-runtime/Dockerfile` does not use `COPY --chown`. The demo uses plain `COPY` so the runtime can read the Synapse API XML artifacts without relying on build-time user/group resolution.
