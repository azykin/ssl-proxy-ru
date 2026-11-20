FROM node:24-alpine AS node

# Copy the runtime and its matching Alpine shared libraries. No shell, package
# manager, npm packages, or build tools are needed by the gateway.
FROM scratch
COPY --from=node /lib/ /lib/
COPY --from=node /usr/lib/ /usr/lib/
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY src/ ./src/
COPY certs/tbank-ca.pem ./certs/tbank-ca.pem
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
USER 1000:1000
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/node", "src/main.mjs"]
