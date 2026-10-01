FROM node:26-slim
WORKDIR /app
# The server needs only ws: install exactly the locked version, not the terminal UI's packages.
COPY package-lock.json ./
RUN node -e "const v = require('./package-lock.json').packages['node_modules/ws'].version; require('fs').writeFileSync('package.json', JSON.stringify({ private: true, type: 'module', dependencies: { ws: v } }))" \
 && npm install --omit=dev --no-audit --no-fund --no-package-lock && rm package-lock.json
COPY shared shared
COPY server server
RUN mkdir /data && chown node:node /data
USER node
ENV PORT=8787 DATA_DIR=/data
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD NODE_TLS_REJECT_UNAUTHORIZED=0 node -e "fetch('http' + (process.env.TLS_CERT ? 's' : '') + '://localhost:' + process.env.PORT + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
# node is PID 1: the server handles SIGTERM itself and shuts down cleanly.
CMD ["node", "server/server.ts"]
